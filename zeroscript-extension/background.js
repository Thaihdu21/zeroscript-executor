// SPDX-License-Identifier: GPL-3.0-or-later
// background.js - service worker.
// Owns the connection to the roblox-executor-mcp server (default
// http://127.0.0.1:16384 - changeable from the popup, see "Configurable
// server URL" below) that drives the user's Roblox GAME CLIENT (via an executor):
//
//   - ONE resilient WebSocket to ws://127.0.0.1:<PORT>/mcp-relay, used to
//     dispatch tool calls straight to the connected Roblox client (execute,
//     get-data-by-code, search-instances, click-button, remote-spy, ...) and
//     for list-clients / set-active-client.
//   - HTTP GET  /api/status        - heartbeat + which Roblox clients are connected.
//   - HTTP POST /api/tool          - server-side tools (script-grep, semantic
//                                    search, get-script-content via the decompiled index).
//   - HTTP POST /api/screenshot    - OS-level Roblox window screenshot (Windows).
//   - HTTP GET  /api/windows       - list visible Roblox windows.
//
// The message contract with the content script / popup is the SAME shape the
// old Python bridge used (status / list_tools / call_tool / reconnect), so
// core/main.js keeps working unchanged: every sendMessage ALWAYS gets a
// response object, even when the server is offline. The agentic loop must
// never hang waiting.

// ── Configurable server URL ────────────────────────────────────────────────
// Default: the local roblox-executor-mcp instance (same PC as the browser).
// If yours runs elsewhere (another port, another machine on your LAN, or your
// own MCP server implementing the same HTTP/WS API), change it in the popup
// ("MCP server address"): it is stored in chrome.storage.local under
// "zsServerUrl" and applied LIVE by the storage.onChanged listener at the
// bottom of this file (the relay socket reconnects immediately).
const DEFAULT_SERVER_URL = "http://127.0.0.1:16384";
let BASE = DEFAULT_SERVER_URL;
let RELAY_URL = DEFAULT_SERVER_URL.replace(/^http/, "ws") + "/mcp-relay";

// Accepts "host", "host:port", "http(s)://host[:port]" → "http(s)://host:port"
// (no trailing slash, no path). When no port is given it defaults to 16384.
function normalizeServerUrl(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (/\s/.test(s)) return null; // internal whitespace = not a real address
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    // Chromium's URL parser percent-encodes junk instead of rejecting it
    // ("not a url" becomes host "not%20a%20url"), so validate the hostname
    // ourselves: letters, digits, ".", "-", "_", ":" and "[]" (IPv6 literals
    // keep their brackets in URL.hostname) - anything else is garbage.
    if (!u.hostname || !/^[a-z0-9._:\[\]-]+$/i.test(u.hostname)) return null;
    if (!u.port) u.port = "16384";
    return `${u.protocol}//${u.host}`;
  } catch (e) {
    return null;
  }
}

function applyServerUrl(raw) {
  BASE = normalizeServerUrl(raw) || DEFAULT_SERVER_URL;
  RELAY_URL = BASE.replace(/^http/, "ws") + "/mcp-relay";
  return BASE;
}

async function loadServerUrl() {
  try {
    const r = await chrome.storage.local.get("zsServerUrl");
    if (r && r.zsServerUrl) applyServerUrl(r.zsServerUrl);
  } catch (e) {
    log("could not read stored server URL - using " + BASE, e);
  }
}

// Chat sites where a ZeroScript provider content script runs. Status pushes go
// to every tab matching these. Keep in sync with manifest.json.
const PROVIDER_URLS = ["https://chat.deepseek.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://gemini.google.com/*", "https://www.kimi.ai/*", "https://kimi.ai/*", "https://chat.z.ai/*", "https://chat.qwen.ai/*", "https://arena.ai/*", "https://www.meta.ai/*", "https://meta.ai/*"];

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
const REQUEST_TIMEOUT_DEFAULT = 130000; // a bit above the 120s tool timeout
const SEMANTIC_JOB_TIMEOUT = 180000; // semantic search runs as a progress job

let ws = null;
let connected = false; // the relay WebSocket is open (server reachable)
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}

// ── Live status of the Roblox side, mirrored from GET /api/status ──────────
// serverUp  = roblox-executor-mcp answered /api/status (it is running).
// clientUp  = at least one Roblox client (executor connector) is attached.
// clients   = display list for the popup ({username, placeName, transport}).
let serverUp = false;
let clientUp = false;
let clientsCache = [];

// The tool catalogue ZeroScript advertises. It mirrors the tools registered by
// roblox-executor-mcp (src/tools/index.ts); `server` tags every tool as the
// primary "roblox" server so main.js's scoping logic works unchanged.
function T(name, description, properties, required) {
  return {
    name,
    description,
    server: "roblox",
    inputSchema: { properties: properties || {}, ...(required ? { required } : {}) },
  };
}

const TOOLS = [
  T("list-clients",
    "List the connected Roblox game clients (executor, username, place, transport). Use before set-active-client when several clients are connected."),
  T("set-active-client",
    "Route every later command to one specific connected Roblox client.",
    { clientId: { type: "string", description: "The client ID from list-clients." } },
    ["clientId"]),
  T("get-game-info",
    "Current place/universe metadata (name, id, creator) plus the executor name/version and which functions it supports.",
    { includeDescription: { type: "boolean", description: "Include the (long) place description text. Default false." } }),
  T("execute",
    "Run Luau in the Roblox client WITHOUT waiting for output (fire-and-forget). Use get-data-by-code when you need returned values. Verify effects afterwards with get-console-output.",
    { code: { type: "string", description: "The Luau code to run." } },
    ["code"]),
  T("get-data-by-code",
    "Run Luau in the Roblox client and RETURN the values (the code must `return ...`). Prefer the specialized tools for exploration; use this only for small, targeted value probes. Also the tool behind the ###LUA### block.",
    {
      code: { type: "string", description: "Luau code that MUST return one or more values. Return raw Lua values - do NOT JSONEncode yourself." },
      timeout: { type: "number", description: "Response timeout in ms (default 15000, max 120000)." },
    },
    ["code"]),
  T("get-console-output",
    "Read the recent developer-console output of the Roblox client.",
    {
      limit: { type: "number", description: "Max log lines (default 10, max 200)." },
      logsOrder: { type: "string", description: "NewestFirst (default) or OldestFirst." },
      filter: { type: "string", description: "Only include lines containing this text." },
      summaryOnly: { type: "boolean", description: "true = counts per level instead of the lines. Default false." },
    }),
  T("search-instances",
    "Search instances with a QueryDescendants selector: class (Part), name (#HumanoidRootPart), tag (.Tagged), property ([CanCollide = false]), attribute ([$QuestId]), combinators (> >>), OR (,), :not(), :has(). Chain for AND, e.g. Part.Tagged[Anchored = false].",
    {
      selector: { type: "string", description: "QueryDescendants selector, e.g. 'Part', 'Model > Humanoid', '.Tagged'." },
      root: { type: "string", description: "Root path to search from (default 'game')." },
      limit: { type: "number", description: "Max results (default 20)." },
    },
    ["selector"]),
  T("get-descendants-tree",
    "Explore the hierarchy under an instance. Defaults to a compact summary (child/class counts); set summaryOnly=false for the real tree.",
    {
      root: { type: "string", description: "Instance path, e.g. 'game.Workspace'." },
      maxDepth: { type: "number", description: "Max depth (default 2, max 5)." },
      classFilter: { type: "string", description: "Only show instances that IsA this class." },
      maxChildren: { type: "number", description: "Max children per node (default 20, max 30)." },
      summaryOnly: { type: "boolean", description: "true (default) = compact counts. false = full tree." },
    },
    ["root"]),
  T("get-script-content",
    "Read a script's (decompiled) source by path or by getter code. Use startLine/endLine to page through long scripts.",
    {
      scriptPath: { type: "string", description: "Script path from search/grep results, or a '<ScriptProxy: id>' literal." },
      scriptGetterSource: { type: "string", description: "Alternative: code that RETURNS the script object (client-side only)." },
      startLine: { type: "number", description: "First line to show." },
      endLine: { type: "number", description: "Last line to show." },
      maxLines: { type: "number", description: "Line budget (default 80, max 2000)." },
    }),
  T("script-grep",
    "Grep across every (decompiled) script source the client has synced. Regex by default; set literal=true for plain text.",
    {
      query: { type: "string", description: "Regex (or literal text with literal=true)." },
      literal: { type: "boolean", description: "true = escape the query, no regex." },
      caseSensitive: { type: "boolean", description: "Default true." },
      limit: { type: "number", description: "Max scripts (default 10, max 100)." },
      contextLines: { type: "number", description: "Context lines around a match (default 1, max 10)." },
      maxMatchesPerScript: { type: "number", description: "Default 3, max 50." },
      maxResults: { type: "number", description: "Total match cap (default 30)." },
    },
    ["query"]),
  T("semantic-search-scripts",
    "Find scripts by BEHAVIOUR (natural language) using the semantic index. Requires the server's semantic settings to be configured; falls back with an error message otherwise. Use script-grep for exact identifiers.",
    {
      query: { type: "string", description: "What the code does, e.g. 'inventory management logic'." },
      limit: { type: "number", description: "Max results (default 5, max 50)." },
      minScore: { type: "number", description: "Optional minimum dense cosine score." },
    },
    ["query"]),
  T("remote-spy",
    "Inspect and control the Cobalt remote spy: list/clear/status, block/unblock and ignore/unignore remotes. Start with operation=list, summaryOnly=true, small limits; narrow by nameFilter before requesting call arguments.",
    {
      operation: { type: "string", description: "list | clear | status | block | unblock | ignore | unignore." },
      direction: { type: "string", description: "list: Incoming|Outgoing|Both (default Both). block/unblock/ignore/unignore: Incoming|Outgoing." },
      nameFilter: { type: "string", description: "list: case-insensitive substring filter on remote names." },
      limit: { type: "number", description: "list: max remotes (default 5, max 100)." },
      maxCallsPerRemote: { type: "number", description: "list: recent calls per remote when summaryOnly=false (default 1)." },
      summaryOnly: { type: "boolean", description: "list: names/state/counts only (default true)." },
      remoteName: { type: "string", description: "block/unblock/ignore/unignore: EXACT remote name (find it with list first)." },
    },
    ["operation"]),
  T("click-button",
    "Click a GuiButton by path (fires the signal, or a virtual mouse click when the executor lacks firesignal).",
    {
      path: { type: "string", description: "Instance path to the button." },
      action: { type: "string", description: "Optional signal: Activated, MouseButton1Click, MouseButton2Click..." },
    },
    ["path"]),
  T("type-text-box",
    "Type text into a TextBox by path (real keystrokes, or setting .Text directly with useKeyPress=false).",
    {
      path: { type: "string", description: "Instance path to the TextBox." },
      text: { type: "string", description: "The text to type." },
      enter: { type: "boolean", description: "Press Enter after typing (default false)." },
      useKeyPress: { type: "boolean", description: "true (default) = simulate keystrokes; false = set .Text." },
    },
    ["path", "text"]),
  T("screenshot-window",
    "Capture an OS-level screenshot of the Roblox window (Windows only). Returns an image you can see on vision-capable chats.",
    {
      pid: { type: "number", description: "PID from list-roblox-windows when several windows are open." },
      maxWidth: { type: "number", description: "Downscale width in px (default 1280) - lower = cheaper." },
    }),
  T("list-roblox-windows",
    "List the visible Roblox OS windows with PIDs. Use before screenshot-window when several may be open."),
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

function log(...a) {
  console.log("[zs-bg]", ...a);
}

// ── Relay WebSocket lifecycle ─────────────────────────────────────────────
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(RELAY_URL);
  } catch (e) {
    log("WebSocket ctor failed", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    reconnectDelay = RECONNECT_MIN;
    log("connected to roblox-executor-mcp relay");
    startHeartbeat();
    refreshStatus();
    broadcastStatus();
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg && msg.id !== undefined) {
      // Errors carry the message in .error (the contract main.js's error
      // paths read); successes carry the payload in .text.
      resolvePending(msg.id, msg.error !== undefined
        ? { ok: false, kind: "tool_error", error: String(msg.error) }
        : { ok: true, text: String(msg.output ?? "") });
    }
  };

  ws.onclose = () => {
    connected = false;
    stopHeartbeat();
    failAllPending("roblox-executor-mcp relay connection closed");
    scheduleReconnect();
    setTimeout(refreshStatus, 50); // re-probe so the dot flips promptly
    broadcastStatus();
  };

  ws.onerror = () => {
    // onclose will follow; nothing to do here but avoid an unhandled error.
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    // Keeps the MV3 service worker alive AND refreshes the client list.
    refreshStatus().catch(() => {});
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// Resolve once the socket is OPEN, or false after `timeout` ms.
function waitForConnection(timeout = 8000) {
  return new Promise((resolve) => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) return resolve(true);
    connect(); // nudge a (re)connection - important after a worker wake-up
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeout) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// ── request/response over the relay socket ────────────────────────────────
// `args` is spread into the message; the executor bridge routes by `type` and
// answers with { id, output | error }.
function sendRelay(type, args = {}, timeout = REQUEST_TIMEOUT_DEFAULT) {
  return new Promise((resolve) => {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, kind: "disconnected", error: "roblox-executor-mcp not connected" });
      return;
    }
    const id = "zs-" + nextId++;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ ok: false, kind: "timeout", error: "the Roblox client did not respond in time" });
      }
    }, timeout);
    pending.set(id, { resolve, timer });
    try {
      ws.send(JSON.stringify({ id, type, ...args }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, kind: "disconnected", error: String(e) });
    }
  });
}

// ── HTTP helpers (server-side tools + status) ─────────────────────────────
async function httpJson(path, init, timeout = REQUEST_TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(BASE + path, { ...init, signal: ctrl.signal });
    const data = await resp.json();
    return { ok: !data || data.error === undefined, data };
  } catch (e) {
    return { ok: false, kind: "disconnected", error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(t);
  }
}

// GET /api/status - heartbeat + connected client list.
async function refreshStatus() {
  const r = await httpJson("/api/status", { method: "GET" }, 8000);
  const wasUp = serverUp;
  const wasClientUp = clientUp;
  if (r.ok && r.data && typeof r.data === "object") {
    serverUp = true;
    const cl = Array.isArray(r.data.clients) ? r.data.clients : [];
    clientsCache = cl.map((c) => ({
      clientId: c.clientId,
      username: c.username,
      placeName: c.placeName,
      transport: c.transport,
    }));
    clientUp = cl.length > 0;
  } else {
    serverUp = false;
    clientUp = false;
    clientsCache = [];
  }
  if (serverUp !== wasUp || clientUp !== wasClientUp) broadcastStatus();
  else broadcastStatus(); // cheap: popup filters duplicates, tabs dedupe by signature
}

// Poll a semantic-search progress job until done/failed.
async function waitForProgressJob(progressUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await httpJson(progressUrl, { method: "GET" }, 10000);
    if (!r.ok) return { ok: false, kind: "disconnected", error: r.error || "progress poll failed" };
    const job = r.data || {};
    if (job.status === "done") return { ok: true, text: String(job.result ?? "Done.") };
    if (job.status === "failed") return { ok: false, kind: "tool_error", error: `Failed: ${job.error || "unknown error"}` };
  }
  return { ok: false, kind: "timeout", error: "semantic search timed out" };
}

// ── Tool dispatch ─────────────────────────────────────────────────────────
// Maps a ZeroScript command (name + arguments) onto the right transport:
//   - WS relay   : client-side tools (run inside the Roblox client)
//   - POST /api/tool   : server-side tools (decompiled script index, semantic)
//   - /api/screenshot + /api/windows : OS-level window tools
async function callTool(name, args, timeout) {
  args = args || {};
  const tm = timeout || 120000;

  switch (name) {
    // ── server-side (HTTP) tools ──────────────────────────────────────────
    case "script-grep": {
      const r = await httpJson("/api/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "script-grep", ...args }),
      }, tm);
      if (!r.ok) return { ok: false, kind: r.kind || "tool_error", error: (r.data && r.data.error) || r.error };
      return { ok: true, text: String(r.data.result ?? "") };
    }
    case "get-script-content": {
      const r = await httpJson("/api/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get-script-content", ...args }),
      }, tm);
      if (!r.ok) return { ok: false, kind: r.kind || "tool_error", error: (r.data && r.data.error) || r.error };
      return { ok: true, text: String(r.data.result ?? "") };
    }
    case "semantic-search-scripts": {
      const r = await httpJson("/api/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "semantic-search",
          query: args.query,
          limit: args.limit,
          minScore: args.minScore,
        }),
      }, 30000);
      if (!r.ok) return { ok: false, kind: r.kind || "tool_error", error: (r.data && r.data.error) || r.error };
      const d = r.data || {};
      if (d.error) return { ok: false, kind: "tool_error", error: String(d.error) };
      if (d.result !== undefined) return { ok: true, text: String(d.result) };
      if (d.jobId && d.progressUrl) return waitForProgressJob(d.progressUrl, SEMANTIC_JOB_TIMEOUT);
      return { ok: true, text: JSON.stringify(d) };
    }
    case "list-roblox-windows": {
      const r = await httpJson("/api/windows", { method: "GET" }, 15000);
      if (!r.ok) return { ok: false, kind: r.kind || "tool_error", error: (r.data && r.data.error) || r.error };
      const wins = (r.data && r.data.windows) || [];
      return {
        ok: true,
        text: wins.length
          ? wins.map((w) => `PID ${w.pid} — "${w.title}"`).join("\n")
          : "No visible Roblox windows found.",
      };
    }
    case "screenshot-window": {
      const r = await httpJson("/api/screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: args.pid, maxWidth: args.maxWidth }),
      }, 30000);
      const d = r.data || {};
      if (!r.ok) return { ok: false, kind: r.kind || "tool_error", error: d.error || r.error };
      if (d.error) return { ok: false, kind: "tool_error", error: String(d.error) };
      if (d.needsDisambiguation) {
        const wins = d.windows || [];
        return {
          ok: false,
          kind: "tool_error",
          error: "Several Roblox windows are open - pass the pid. Available windows:\n" +
            wins.map((w) => `  PID ${w.pid} — "${w.title}"`).join("\n"),
        };
      }
      if (d.imageBase64) {
        return {
          ok: true,
          text: "Screenshot captured (see the image).",
          images: [`data:${d.mimeType || "image/jpeg"};base64,${d.imageBase64}`],
        };
      }
      return { ok: false, kind: "tool_error", error: "Screenshot returned no image." };
    }

    // ── relay-level commands ──────────────────────────────────────────────
    case "list-clients": {
      const r = await sendRelay("list-clients", {}, 15000);
      if (!r.ok && r.kind === "disconnected") return r;
      return r;
    }
    case "set-active-client": {
      if (!args.clientId) return { ok: false, kind: "tool_error", error: "clientId is required (get it from list-clients)." };
      const r = await sendRelay("set-active-client", { targetClientId: args.clientId }, 15000);
      if (!r.ok && r.kind === "disconnected") return r;
      return r;
    }

    // ── client-side tools over the relay ──────────────────────────────────
    case "execute": {
      // Fire-and-forget: the connector runs the code in a detached thread and
      // never answers, so don't wait - mirror the MCP server's own behavior.
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
        return { ok: false, kind: "disconnected", error: "roblox-executor-mcp not connected" };
      }
      if (!args.code) return { ok: false, kind: "tool_error", error: "code is required." };
      try {
        ws.send(JSON.stringify({ id: "zs-" + nextId++, type: "execute", source: args.code, threadContext: 8 }));
      } catch (e) {
        return { ok: false, kind: "disconnected", error: String(e) };
      }
      return { ok: true, text: "Code scheduled for execution (no output returned - use get-data-by-code when you need values, get-console-output to verify)." };
    }
    case "get-data-by-code": {
      if (!args.code) return { ok: false, kind: "tool_error", error: "code is required." };
      const wait = Math.min(Math.max(Number(args.timeout) || 15000, 1000), 120000) + 10000;
      const r = await sendRelay("get-data-by-code", { source: args.code, threadContext: 8 }, wait);
      if (r.ok && (!r.text || r.text === "")) return { ok: true, text: "(no output - the code returned nothing; use `return ...` to produce output)" };
      return r;
    }
    case "get-console-output":
      return sendRelay("get-console-output", {
        limit: args.limit, logsOrder: args.logsOrder, filter: args.filter, summaryOnly: args.summaryOnly,
      }, tm);
    case "search-instances":
      return sendRelay("search-instances", {
        selector: args.selector, root: args.root, limit: args.limit,
      }, tm);
    case "get-descendants-tree":
      return sendRelay("get-descendants-tree", {
        root: args.root, maxDepth: args.maxDepth, classFilter: args.classFilter,
        maxChildren: args.maxChildren, summaryOnly: args.summaryOnly,
      }, tm);
    case "get-game-info":
      return sendRelay("get-game-info", { includeDescription: args.includeDescription === true }, tm);
    case "remote-spy":
      return sendRelay("remote-spy", {
        operation: args.operation, direction: args.direction, nameFilter: args.nameFilter,
        limit: args.limit, maxCallsPerRemote: args.maxCallsPerRemote, summaryOnly: args.summaryOnly,
        remoteName: args.remoteName,
      }, tm);
    case "click-button":
      return sendRelay("click-button", { path: args.path, action: args.action }, tm);
    case "type-text-box":
      return sendRelay("type-text-box", {
        path: args.path, text: args.text, string: args.text,
        enter: args.enter, useKeyPress: args.useKeyPress,
      }, tm);

    default:
      return { ok: false, kind: "unknown_tool", error: `unknown tool '${name}'` };
  }
}

function resolvePending(id, value) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(value);
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, kind: "disconnected", error: reason });
  }
  pending.clear();
}

// ── status push to any open provider tab + popup ──────────────────────────
// Keys deliberately keep the OLD bridge field names (connected/studio/...) so
// core/main.js and popup.js status logic keeps working; semantics:
//   connected     = roblox-executor-mcp server reachable
//   studio        = a Roblox client (executor) is attached
//   studioApp     = same as studio here (no separate "place" concept)
//   studioProc    = null (not applicable)
function statusObj() {
  return {
    type: "zs-status",
    connected: serverUp,
    mcpAlive: serverUp,
    studio: serverUp ? clientUp : null,
    studioApp: serverUp ? clientUp : null,
    studioProc: null,
    tools: serverUp ? TOOLS.length : 0,
    servers: serverUp ? [{ id: "roblox", alive: true, tools: TOOLS.length }] : [],
    clients: clientsCache,
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage(statusObj()).catch(() => {});
  chrome.tabs.query({ url: PROVIDER_URLS }, (tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, statusObj()).catch(() => {});
  });
}

// ── messages from content.js / popup.js ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "status":
        await refreshStatus();
        sendResponse(statusObj());
        break;
      case "list_tools":
        // Catalogue is local (the HTTP API has no tools/list route). Refresh
        // the server status too so a dead server is still surfaced by "status".
        refreshStatus().catch(() => {});
        sendResponse({ ok: serverUp, tools: TOOLS });
        break;
      case "call_tool": {
        if (!TOOL_NAMES.has(msg.name)) {
          sendResponse({ ok: false, kind: "unknown_tool", error: `unknown tool '${msg.name}'` });
          break;
        }
        // Make sure the relay socket is up (worker may have been suspended).
        await waitForConnection(6000).catch(() => {});
        const timeout = (msg.timeout || 120000) + 10000;
        const r = await callTool(msg.name, msg.arguments, timeout);
        sendResponse(r);
        break;
      }
      case "reconnect":
        reconnectDelay = RECONNECT_MIN;
        serverUp = false;
        clientUp = false;
        connect();
        await refreshStatus();
        sendResponse({ ok: true });
        break;
      case "restart_mcp":
        // The old bridge restarted its MCP child processes. roblox-executor-mcp
        // manages its own lifetime (npm start / install:harnesses); there is
        // nothing to restart from here - just re-probe.
        await refreshStatus();
        sendResponse({ ok: serverUp, error: serverUp ? undefined : "roblox-executor-mcp is not reachable - start it with 'npm start' (see roblox-executor-mcp/README.md)." });
        break;
      case "get_config":
        sendResponse({ ok: true, serverUrl: BASE, defaultServerUrl: DEFAULT_SERVER_URL, custom: BASE !== DEFAULT_SERVER_URL });
        break;
      case "set_config": {
        const norm = normalizeServerUrl(msg.serverUrl);
        if (!norm) {
          sendResponse({ ok: false, error: "Invalid server URL. Examples: 127.0.0.1:16384, http://192.168.1.5:16384" });
          break;
        }
        try {
          await chrome.storage.local.set({ zsServerUrl: norm });
          sendResponse({ ok: true, serverUrl: norm });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "reset_config":
        try {
          await chrome.storage.local.remove("zsServerUrl");
          sendResponse({ ok: true, serverUrl: DEFAULT_SERVER_URL });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      case "add_server":
      case "remove_server":
        // Custom MCP addon servers were a Python-bridge feature. The merged
        // build runs exactly one backend - but its ADDRESS is the user's to
        // set: the popup's "MCP server address" field (set_config above)
        // points ZeroScript at any roblox-executor-mcp instance.
        sendResponse({ ok: false, error: "not supported: use the popup's 'MCP server address' field to point ZeroScript at your own server" });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async sendResponse
});

// Wake/keepalive hooks.
chrome.runtime.onStartup.addListener(() => { connect(); refreshStatus(); });
chrome.runtime.onInstalled.addListener(() => { connect(); refreshStatus(); });

// Live-apply a server address change made in the popup: swap BASE/RELAY_URL,
// tear the old relay socket down (nulling onclose first so it cannot schedule
// a reconnect to the OLD address) and reconnect to the new one right away.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.zsServerUrl) return;
    applyServerUrl(changes.zsServerUrl.newValue);
    log("server address changed ->", BASE);
    reconnectDelay = RECONNECT_MIN;
    serverUp = false;
    clientUp = false;
    clientsCache = [];
    stopHeartbeat();
    if (ws) { const old = ws; ws = null; try { old.onclose = null; old.close(); } catch {} }
    connected = false;
    failAllPending("server address changed - reconnecting");
    connect();
    refreshStatus();
    broadcastStatus();
  });
} catch (e) { /* storage API unavailable */ }

// Boot: apply any stored custom address first, then connect.
(async () => {
  await loadServerUrl();
  connect();
  refreshStatus();
})();
