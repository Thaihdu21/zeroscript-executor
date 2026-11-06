// Quick Node smoke test for background.js (run: node test-background.js). Not shipped.
// Stubs the chrome.* APIs, WebSocket and fetch, then drives the tool routing:
// relay tools go out over the fake WS with the right payload shape, HTTP tools
// hit the right endpoints, and every message answers in the background's
// promise contract ({ ok, text } | { ok:false, kind, error }).
const fs = require("fs");
const path = require("path");
const assert = require("assert");

// ── Stubs ──────────────────────────────────────────────────────────────────
const listeners = { runtime: [] };
const storageData = {};
const storageListeners = [];
function notifyStorage(obj, removed) {
  const changes = {};
  for (const [k, v] of Object.entries(obj)) {
    changes[k] = removed ? { oldValue: v, newValue: undefined } : { oldValue: storageData[k], newValue: v };
  }
  for (const fn of storageListeners) fn(changes, "local");
}
global.chrome = {
  runtime: {
    getManifest: () => ({ version: "2.1.0" }),
    onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
    onStartup: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    sendMessage: async () => {},
  },
  tabs: {
    query: (_q, cb) => cb([]),
    sendMessage: () => {},
  },
  storage: {
    local: {
      get: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) if (k in storageData) out[k] = storageData[k];
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) storageData[k] = v;
        notifyStorage(obj, false);
      },
      remove: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        const had = {};
        for (const k of ks) if (k in storageData) { had[k] = storageData[k]; delete storageData[k]; }
        if (Object.keys(had).length) notifyStorage(had, true);
      },
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  },
};

// Fake WebSocket: records sent frames, lets the test push responses.
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; FakeWS.log.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
  open() { this.onopen && this.onopen(); }
  reply(msg) { this.onmessage && this.onmessage({ data: JSON.stringify(msg) }); }
}
FakeWS.log = [];
FakeWS.OPEN = 1; FakeWS.CONNECTING = 0;
global.WebSocket = FakeWS;

const httpCalls = [];
global.fetch = async (url, init) => {
  httpCalls.push({ url: String(url), init });
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (url.endsWith("/api/status")) {
    return { json: async () => ({ connected: true, clientCount: 1, clients: [{ clientId: "c1", username: "tester", placeName: "Doors", transport: "ws" }] }) };
  }
  if (url.endsWith("/api/tool")) {
    if (body.type === "script-grep") return { json: async () => ({ result: "3 match(es) across 2 script(s)" }) };
    if (body.type === "get-script-content") return { json: async () => ({ result: "-- Lines 1-3 of 3\nlocal x = 1" }) };
    if (body.type === "semantic-search") return { json: async () => ({ jobId: "j1", progressUrl: "/api/tool-progress?id=j1" }) };
    return { json: async () => ({ error: "Unknown tool type" }) };
  }
  if (url.includes("/api/tool-progress")) {
    return { json: async () => ({ status: "done", result: "1 semantic match for \"x\"" }) };
  }
  if (url.endsWith("/api/windows")) {
    return { json: async () => ({ windows: [{ pid: 123, title: "Roblox" }] }) };
  }
  if (url.endsWith("/api/screenshot")) {
    return { json: async () => ({ imageBase64: "QUJD", mimeType: "image/jpeg" }) };
  }
  return { json: async () => ({}) };
};

// ── Load the service worker source ─────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
new Function(src)(); // everything happens through the chrome.onMessage hook

const ok = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) process.exitCode = 1; };

const onMessage = listeners.runtime[0];
assert(onMessage, "runtime.onMessage listener registered");
function call(msg) {
  return new Promise((resolve) => onMessage(msg, {}, resolve));
}
// Fire a relay tool call, let the handler actually SEND the frame, push the
// canned reply, then await the resolved result.
async function relayCall(msg, reply) {
  const p = call(msg);
  await new Promise((r) => setTimeout(r, 10)); // flush microtasks until sendRelay
  const sent = sock.sent[sock.sent.length - 1];
  if (reply) sock.reply({ id: sent.id, ...reply });
  return { r: await p, sent };
}

let sock;
(async () => {
  // The worker boots asynchronously now (loadServerUrl → connect), so give
  // its microtasks a tick to run before grabbing the socket.
  await new Promise((r) => setTimeout(r, 10));
  sock = FakeWS.log[0];
  ok("relay websocket opened", sock && sock.url === "ws://127.0.0.1:16384/mcp-relay");
  sock.open();
  await new Promise((r) => setTimeout(r, 30)); // let refreshStatus() settle

  // ── status reflects /api/status ─────────────────────────────────────────
  const st = await call({ type: "status" });
  ok("status: server connected", st.connected === true);
  ok("status: client attached", st.studio === true && st.studioApp === true);
  ok("status: one roblox server with 16 tools", Array.isArray(st.servers) && st.servers.length === 1 && st.servers[0].id === "roblox" && st.servers[0].tools === 16);
  ok("status: clients list carried", Array.isArray(st.clients) && st.clients[0].username === "tester");

  // ── list_tools returns the catalogue ────────────────────────────────────
  const lt = await call({ type: "list_tools" });
  const names = lt.tools.map((t) => t.name);
  ok("list_tools: 16 tools", lt.tools.length === 16);
  ok("list_tools: server field set", lt.tools.every((t) => t.server === "roblox"));
  ok("list_tools: executor names present",
    ["get-data-by-code", "execute", "script-grep", "remote-spy", "click-button", "screenshot-window"].every((n) => names.includes(n)));
  ok("list_tools: no Studio names left",
    !["execute_luau", "multi_edit", "script_read", "screen_capture"].some((n) => names.includes(n)));

  // ── relay tools: payload shapes and results ─────────────────────────────
  let { r, sent } = await relayCall(
    { type: "call_tool", name: "get-data-by-code", arguments: { code: "return 1+1" }, timeout: 20000 },
    { output: "2" });
  ok("get-data-by-code over relay", sent.type === "get-data-by-code" && sent.source === "return 1+1");
  ok("get-data-by-code result", r.ok === true && r.text === "2");

  r = await call({ type: "call_tool", name: "execute", arguments: { code: 'print("hi")' } });
  const sent2 = sock.sent[sock.sent.length - 1];
  ok("execute is fire-and-forget", sent2.type === "execute" && sent2.source === 'print("hi")' && r.ok === true && /scheduled/i.test(r.text));

  ({ r, sent } = await relayCall(
    { type: "call_tool", name: "set-active-client", arguments: { clientId: "c1" } },
    { output: "Active client set to c1" }));
  ok("set-active-client payload", sent.type === "set-active-client" && sent.targetClientId === "c1");
  ok("set-active-client result", r.ok === true && /Active client set/.test(r.text));

  ({ r, sent } = await relayCall(
    { type: "call_tool", name: "search-instances", arguments: { selector: "Part", root: "game.Workspace", limit: 5 } },
    { error: "No active Roblox client connected." }));
  ok("search-instances payload", sent.type === "search-instances" && sent.selector === "Part" && sent.limit === 5);
  ok("relay error surfaces as tool error", r.ok === false && /No active Roblox client/.test(r.error));

  ({ r, sent } = await relayCall(
    { type: "call_tool", name: "remote-spy", arguments: { operation: "list", summaryOnly: true } },
    { output: "3 remotes" }));
  ok("remote-spy payload", sent.type === "remote-spy" && sent.operation === "list");
  ok("remote-spy result", r.ok === true && r.text === "3 remotes");

  ({ r, sent } = await relayCall(
    { type: "call_tool", name: "type-text-box", arguments: { path: "game.Players.LocalPlayer.PlayerGui.S.Box", text: "hello" } },
    { output: "Successfully typed into TextBox." }));
  ok("type-text-box payload", sent.type === "type-text-box" && sent.path.endsWith("Box") && sent.text === "hello" && sent.string === "hello");
  ok("type-text-box result", r.ok === true);

  // ── HTTP tools: endpoints ───────────────────────────────────────────────
  r = await call({ type: "call_tool", name: "script-grep", arguments: { query: "RemoteEvent" } });
  const g = httpCalls.find((c) => c.url.endsWith("/api/tool") && c.init.body.includes("script-grep"));
  ok("script-grep via /api/tool", !!g && r.ok === true && r.text === "3 match(es) across 2 script(s)");

  r = await call({ type: "call_tool", name: "get-script-content", arguments: { scriptPath: "game.ReplicatedStorage.Foo" } });
  ok("get-script-content via /api/tool", r.ok === true && r.text.startsWith("-- Lines 1-3"));

  r = await call({ type: "call_tool", name: "semantic-search-scripts", arguments: { query: "inventory logic" } });
  const job = httpCalls.find((c) => c.url.includes("/api/tool-progress"));
  ok("semantic-search polls progress job", !!job && r.ok === true && /semantic match/.test(r.text));

  r = await call({ type: "call_tool", name: "list-roblox-windows", arguments: {} });
  ok("list-roblox-windows via /api/windows", r.ok === true && r.text.includes("PID 123"));

  r = await call({ type: "call_tool", name: "screenshot-window", arguments: {} });
  ok("screenshot-window returns a data-url image", r.ok === true && Array.isArray(r.images) && r.images[0].startsWith("data:image/jpeg;base64,QUJD"));

  // ── error kinds ─────────────────────────────────────────────────────────
  r = await call({ type: "call_tool", name: "subagent", arguments: {} });
  ok("unknown tool rejected", r.ok === false && r.kind === "unknown_tool");

  r = await call({ type: "add_server", server_id: "x", command: "y" });
  ok("add_server refused (single backend)", r.ok === false);

  // ── reconnect resets and re-probes ──────────────────────────────────────
  r = await call({ type: "reconnect" });
  ok("reconnect ok", r.ok === true);

  // ── configurable server address ────────────────────────────────
  let cfg = await call({ type: "get_config" });
  ok("config: default address", cfg.ok === true && cfg.serverUrl === "http://127.0.0.1:16384" && cfg.custom === false);

  cfg = await call({ type: "set_config", serverUrl: "192.168.1.50:17000" });
  ok("config: set normalizes host:port", cfg.ok === true && cfg.serverUrl === "http://192.168.1.50:17000");
  await new Promise((r) => setTimeout(r, 30)); // let the storage change reconnect
  const sock2 = FakeWS.log[FakeWS.log.length - 1];
  ok("config: relay reconnected to the new address", sock2 && sock2.url === "ws://192.168.1.50:17000/mcp-relay");
  const probe = httpCalls.filter((c) => c.url.endsWith("/api/status")).pop();
  ok("config: status probes the new address", !!probe && probe.url.startsWith("http://192.168.1.50:17000/api/status"));
  const st2 = await call({ type: "status" });
  ok("config: status still works after the swap", st2.connected === true);

  cfg = await call({ type: "set_config", serverUrl: "not a url at all:" });
  ok("config: invalid address rejected", cfg.ok === false);
  cfg = await call({ type: "set_config", serverUrl: "still the right server: http://127.0.0.1:16384" });
  ok("config: whitespace garbage rejected", cfg.ok === false);
  cfg = await call({ type: "set_config", serverUrl: "http://[::1]:16384" });
  ok("config: IPv6 loopback accepted", cfg.ok === true && cfg.serverUrl === "http://[::1]:16384");

  cfg = await call({ type: "set_config", serverUrl: "http://myserver.local/" });
  ok("config: path stripped + default port added", cfg.ok === true && cfg.serverUrl === "http://myserver.local:16384");

  cfg = await call({ type: "reset_config" });
  ok("config: reset returns the default", cfg.ok === true && cfg.serverUrl === "http://127.0.0.1:16384");
  await new Promise((r) => setTimeout(r, 30));
  const sock3 = FakeWS.log[FakeWS.log.length - 1];
  ok("config: relay back on the default address", sock3 && sock3.url === "ws://127.0.0.1:16384/mcp-relay");
  const st3 = await call({ type: "get_config" });
  ok("config: get_config reflects the default", st3.ok === true && st3.serverUrl === "http://127.0.0.1:16384" && st3.custom === false);

  console.log("\nbackground.js smoke test done.");
  // The worker's heartbeat interval would keep the Node event loop alive.
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
