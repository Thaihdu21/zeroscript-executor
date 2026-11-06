#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLoaderSnippet, SERVER_PORT } from "../src/shared/connector-snippet.mjs";
import { getAutoexecStatus } from "../src/shared/autoexec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const useDist = args.includes("--dist");
const host = readArg("--host") || process.env.HOST || "127.0.0.1";
const port = Number(readArg("--port") || readArg("-p") || process.env.PORT || 18765);
const assetsDir = path.join(repoRoot, useDist ? "dist/http/assets/dashboard" : "src/http/assets/dashboard");
const startedAt = Date.now();

const lanIp = getLocalLanIp() || "10.0.0.4";
const tailscaleIp = process.env.MOCK_TAILSCALE_IP || "100.106.204.90";
const mockHarnesses = [
  { id: "codex", name: "Codex", group: "Recommended", detected: true, reason: "command codex" },
  { id: "cursor", name: "Cursor", group: "Recommended", detected: true, reason: "/Applications/Cursor.app" },
];

const mockSources = new Map([
  [
    "workspace-controller",
    `local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")

local Controller = {}

function Controller.spawnPart(name)
    local part = Instance.new("Part")
    part.Name = name or "MockPart"
    part.Parent = Workspace
    return part
end

return Controller
`,
  ],
  [
    "workspace-controller-child",
    `local Controller = require(script.Parent)

return function()
    return Controller.spawnPart("ChildPart")
end
`,
  ],
  [
    "ui-bootstrap",
    `local Players = game:GetService("Players")
local player = Players.LocalPlayer

print("Bootstrapping UI for", player and player.Name)
`,
  ],
  [
    "remote-events",
    `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Remotes = ReplicatedStorage:WaitForChild("Remotes")

Remotes.UseItem.OnClientEvent:Connect(function(itemName)
    print("Using package item", itemName)
end)
`,
  ],
]);

let mockScripts = [
  makeScript("workspace-controller", "Workspace.Controllers.PlayerController", true),
  makeScript("workspace-controller-child", "Workspace.Controllers.PlayerController.Child", false),
  makeScript("ui-bootstrap", "StarterPlayer.StarterPlayerScripts.UIBootstrap", true),
  makeScript("remote-events", "ReplicatedStorage.Packages.Inventory.Remotes", false),
];

const mockClients = [
  {
    clientId: "mock-client-1",
    username: "MockPlayer",
    userId: 0,
    placeName: "Dashboard Dev Place",
    placeId: "123456789",
    jobId: "mock-job-001",
    transport: "ws",
    scriptSync: {
      mappedSources: mockScripts.length,
      processedSources: mockScripts.length,
      skippedSources: 0,
      sourcesToMap: mockScripts.length,
      hasFinishedMapping: true,
    },
    semanticIndex: {
      embeddedChunks: 6,
      chunkCount: 8,
    },
  },
  {
    clientId: "mock-client-2",
    username: "HttpTester",
    userId: 0,
    placeName: "Polling Test Place",
    placeId: "987654321",
    jobId: "mock-job-002",
    transport: "http",
    scriptSync: {
      mappedSources: 1,
      processedSources: 1,
      skippedSources: 0,
      sourcesToMap: 3,
      hasFinishedMapping: false,
    },
    semanticIndex: {
      embeddedChunks: 0,
      chunkCount: 0,
    },
  },
];

let mockSettings = {
  enabled: true,
  provider: "openai",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiModel: "text-embedding-3-small",
  openaiApiKey: "",
  openaiApiKeySet: false,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",
  saveEmbeddingsToDisk: true,
};

let mockDashboardSettingsPersisted = false;
let mockDashboardSettings = {
  version: 1,
  theme: "default",
  colors: {
    background: "#0a0a0a",
    surface: "#111111",
    raised: "#171717",
    border: "#262626",
    accent: "#3b82f6",
    text: "#ededed",
    muted: "#a1a1a1",
  },
  fonts: {
    sans: "geist",
    mono: "geist-mono",
    customSans: "",
    customMono: "",
  },
  backgroundMedia: {
    type: "none",
    url: "",
    fit: "cover",
    opacity: 0.35,
  },
};

let mockOracleApiKey = "";
const MOCK_SHINY_HOSTED_ENDPOINT = "https://medal.upio.dev/decompile";
const MOCK_SHINY_LOCAL_ENDPOINT = "http://localhost:3000/luau/decompile";
const MOCK_PROVIDER_TIMEOUTS_MS = {
  builtin: 8000,
  luaexpert: 10000,
  shiny: 6000,
  oracle: 15000,
  konstant: 10000,
  fission: 6000,
};
const MOCK_DECOMPILER_RUNTIME = {
  adaptiveFallback: true,
  loadBalanceSlowProviders: true,
  overallTimeoutMs: 12000,
  slowAfterMs: 6000,
  cooldownMs: 60000,
  slowSuccessLimit: 3,
  timeoutLimit: 2,
  providerTimeoutsMs: MOCK_PROVIDER_TIMEOUTS_MS,
};
let mockDecompilerSettings = {
  providerOrder: ["builtin", "luaexpert", "shiny", "oracle", "konstant", "fission"],
  providers: {
    builtin: {
      enabled: true,
      endpoint: "",
      version: null,
      options: {},
      apiKeySet: false,
      apiKeyMasked: "",
    },
    luaexpert: {
      enabled: true,
      endpoint: "https://api.lua.expert/decompile",
      version: null,
      options: {},
      apiKeySet: false,
      apiKeyMasked: "",
    },
    shiny: {
      enabled: true,
      endpoint: MOCK_SHINY_HOSTED_ENDPOINT,
      version: null,
      options: { mode: "hosted" },
      apiKeySet: false,
      apiKeyMasked: "",
    },
    oracle: {
      enabled: false,
      endpoint: "https://oracle.mshq.dev/decompile",
      version: null,
      options: {},
      apiKeySet: false,
      apiKeyMasked: "",
    },
    konstant: {
      enabled: true,
      endpoint: "http://api.plusgiant5.com/konstant/decompile",
      version: null,
      options: {},
      apiKeySet: false,
      apiKeyMasked: "",
    },
    fission: {
      enabled: false,
      endpoint: "http://localhost:3001/luau/decompile",
      version: null,
      options: {},
      apiKeySet: false,
      apiKeyMasked: "",
    },
  },
  providerInfo: [
    { id: "builtin", label: "Built-in", local: true, requiresApiKey: false },
    { id: "luaexpert", label: "lua.expert", local: false, requiresApiKey: false },
    { id: "shiny", label: "Shiny", local: false, requiresApiKey: false },
    { id: "oracle", label: "Oracle", local: false, requiresApiKey: true },
    { id: "konstant", label: "Konstant", local: false, requiresApiKey: false },
    { id: "fission", label: "Fission", local: true, requiresApiKey: false },
  ],
  runtime: MOCK_DECOMPILER_RUNTIME,
};
let mockDecompilerInstalls = {
  shiny: false,
  fission: false,
};

function cloneMockDecompilerSettings() {
  return JSON.parse(JSON.stringify(mockDecompilerSettings));
}

function isMockCustomDecompilerProviderId(id) {
  return typeof id === "string" && /^custom:[a-zA-Z0-9_-]{1,80}$/.test(id);
}

function ensureMockCustomDecompilerProvider(settings, id) {
  if (!isMockCustomDecompilerProviderId(id) || settings.providers[id]) return;
  settings.providers[id] = {
    enabled: false,
    endpoint: "",
    version: null,
    options: { name: "Custom" },
    apiKeySet: false,
    apiKeyMasked: "",
  };
}

function mockRuntimeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeMockDecompilerRuntime(value, fallback = MOCK_DECOMPILER_RUNTIME) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const inputTimeouts =
    input.providerTimeoutsMs && typeof input.providerTimeoutsMs === "object" && !Array.isArray(input.providerTimeoutsMs)
      ? input.providerTimeoutsMs
      : {};
  const fallbackTimeouts = fallback.providerTimeoutsMs || MOCK_PROVIDER_TIMEOUTS_MS;
  const providerTimeoutsMs = {};

  for (const id of Object.keys(MOCK_PROVIDER_TIMEOUTS_MS)) {
    providerTimeoutsMs[id] = mockRuntimeNumber(
      inputTimeouts[id],
      fallbackTimeouts[id] ?? MOCK_PROVIDER_TIMEOUTS_MS[id],
      500,
      60000,
    );
  }

  return {
    adaptiveFallback:
      typeof input.adaptiveFallback === "boolean" ? input.adaptiveFallback : fallback.adaptiveFallback,
    loadBalanceSlowProviders:
      typeof input.loadBalanceSlowProviders === "boolean"
        ? input.loadBalanceSlowProviders
        : fallback.loadBalanceSlowProviders,
    overallTimeoutMs: mockRuntimeNumber(input.overallTimeoutMs, fallback.overallTimeoutMs, 3000, 60000),
    slowAfterMs: mockRuntimeNumber(input.slowAfterMs, fallback.slowAfterMs, 500, 60000),
    cooldownMs: mockRuntimeNumber(input.cooldownMs, fallback.cooldownMs, 5000, 600000),
    slowSuccessLimit: mockRuntimeNumber(input.slowSuccessLimit, fallback.slowSuccessLimit, 1, 20),
    timeoutLimit: mockRuntimeNumber(input.timeoutLimit, fallback.timeoutLimit, 1, 20),
    providerTimeoutsMs,
  };
}

function mockDecompilerProviderIssue(id, provider) {
  if (!provider || provider.enabled !== true) return null;
  if (id === "oracle" && !provider.apiKeySet) {
    return "Oracle: Authorization required. Add an Oracle API key before this provider can run.";
  }
  if (id !== "builtin" && typeof provider.endpoint === "string" && provider.endpoint.trim() === "") {
    return `${id}: Endpoint required. Open provider settings and add a URL.`;
  }
  return null;
}

function mockDecompilerIssues(settings) {
  return settings.providerOrder
    .map((id) => mockDecompilerProviderIssue(id, settings.providers[id]))
    .filter(Boolean);
}

const mockLogs = [
  { timestamp: new Date(startedAt - 40_000).toISOString(), level: "info", message: "Mock dashboard server started." },
  { timestamp: new Date(startedAt - 20_000).toISOString(), level: "info", message: "Registered mock Roblox client mock-client-1." },
  { timestamp: new Date(startedAt - 5_000).toISOString(), level: "warn", message: "This is mock data. No Roblox process is connected." },
];

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function getLocalLanIp() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        return entry.address;
      }
    }
  }
  return null;
}

function connector(bridgeUrl) {
  return {
    bridgeUrl,
    loaderSnippet: buildLoaderSnippet(bridgeUrl),
  };
}

function makeScript(debugId, scriptPath, hasEmbeddings) {
  const source = mockSources.get(debugId) || "";
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  const lines = source.split("\n").length;
  const bytes = Buffer.byteLength(source, "utf8");
  return {
    debugId,
    path: scriptPath,
    sourceHash,
    lines,
    bytes,
    hasEmbeddings,
    updatedAt: new Date(startedAt).toISOString(),
  };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function scriptByDebugId(debugId) {
  return mockScripts.find((script) => script.debugId === debugId) || null;
}

function scriptSource(debugId) {
  return mockSources.get(debugId) || "";
}

function searchScripts(query) {
  const q = String(query || "").toLowerCase();
  if (!q) return { files: [], code: [], totalCodeMatches: 0, limited: false };

  const files = [];
  const code = [];
  let totalCodeMatches = 0;

  for (const script of mockScripts) {
    if (script.path.toLowerCase().includes(q) || script.debugId.toLowerCase().includes(q)) {
      files.push(script);
    }

    const matches = [];
    const lines = scriptSource(script.debugId).split("\n");
    lines.forEach((line, index) => {
      const lower = line.toLowerCase();
      const column = lower.indexOf(q);
      if (column !== -1) {
        matches.push({
          lineNumber: index + 1,
          line,
          ranges: [[column, column + q.length]],
        });
      }
    });

    if (matches.length > 0) {
      totalCodeMatches += matches.length;
      code.push({
        debugId: script.debugId,
        path: script.path,
        matchCount: matches.length,
        matches,
      });
    }
  }

  return { files, code, totalCodeMatches, limited: false };
}

async function serveAsset(req, res, pathname) {
  if (pathname === "/connector-snippet.mjs") {
    const sharedPath = path.join(repoRoot, useDist ? "dist/shared/connector-snippet.mjs" : "src/shared/connector-snippet.mjs");
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(await fs.readFile(sharedPath));
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(assetsDir, relative);
  if (!target.startsWith(path.resolve(assetsDir) + path.sep) && target !== path.resolve(assetsDir, "index.html")) {
    text(res, 403, "Forbidden");
    return;
  }

  try {
    let body = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    if (ext === ".html") {
      body = Buffer.from(body.toString("utf8").replace(/\{\{WS_PORT\}\}/g, String(SERVER_PORT)));
    }
    res.writeHead(200, {
      "Content-Type": contentType(ext),
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    text(res, 404, "Not found");
  }
}

function contentType(ext) {
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (pathname === "/api/admin-session") {
    json(res, 200, { token: "mock-local-admin-token" });
    return true;
  }

  if (pathname === "/api/status") {
    json(res, 200, {
      connected: true,
      startedAt,
      relayClients: 3,
      clients: mockClients.map((client) => ({
        ...client,
        semanticIndex:
          mockSettings.enabled === false
            ? { embeddedChunks: 0, chunkCount: 0 }
            : client.semanticIndex,
      })),
    });
    return true;
  }

  if (pathname === "/api/client-setup") {
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.action === "install-harnesses") {
        const ids = Array.isArray(body.harnessIds) ? [...new Set(body.harnessIds.map(String))] : [];
        const installed = ids.map((id) => mockHarnesses.find((harness) => harness.id === id)?.name).filter(Boolean);
        if (!installed.length || installed.length !== ids.length) {
          json(res, 400, { ok: false, error: "Select at least one detected harness." });
          return true;
        }
        json(res, 200, {
          ok: true,
          installed,
          restartRequired: true,
          restartMessage: `Restart ${installed.join(", ")} to load the MCP server.`,
          output: "Mock harness install completed. No files were changed.",
          error: null,
        });
        return true;
      }
      if (body.action === "write-autoexec") {
        const autoexec = getAutoexecStatus();
        const targetIds = Array.isArray(body.autoexecTargetIds)
          ? new Set(body.autoexecTargetIds)
          : null;
        const targets = targetIds
          ? autoexec.detectedTargets.filter((target) => targetIds.has(target.id))
          : autoexec.detectedTargets;
        const written = targets.map((target) => ({
          name: target.name,
          scriptPath: target.scriptPath,
          previousPath: target.installedPath || null,
        }));
        json(res, written.length ? 200 : 404, {
          ok: written.length > 0,
          written,
          error: written.length ? null : "No supported autoexec folder was found on this machine.",
          autoexec,
        });
        return true;
      }
      json(res, 200, {
        ok: true,
        output: `Mock ${body.action || "setup"} completed. No real Tailscale commands were run.`,
      });
      return true;
    }

    json(res, 200, {
      serverPort: SERVER_PORT,
      lanIp,
      isLocalRequest: true,
      tailscale: {
        installed: true,
        backendState: "Running",
        ip: tailscaleIp,
      },
      connectors: {
        currentMachine: connector(`localhost:${SERVER_PORT}`),
        localNetwork: connector(`${lanIp}:${SERVER_PORT}`),
        authorizedMachines: connector(`${tailscaleIp}:${SERVER_PORT}`),
      },
      guide: {
        downloadUrl: "https://tailscale.com/download",
        cliUrl: "https://tailscale.com/docs/reference/tailscale-cli",
        linuxInstallCommand: "curl -fsSL https://tailscale.com/install.sh | sh",
        relayExample: `--baseurl http://${tailscaleIp}:${SERVER_PORT}`,
      },
      autoexec: getAutoexecStatus(),
      harnesses: mockHarnesses,
      harnessError: null,
    });
    return true;
  }

  if (pathname === "/api/server-logs") {
    if (req.method === "DELETE") {
      mockLogs.length = 0;
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 200, { logs: mockLogs });
    return true;
  }

  if (pathname === "/api/scripts") {
    json(res, 200, { scripts: mockScripts });
    return true;
  }

  if (pathname === "/api/scripts/search") {
    json(res, 200, searchScripts(url.searchParams.get("q")));
    return true;
  }

  if (pathname === "/api/scripts/source") {
    if (req.method === "PUT") {
      const body = await readJson(req);
      const debugId = String(body.debugId || "");
      if (!mockSources.has(debugId)) {
        json(res, 404, { error: "Mock script not found" });
        return true;
      }
      const source = String(body.source || "");
      mockSources.set(debugId, source);
      mockScripts = mockScripts.map((script) =>
        script.debugId === debugId
          ? {
              ...script,
              sourceHash: crypto.createHash("sha256").update(source).digest("hex"),
              lines: source.split("\n").length,
              bytes: Buffer.byteLength(source, "utf8"),
            }
          : script,
      );
      json(res, 200, {
        ok: true,
        lines: source.split("\n").length,
        bytes: Buffer.byteLength(source, "utf8"),
      });
      return true;
    }

    const debugId = url.searchParams.get("debugId") || "";
    const script = scriptByDebugId(debugId);
    if (!script) {
      json(res, 404, { error: "Mock script not found" });
      return true;
    }
    json(res, 200, {
      path: script.path,
      debugId: script.debugId,
      source: scriptSource(script.debugId),
    });
    return true;
  }

  if (pathname === "/script-source-cache") {
    const body = await readJson(req);
    const wanted = new Set(Array.isArray(body.hashes) ? body.hashes.map(String) : []);
    json(res, 200, {
      ok: true,
      sources: mockScripts
        .filter((script) => wanted.has(script.sourceHash))
        .map((script) => ({
          scriptHash: script.sourceHash,
          sourceHash: script.sourceHash,
          debugId: script.debugId,
          path: script.path,
          source: scriptSource(script.debugId),
          updatedAt: Date.now(),
        })),
    });
    return true;
  }

  if (pathname === "/api/scripts/export") {
    const payload = Buffer.from(
      [
        "Mock script export",
        "",
        ...mockScripts.map((script) => `${script.path}.luau\n${scriptSource(script.debugId)}`),
      ].join("\n\n"),
      "utf8",
    );
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="mock-scripts-export.zip"',
      "Cache-Control": "no-store",
    });
    res.end(payload);
    return true;
  }

  if (pathname === "/api/tool") {
    const body = await readJson(req);
    json(res, 200, {
      ok: true,
      result: {
        mock: true,
        echoedPayload: body,
        message: "Mock tool response. No Roblox client was called.",
      },
    });
    return true;
  }

  if (pathname === "/api/tool-progress") {
    json(res, 200, {
      status: "completed",
      result: { mock: true, message: "Mock job completed." },
    });
    return true;
  }

  if (pathname === "/api/decompiler-settings/connector") {
    json(res, 200, {
      providerOrder: mockDecompilerSettings.providerOrder,
      runtime: mockDecompilerSettings.runtime,
      providers: Object.fromEntries(
        Object.entries(mockDecompilerSettings.providers).map(([id, provider]) => [
          id,
          {
            enabled: provider.enabled,
            endpoint: provider.endpoint,
            apiKey: id === "oracle" ? mockOracleApiKey : "",
            version: provider.version,
            options: provider.options,
          },
        ]),
      ),
    });
    return true;
  }

  if (pathname === "/decompile-plan") {
    const providerId = mockDecompilerSettings.providerOrder.find(
      (id) => mockDecompilerSettings.providers[id]?.enabled === true,
    ) ?? null;
    json(res, 200, { providerId, ttlMs: 1000 });
    return true;
  }

  if (pathname === "/decompiler-observations") {
    await readJson(req);
    json(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/decompiler-settings/setup") {
    if (req.method === "GET") {
      const provider = url.searchParams.get("provider") || "";
      const installed = provider === "shiny" || provider === "fission" ? mockDecompilerInstalls[provider] === true : false;
      const endpoint =
        url.searchParams.get("endpoint") ||
        (provider === "shiny"
          ? MOCK_SHINY_LOCAL_ENDPOINT
          : provider === "fission"
            ? "http://localhost:3001/luau/decompile"
            : "");
      if (!endpoint || !mockDecompilerSettings.providers[provider]) {
        json(res, 400, { error: "Unsupported decompiler provider setup." });
        return true;
      }
      json(res, 200, {
        ok: true,
        provider,
        installed,
        binaryExists: installed,
        serverRunning: installed,
        endpoint,
        repoPath: `/mock/decompilers/${provider}`,
        binaryPath: installed ? `/mock/decompilers/${provider}/${provider === "shiny" ? "medal" : "Fission.Server"}` : null,
        logPath: `/mock/decompilers/${provider}/${provider}.log`,
        assetName: provider === "shiny" ? "medal-mock" : "fission-server-mock",
        assetUrl: `https://example.invalid/${provider}/latest`,
        installedAt: installed ? new Date(startedAt).toISOString() : null,
        updatedAt: installed ? new Date().toISOString() : null,
        error: null,
      });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "Method not allowed" });
      return true;
    }
    const body = await readJson(req);
    const provider = String(body.provider || "");
    const requestedEndpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const endpoint =
      requestedEndpoint ||
      (provider === "shiny"
        ? MOCK_SHINY_LOCAL_ENDPOINT
        : provider === "fission"
          ? "http://localhost:3001/luau/decompile"
          : "");
    if (!endpoint || !mockDecompilerSettings.providers[provider]) {
      json(res, 400, { error: "Unsupported decompiler provider setup." });
      return true;
    }
    mockDecompilerSettings.providers[provider].endpoint = endpoint;
    mockDecompilerSettings.providers[provider].enabled = true;
    if (provider === "shiny") {
      mockDecompilerSettings.providers.shiny.options = { ...mockDecompilerSettings.providers.shiny.options, mode: "local" };
    }
    mockDecompilerInstalls[provider] = true;
    json(res, 200, {
      ok: true,
      provider,
      endpoint,
      repoPath: `/mock/decompilers/${provider}`,
      binaryPath: `/mock/decompilers/${provider}/${provider === "shiny" ? "medal" : "Fission.Server"}`,
      runCommand:
        provider === "shiny"
          ? `medal serve --port ${new URL(endpoint).port || "3000"}`
          : `Fission.Server --port ${new URL(endpoint).port || "3001"}`,
      logPath: `/mock/decompilers/${provider}/${provider}.log`,
      started: true,
      output: `Mock ${provider} setup completed. No release download was run.`,
    });
    return true;
  }

  if (pathname === "/api/decompiler-settings") {
    if (req.method === "PUT") {
      const body = await readJson(req);
      const nextSettings = cloneMockDecompilerSettings();
      let nextOracleApiKey = mockOracleApiKey;
      const incomingProviderIds = body.providers && typeof body.providers === "object"
        ? Object.keys(body.providers)
        : [];
      const incomingOrderIds = Array.isArray(body.providerOrder) ? body.providerOrder.map(String) : [];
      for (const rawId of [...incomingProviderIds, ...incomingOrderIds]) {
        ensureMockCustomDecompilerProvider(nextSettings, rawId === "medal" ? "shiny" : rawId);
      }
      if (Array.isArray(body.providerOrder)) {
        nextSettings.providerOrder = [];
        for (const rawId of body.providerOrder.map(String)) {
          const id = rawId === "medal" ? "shiny" : rawId;
          if (nextSettings.providers[id] && !nextSettings.providerOrder.includes(id)) {
            nextSettings.providerOrder.push(id);
          }
        }
        if (!nextSettings.providerOrder.includes("builtin")) {
          nextSettings.providerOrder.unshift("builtin");
        }
      }
      if (body.providers && typeof body.providers === "object") {
        for (const [rawId, provider] of Object.entries(body.providers)) {
          const id = rawId === "medal" ? "shiny" : rawId;
          if (!nextSettings.providers[id] || !provider || typeof provider !== "object") continue;
          const current = nextSettings.providers[id];
          const options =
            provider.options && typeof provider.options === "object" && !Array.isArray(provider.options)
              ? provider.options
              : current.options;
          nextSettings.providers[id] = {
            ...current,
            enabled: typeof provider.enabled === "boolean" ? provider.enabled : current.enabled,
            endpoint: typeof provider.endpoint === "string" ? provider.endpoint : current.endpoint,
            version: provider.version == null ? null : Number(provider.version),
            options: rawId === "medal" ? { ...options, mode: "hosted" } : options,
          };
          if (id === "oracle" && typeof provider.apiKey === "string") {
            nextOracleApiKey = provider.apiKey;
            nextSettings.providers.oracle.apiKeySet = nextOracleApiKey.length > 0;
            nextSettings.providers.oracle.apiKeyMasked = nextOracleApiKey
              ? `${nextOracleApiKey.slice(0, 3)}...${nextOracleApiKey.slice(-4)}`
              : "";
          }
        }
      }
      if (body.runtime && typeof body.runtime === "object" && !Array.isArray(body.runtime)) {
        nextSettings.runtime = normalizeMockDecompilerRuntime(body.runtime, nextSettings.runtime);
      }
      const issues = mockDecompilerIssues(nextSettings);
      if (issues.length) {
        json(res, 400, { error: `Fix decompiler provider issues before saving: ${issues.join(" ")}` });
        return true;
      }
      mockDecompilerSettings = nextSettings;
      mockOracleApiKey = nextOracleApiKey;
      json(res, 200, mockDecompilerSettings);
      return true;
    }
    json(res, 200, mockDecompilerSettings);
    return true;
  }

  if (pathname === "/api/dashboard-settings") {
    if (req.method === "PUT") {
      const body = await readJson(req);
      mockDashboardSettings = {
        version: 1,
        theme: typeof body.theme === "string" ? body.theme : mockDashboardSettings.theme,
        colors: {
          ...mockDashboardSettings.colors,
          ...(body.colors && typeof body.colors === "object" ? body.colors : {}),
        },
        fonts: {
          ...mockDashboardSettings.fonts,
          ...(body.fonts && typeof body.fonts === "object" ? body.fonts : {}),
        },
        backgroundMedia: {
          ...mockDashboardSettings.backgroundMedia,
          ...(body.backgroundMedia && typeof body.backgroundMedia === "object" ? body.backgroundMedia : {}),
        },
      };
      mockDashboardSettingsPersisted = true;
      json(res, 200, { ...mockDashboardSettings, persisted: true });
      return true;
    }
    json(res, 200, { ...mockDashboardSettings, persisted: mockDashboardSettingsPersisted });
    return true;
  }

  if (pathname === "/api/semantic-settings") {
    if (req.method === "PUT") {
      const body = await readJson(req);
      mockSettings = { ...mockSettings, ...body };
      if (Object.hasOwn(body, "openaiApiKey")) {
        mockSettings.openaiApiKey = typeof body.openaiApiKey === "string" ? body.openaiApiKey : "";
        mockSettings.openaiApiKeySet = mockSettings.openaiApiKey.length > 0;
      }
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === "DELETE") {
      json(res, 200, { ok: true });
      return true;
    }
    const { openaiApiKey: _openaiApiKey, ...publicSettings } = mockSettings;
    json(res, 200, publicSettings);
    return true;
  }

  if (pathname === "/api/semantic-settings/test") {
    const body = req.method === "POST" ? await readJson(req) : {};
    const enabled = typeof body.enabled === "boolean" ? body.enabled : mockSettings.enabled;
    if (enabled === false) {
      json(res, 400, { ok: false, error: "Semantic search is disabled." });
      return true;
    }
    json(res, 200, {
      ok: true,
      dimensions: 1536,
      latencyMs: 12,
    });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  const connectorRoute = new Set([
    "/script-source-cache",
    "/decompile-plan",
    "/decompiler-observations",
  ]).has(url.pathname);

  if (url.pathname.startsWith("/api/") || connectorRoute) {
    const handled = await handleApi(req, res, url);
    if (!handled) json(res, 404, { error: "Mock API route not found" });
    return;
  }

  await serveAsset(req, res, url.pathname);
});

server.listen(port, host, () => {
  const assetMode = useDist ? "dist" : "src";
  console.log(`Mock MCP dashboard running at http://${host}:${port}/`);
  console.log(`Serving ${assetMode} dashboard assets from ${assetsDir}`);
  console.log("No Roblox client, Tailscale, or MCP tool calls are performed in this mode.");
  console.log("Use --port <port>, --host <host>, or --dist if needed.");
});
