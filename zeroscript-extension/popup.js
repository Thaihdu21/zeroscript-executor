// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/sebattfg";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com", "deepseek.com", "chatgpt.com", "chat.openai.com",
  "gemini.google.com", "www.kimi.ai", "kimi.ai",
  "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai", "meta.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

function render(s) {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  const tools = document.getElementById("tools");
  const servers = document.getElementById("servers");
  const list = s.servers || [];
  const up = list.filter((x) => x.alive).length;
  const mcpOk = s.connected && (s.mcpAlive || up > 0 || s.tools > 0);
  // "studio" (kept from the old bridge contract) = a Roblox client is attached.
  const clientOff = mcpOk && s.studio === false; // server up but no client attached
  const ok = mcpOk && !clientOff;
  dot.className = "dot " + (s.connected ? (ok ? "on" : "warn") : "");
  state.textContent = s.connected
    ? (ok ? "Connected · Roblox client ready"
        : clientOff ? "Server OK · no Roblox client connected"
        : "Server OK · waiting for a client")
    : "MCP server offline";
  tools.textContent = s.connected ? `${s.tools || 0} tools available` : "Start roblox-executor-mcp";
  // Connected Roblox clients (username @ place), when the status carries them.
  const clients = Array.isArray(s.clients) ? s.clients : [];
  servers.textContent = s.connected
    ? (clients.length
        ? clients.map((c) => `● ${c.username || "client"} @ ${c.placeName || "?"} (${c.transport || "?"})`).join("\n")
        : "○ no Roblox client - run the connector in your executor")
    : "";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => s && render(s));
}

document.getElementById("reconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnect" }, () => setTimeout(refresh, 600));
});
document.getElementById("kofi").addEventListener("click", () => {
  chrome.tabs.create({ url: KOFI_URL });
});
document.getElementById("settings").addEventListener("click", () => {
  // Same mechanism as the Ko-fi button (chrome.tabs), but tries the in-page
  // panel on an already-open supported AI tab first, so opening it doesn't
  // require a conversation to already be started there.
  chrome.tabs.query({}, (tabs) => {
    const active = tabs.find((t) => t.active && t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    const anySupported = active || tabs.find((t) => t.url && SUPPORTED_HOSTS.some((h) => t.url.includes(h)));
    if (anySupported) {
      chrome.tabs.sendMessage(anySupported.id, { type: "zs-open-menu" });
      chrome.tabs.update(anySupported.id, { active: true });
    } else {
      chrome.tabs.create({ url: DEFAULT_AI_URL });
    }
  });
});

// ── MCP server address (change it when the default doesn't match) ─────────
// The default http://127.0.0.1:16384 covers the normal case (server on the
// same PC). Point it somewhere else - another port, another machine on your
// LAN, or your own MCP server implementing the same HTTP/WS API - and the
// background worker reconnects immediately (the value lives in
// chrome.storage.local under "zsServerUrl").
const serverInput = document.getElementById("server-url");
const saveBtn = document.getElementById("server-save");
const resetBtn = document.getElementById("server-reset");
const cfgState = document.getElementById("cfg-state");

function isLocalhostHost(h) {
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

// "host[:port]" | "http(s)://host[:port]" → the origin patterns Chrome needs
// permission for (http+ws, or https+wss). Port defaults to 16384.
function originPatternsFor(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (/\s/.test(s)) return null; // internal whitespace = not a real address
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  // Chromium's URL parser percent-encodes junk instead of rejecting it
  // ("not a url" becomes host "not%20a%20url"), so validate the hostname
  // ourselves - same rule as background.js normalizeServerUrl ("[]" because
  // IPv6 literals keep their brackets in URL.hostname).
  if (!u.hostname || !/^[a-z0-9._:\[\]-]+$/i.test(u.hostname)) return null;
  if (!u.port) u.port = "16384";
  const httpP = u.protocol === "https:" ? "https" : "http";
  const wsP = u.protocol === "https:" ? "wss" : "ws";
  return [`${httpP}://${u.host}/*`, `${wsP}://${u.host}/*`];
}

function doSave(raw) {
  chrome.runtime.sendMessage({ type: "set_config", serverUrl: raw }, (r) => {
    if (r && r.ok) {
      serverInput.value = r.serverUrl; // show the NORMALIZED address
      cfgState.textContent = "Saved → " + r.serverUrl + " · testing…";
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "status" }, (s) => {
          cfgState.textContent = s && s.connected
            ? "Saved → " + r.serverUrl + " · server reachable ✓"
            : "Saved → " + r.serverUrl + " · no answer (is the server running?)";
        });
      }, 1500);
    } else {
      cfgState.textContent = (r && r.error) || "Save failed";
    }
  });
}

saveBtn.addEventListener("click", () => {
  const raw = serverInput.value.trim();
  const patterns = originPatternsFor(raw);
  if (!patterns) {
    cfgState.textContent = "Invalid address — e.g. 192.168.1.5:16384 or http://localhost:16384";
    return;
  }
  let host = "";
  try { host = new URL(patterns[0]).hostname; } catch {}
  if (isLocalhostHost(host)) { doSave(raw); return; }
  // Non-localhost address: needs a host permission (optional_host_permissions
  // in the manifest). Request it synchronously inside this click gesture -
  // awaiting first can consume the user activation and kill the prompt.
  if (!chrome.permissions || !chrome.permissions.request) { doSave(raw); return; }
  chrome.permissions.request({ origins: patterns }, (granted) => {
    if (chrome.runtime.lastError) { cfgState.textContent = chrome.runtime.lastError.message; return; }
    if (!granted) { cfgState.textContent = "Permission denied for " + host; return; }
    doSave(raw);
  });
});

resetBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reset_config" }, (r) => {
    if (r && r.ok) {
      serverInput.value = r.serverUrl;
      cfgState.textContent = "Reset → " + r.serverUrl;
    }
  });
});

// Fill the field with the address currently in use.
chrome.runtime.sendMessage({ type: "get_config" }, (c) => {
  if (c && c.ok) serverInput.value = c.serverUrl;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "zs-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
