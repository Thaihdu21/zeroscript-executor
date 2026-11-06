import assert from "node:assert/strict";
import test from "node:test";

import {
  clearScriptSourceIndex,
  getCachedScriptSourcesByScriptHash,
  getScriptSourceIndex,
  upsertScriptSources,
} from "../dist/bridge/handlers/shared/script-source-store.js";
import {
  clearDecompilerHealthForClient,
  getDecompilerHealthSnapshot,
  recordDecompilerProviderObservation,
  recordDecompilerProviderFailure,
  recordDecompilerProviderSuccess,
  shouldSkipDecompilerProvider,
} from "../dist/decompiler/health.js";
import { decompileBytecode, resolveDecompilerProviders } from "../dist/decompiler/run.js";
import { compileCustomDecompilerWorkflow } from "../dist/decompiler/custom-workflow.js";
import {
  cleanupInactiveHttpClients,
  getClientById,
  registerClient,
  resetRegistry,
} from "../dist/bridge/handlers/shared/registry.js";
import {
  DEFAULT_DECOMPILER_SETTINGS,
  DEFAULT_DECOMPILER_RUNTIME_SETTINGS,
  normalizeDecompilerSettingsInput,
} from "../dist/decompiler/settings.js";
import {
  semanticIndexReadyMessage,
  semanticPartialIndexWarning,
} from "../dist/semantic/index-status.js";

function identity(name) {
  return { clientId: name, placeId: 1, jobId: "job" };
}

test("mapping revisions ignore stale progress without dropping source payloads", () => {
  const id = identity("revision-ordering");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "session-a",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    sourcesToMap: 2,
    processedSources: 0,
    hasFinishedMapping: false,
  });
  upsertScriptSources(id, {
    mappingSessionId: "session-a",
    mappingRevision: 3,
    sourcesToMap: 2,
    processedSources: 2,
    skippedSources: 1,
    hasFinishedMapping: true,
    scripts: [{ debugId: "one", path: "A", source: "return 1", scriptHash: "h1" }],
  });

  const stale = upsertScriptSources(id, {
    mappingSessionId: "session-a",
    mappingRevision: 2,
    sourcesToMap: 99,
    processedSources: 0,
    skippedSources: 0,
    hasFinishedMapping: false,
    scripts: [{ debugId: "two", path: "B", source: "return 2", scriptHash: "h2" }],
  });
  assert.equal(stale.acceptedMappingRevision, 3);

  const afterStale = getScriptSourceIndex(id);
  assert.equal(afterStale.scripts.length, 2, "stale metadata must not discard source data");
  assert.equal(afterStale.sourcesToMap, 2);
  assert.equal(afterStale.processedSources, 2);
  assert.equal(afterStale.skippedSources, 1);
  assert.equal(afterStale.hasFinishedMapping, true);

  const healed = upsertScriptSources(id, {
    mappingSessionId: "session-a",
    mappingRevision: 4,
    sourcesToMap: 2,
    processedSources: 2,
    skippedSources: 0,
    hasFinishedMapping: true,
  });
  assert.equal(healed.sourceGap, 0);
  assert.equal(healed.sourceIndexComplete, true);
  clearScriptSourceIndex(id.clientId);
});

test("a different mapping session cannot replace progress without an explicit begin", () => {
  const id = identity("session-handoff");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "current",
    mappingSessionStartedAt: 200,
    mappingRevision: 1,
    sourcesToMap: 4,
    processedSources: 2,
  });

  const rejected = upsertScriptSources(id, {
    mappingSessionId: "other",
    mappingRevision: 10,
    sourcesToMap: 100,
    processedSources: 100,
    hasFinishedMapping: true,
  });
  assert.equal(rejected.acceptedMappingRevision, 1);
  assert.equal(getScriptSourceIndex(id).sourcesToMap, 4);

  const staleBegin = upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "older",
    mappingSessionStartedAt: 100,
    mappingRevision: 99,
    sourcesToMap: 999,
    processedSources: 999,
    hasFinishedMapping: true,
  });
  assert.equal(staleBegin.acceptedMappingRevision, 1);
  assert.equal(getScriptSourceIndex(id).sourcesToMap, 4);

  const equalTimestampBegin = upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "same-time-late",
    mappingSessionStartedAt: 200,
    mappingRevision: 100,
    sourcesToMap: 999,
    processedSources: 999,
    hasFinishedMapping: true,
  });
  assert.equal(equalTimestampBegin.acceptedMappingRevision, 1);
  assert.equal(getScriptSourceIndex(id).sourcesToMap, 4);

  const accepted = upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "other",
    mappingSessionStartedAt: 300,
    mappingRevision: 11,
    sourcesToMap: 0,
    processedSources: 0,
    hasFinishedMapping: true,
  });
  assert.equal(accepted.acceptedMappingRevision, 11);
  assert.equal(accepted.sourceIndexComplete, true, "a finished empty source set is complete");
  clearScriptSourceIndex(id.clientId);
});

test("script hash cache retains historical hashes and indexes replacements", () => {
  const id = identity("hash-index");
  upsertScriptSources(id, {
    scripts: [
      { debugId: "one", path: "A", source: "one", scriptHash: "shared" },
      { debugId: "two", path: "B", source: "two", scriptHash: "shared" },
    ],
  });
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["shared"])[0]?.debugId, "two");

  upsertScriptSources(id, {
    scripts: [{ debugId: "two", path: "B", source: "changed", scriptHash: "other" }],
  });
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["shared"])[0]?.debugId, "two");
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["other"])[0]?.debugId, "two");
  clearScriptSourceIndex(id.clientId);
});

test("new mapping sessions retain hash cache entries without indexing stale scripts", () => {
  const id = identity("active-session-cache");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "old",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    sourcesToMap: 1,
    processedSources: 1,
    hasFinishedMapping: true,
    scripts: [{ debugId: "old-script", path: "Old", source: "old", scriptHash: "old-hash" }],
  });
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "new",
    mappingSessionStartedAt: 200,
    mappingRevision: 1,
    sourcesToMap: 1,
    processedSources: 1,
    hasFinishedMapping: true,
    scripts: [{ debugId: "new-script", path: "New", source: "new", scriptHash: "new-hash" }],
  });

  const current = getScriptSourceIndex(id);
  assert.deepEqual(current.scripts.map((script) => script.debugId), ["new-script"]);
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["old-hash"])[0]?.debugId, "old-script");
  clearScriptSourceIndex(id.clientId);
});

test("revisioned tombstones remove active scripts and stale uploads cannot resurrect them", () => {
  const id = identity("script-removal-ordering");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "session",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    sourcesToMap: 1,
    processedSources: 1,
    scripts: [{ debugId: "gone", path: "Gone", source: "old", scriptHash: "gone-hash" }],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 3,
    sourcesToMap: 0,
    processedSources: 0,
    hasFinishedMapping: true,
    removedScriptIds: ["gone"],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 2,
    scripts: [{ debugId: "gone", path: "Gone", source: "late", scriptHash: "gone-hash" }],
  });

  const current = getScriptSourceIndex(id);
  assert.equal(current.scripts.length, 0);
  assert.equal(current.sourceIndexComplete, true);
  assert.equal(
    getCachedScriptSourcesByScriptHash(id, ["gone-hash"])[0]?.source,
    "late",
    "late payloads may refresh the reusable cache without rejoining the active index"
  );
  clearScriptSourceIndex(id.clientId);
});

test("stale source payloads can refresh cache without overwriting newer active source", () => {
  const id = identity("active-source-ordering");
  upsertScriptSources(id, {
    beginMappingSession: true,
    mappingSessionId: "session",
    mappingSessionStartedAt: 100,
    mappingRevision: 1,
    scripts: [{ debugId: "x", path: "X", source: "v1", scriptHash: "hash-v1" }],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 3,
    scripts: [{ debugId: "x", path: "X", source: "v3", scriptHash: "hash-v3" }],
  });
  upsertScriptSources(id, {
    mappingSessionId: "session",
    mappingRevision: 2,
    scripts: [{ debugId: "x", path: "X", source: "v2", scriptHash: "hash-v2" }],
  });

  assert.equal(getScriptSourceIndex(id).scripts[0]?.source, "v3");
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["hash-v2"])[0]?.source, "v2");
  assert.equal(getCachedScriptSourcesByScriptHash(id, ["hash-v3"])[0]?.source, "v3");

  upsertScriptSources(id, {
    mappingSessionId: "session",
    scripts: [{ debugId: "x", path: "X", source: "invalid", scriptHash: "hash-invalid" }],
  });
  assert.equal(getScriptSourceIndex(id).scripts[0]?.source, "v3");
  assert.equal(
    getCachedScriptSourcesByScriptHash(id, ["hash-invalid"])[0]?.source,
    "invalid",
    "invalid revisions may populate reusable cache but cannot mutate active source"
  );
  clearScriptSourceIndex(id.clientId);
});

test("sustained fast successes remain healthy and cooldowns affect resolved plans", () => {
  for (let index = 0; index < 1000; index += 1) {
    recordDecompilerProviderSuccess(
      "konstant",
      108,
      DEFAULT_DECOMPILER_RUNTIME_SETTINGS,
      "health-test"
    );
  }
  assert.equal(getDecompilerHealthSnapshot().providers.konstant?.status, "healthy");

  recordDecompilerProviderFailure({
    id: "fission",
    errorMessage: "provider failed",
    runtime: DEFAULT_DECOMPILER_RUNTIME_SETTINGS,
    clientId: "health-test",
  });
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  settings.providerOrder = ["fission", "builtin", "luaexpert", "shiny", "oracle", "konstant"];
  settings.providers.fission.enabled = true;
  assert.notEqual(
    resolveDecompilerProviders(settings, { clientId: "health-test" }).orderedProviders[0],
    "fission"
  );
});

test("an explicitly requested original provider stays first before ordered fallbacks", () => {
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  settings.providerOrder = ["builtin", "luaexpert", "shiny", "oracle", "konstant", "fission"];
  for (const provider of Object.values(settings.providers)) provider.enabled = true;

  recordDecompilerProviderFailure({
    id: "oracle",
    errorMessage: "Timed out after 1s.",
    timedOut: true,
    runtime: settings.runtime,
    clientId: "provider-preference",
  });
  recordDecompilerProviderFailure({
    id: "oracle",
    errorMessage: "Timed out after 1s.",
    timedOut: true,
    runtime: settings.runtime,
    clientId: "provider-preference",
  });

  const ordinary = resolveDecompilerProviders(settings, {
    clientId: "provider-preference",
  });
  assert.equal(ordinary.orderedProviders.includes("oracle"), false, "oracle must actually be cooling down");

  const resolved = resolveDecompilerProviders(settings, {
    clientId: "provider-preference",
    requestedProvider: "oracle",
  });
  assert.deepEqual(resolved.orderedProviders, ["oracle", ...ordinary.orderedProviders]);
});

test("an unavailable built-in is not reported as an attempted retry provider", async () => {
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  for (const [id, provider] of Object.entries(settings.providers)) {
    provider.enabled = id === "builtin";
  }
  const result = await decompileBytecode(settings, {
    bytecodeBase64: Buffer.from("bytecode").toString("base64"),
    builtinAvailable: false,
    requestedProvider: "builtin",
    clientId: "attempted-provider-contract",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.attemptedProviders, []);
});

test("a built-in handshake is reported as an attempted provider", async () => {
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  for (const [id, provider] of Object.entries(settings.providers)) {
    provider.enabled = id === "builtin";
  }
  const result = await decompileBytecode(settings, {
    bytecodeBase64: Buffer.from("bytecode").toString("base64"),
    builtinAvailable: true,
    requestedProvider: "builtin",
    clientId: "attempted-builtin-handshake",
  });
  assert.equal(result.needsBuiltin, true);
  assert.deepEqual(result.attemptedProviders, ["builtin"]);
});

test("a custom decompiler provider can send JSON and read a nested JSON response", async (t) => {
  let receivedBody = "";
  let receivedAuthorization = "";
  let receivedUrl = "";
  t.mock.method(globalThis, "fetch", async (url, init) => {
    receivedUrl = String(url);
    receivedBody = String(init?.body || "");
    receivedAuthorization = new Headers(init?.headers).get("Authorization") || "";
    return new Response(JSON.stringify({ data: { source: "return 42" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const settings = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  for (const provider of Object.values(settings.providers)) provider.enabled = false;
  settings.providers.custom = {
    enabled: true,
    endpoint: "https://legacy.example/decompile",
    apiKey: "secret",
    version: null,
    options: {
      name: "Local custom",
      requestFormat: "plain-bytecode",
      requestField: "ignored",
      responseFormat: "text",
      responseField: "ignored",
      apiKeyHeader: "Authorization",
      apiKeyPrefix: "Bearer",
      headers: { "X-Test": "custom" },
      workflow: {
        version: 1,
        nodes: [
          { id: "bytecode", type: "bytecode", config: {} },
          { id: "base64", type: "base64", config: {} },
          { id: "variable", type: "set-variable", config: { name: "bytecode" } },
          {
            id: "request",
            type: "request",
            config: {
              endpoint: "https://custom.example/decompile",
              headersTemplate: JSON.stringify({
                "X-Test": "custom",
                Authorization: "Bearer {{api_key}}",
              }),
              bodyTemplate: JSON.stringify({ bytecode: "{{bytecode}}" }),
            },
          },
          { id: "parse", type: "parse-json", config: { path: "data.source" } },
          { id: "source", type: "source", config: {} },
        ],
        edges: [
          { source: "bytecode", target: "base64" },
          { source: "base64", target: "variable" },
          { source: "variable", target: "request" },
          { source: "request", target: "parse" },
          { source: "parse", target: "source" },
        ],
      },
    },
  };
  settings.providerOrder = ["custom"];

  const bytecodeBase64 = Buffer.from("bytecode").toString("base64");
  const result = await decompileBytecode(settings, {
    bytecodeBase64,
    clientId: "custom-provider-test",
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "custom");
  assert.equal(result.source, "-- Decompiled with Local custom\nreturn 42");
  assert.equal(receivedUrl, "https://custom.example/decompile");
  assert.deepEqual(JSON.parse(receivedBody), { bytecode: bytecodeBase64 });
  assert.equal(receivedAuthorization, "Bearer secret");
});

test("custom request templates reject unknown variables", () => {
  assert.throws(
    () => compileCustomDecompilerWorkflow({
      nodes: [
        { id: "bytecode", type: "bytecode" },
        { id: "variable", type: "set-variable", config: { name: "input" } },
        {
          id: "request",
          type: "request",
          config: {
            endpoint: "https://example.com/decompile",
            headersTemplate: "{}",
            bodyTemplate: "{{missing}}",
          },
        },
        { id: "source", type: "source" },
      ],
      edges: [
        { source: "bytecode", target: "variable" },
        { source: "variable", target: "request" },
        { source: "request", target: "source" },
      ],
    }),
    /unknown variable "missing"/
  );
});

test("custom workflow endpoints add a protocol and preserve the BridgeHost token", () => {
  const compileEndpoint = endpoint => compileCustomDecompilerWorkflow({
    nodes: [
      { id: "bytecode", type: "bytecode" },
      { id: "request", type: "request", config: { endpoint } },
      { id: "source", type: "source" },
    ],
    edges: [
      { source: "bytecode", target: "request" },
      { source: "request", target: "source" },
    ],
  }).endpoint;

  assert.equal(compileEndpoint("example.com/decompile"), "http://example.com/decompile");
  assert.equal(
    compileEndpoint("http://{{BridgeHost}}:3001/decompile"),
    "http://{{BridgeHost}}:3001/decompile"
  );
});

test("custom decompiler workflows reject disconnected blocks", () => {
  assert.throws(
    () => compileCustomDecompilerWorkflow({
      nodes: [
        { id: "bytecode", type: "bytecode" },
        { id: "request", type: "request", config: { endpoint: "https://example.com" } },
        { id: "source", type: "source" },
        { id: "orphan", type: "base64" },
      ],
      edges: [
        { source: "bytecode", target: "request" },
        { source: "request", target: "source" },
      ],
    }),
    /Every block must be connected/
  );
});

test("multiple custom decompiler providers survive settings normalization independently", () => {
  const settings = normalizeDecompilerSettingsInput({
    providerOrder: ["builtin", "custom:first", "custom:second"],
    providers: {
      "custom:first": {
        enabled: true,
        endpoint: "https://first.example/decompile",
        options: { name: "First" },
      },
      "custom:second": {
        enabled: false,
        endpoint: "https://second.example/decompile",
        options: { name: "Second" },
      },
    },
  });

  assert.equal(settings.providers["custom:first"].endpoint, "https://first.example/decompile");
  assert.equal(settings.providers["custom:first"].options.name, "First");
  assert.equal(settings.providers["custom:second"].endpoint, "https://second.example/decompile");
  assert.equal(settings.providers["custom:second"].options.name, "Second");
  assert.deepEqual(
    settings.providerOrder.filter((id) => id.startsWith("custom:")),
    ["custom:first", "custom:second"]
  );
  assert.equal(settings.runtime.providerTimeoutsMs["custom:first"], 10000);
  assert.equal(settings.runtime.providerTimeoutsMs["custom:second"], 10000);
});

test("an explicit empty provider API key clears the stored fallback", () => {
  const fallback = structuredClone(DEFAULT_DECOMPILER_SETTINGS);
  fallback.providers.oracle.apiKey = "stored-secret";
  fallback.providers.oracle.enabled = false;

  const settings = normalizeDecompilerSettingsInput({
    providers: {
      oracle: { apiKey: "" },
    },
  }, fallback);

  assert.equal(settings.providers.oracle.apiKey, "");
});

test("multiple custom decompiler providers fall through in their configured order", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("first failed", { status: 500 });
    return new Response("return 'second'", { status: 200 });
  });
  const settings = normalizeDecompilerSettingsInput({
    providerOrder: ["custom:fallback-first", "custom:fallback-second"],
    providers: {
      builtin: { enabled: false },
      luaexpert: { enabled: false },
      shiny: { enabled: false },
      oracle: { enabled: false },
      konstant: { enabled: false },
      fission: { enabled: false },
      custom: { enabled: false },
      "custom:fallback-first": {
        enabled: true,
        endpoint: "https://first.example/decompile",
        options: { name: "First", requestFormat: "plain-base64", responseFormat: "text" },
      },
      "custom:fallback-second": {
        enabled: true,
        endpoint: "https://second.example/decompile",
        options: { name: "Second", requestFormat: "plain-base64", responseFormat: "text" },
      },
    },
  });

  const result = await decompileBytecode(settings, {
    bytecodeBase64: Buffer.from("bytecode").toString("base64"),
    clientId: "multiple-custom-fallbacks",
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerId, "custom:fallback-second");
  assert.deepEqual(calls, [
    "https://first.example/decompile",
    "https://second.example/decompile",
  ]);
});

test("built-in health is client scoped and stale observations are rejected", () => {
  const runtime = DEFAULT_DECOMPILER_RUNTIME_SETTINGS;
  const failureAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-a",
    runtime,
    observationSessionId: "session-a",
    observationSessionStartedAt: 200,
    observationRevision: 2,
    beginObservationSession: true,
    latencyMs: 8000,
    errorMessage: "timed out",
    timedOut: true,
  });
  const staleSuccessAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-a",
    runtime,
    observationSessionId: "session-a",
    observationSessionStartedAt: 200,
    observationRevision: 1,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const revisionSeedAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-ordering",
    runtime,
    observationSessionId: "session-ordering",
    observationSessionStartedAt: 300,
    observationRevision: 1,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const invalidHighRevisionAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-ordering",
    runtime,
    observationSessionId: "session-ordering",
    observationSessionStartedAt: 300,
    observationRevision: 4,
    beginObservationSession: true,
    successCount: 0,
  });
  const validOlderRevisionAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-ordering",
    runtime,
    observationSessionId: "session-ordering",
    observationSessionStartedAt: 300,
    observationRevision: 3,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const otherClientAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-b",
    runtime,
    observationSessionId: "session-b",
    observationSessionStartedAt: 200,
    observationRevision: 1,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });
  const equalTimestampSessionAccepted = recordDecompilerProviderObservation({
    id: "builtin",
    clientId: "client-a",
    runtime,
    observationSessionId: "session-equal-late",
    observationSessionStartedAt: 200,
    observationRevision: 99,
    beginObservationSession: true,
    latencyMs: 20,
    successCount: 1,
  });

  assert.equal(failureAccepted, true);
  assert.equal(staleSuccessAccepted, false);
  assert.equal(revisionSeedAccepted, true);
  assert.equal(invalidHighRevisionAccepted, false);
  assert.equal(validOlderRevisionAccepted, true, "rejected payloads must not consume revisions");
  assert.equal(otherClientAccepted, true);
  assert.equal(equalTimestampSessionAccepted, false);
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-a").skip, false);
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-b").skip, false);
  assert.equal(getDecompilerHealthSnapshot("client-a").providers.builtin?.status, "timing_out");
  assert.equal(getDecompilerHealthSnapshot("client-b").providers.builtin?.status, "healthy");

  recordDecompilerProviderFailure({
    id: "builtin",
    clientId: "client-a-cooldown",
    runtime,
    errorMessage: "failed",
  });
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-a-cooldown").skip, true);
  assert.equal(shouldSkipDecompilerProvider("builtin", runtime, "client-b").skip, false);
  clearDecompilerHealthForClient("client-a");
  assert.equal(getDecompilerHealthSnapshot("client-a").providers.builtin, undefined);
});

test("expired HTTP clients release registry, source-index, and built-in health state", () => {
  resetRegistry();
  const clientId = registerClient({
    username: "test",
    userId: 1,
    placeId: 1,
    jobId: "job",
    placeName: "place",
    sessionId: "expired-session",
    transport: "http",
  });
  const client = getClientById(clientId);
  assert.ok(client);
  upsertScriptSources({ clientId, placeId: 1, jobId: "job" }, {
    scripts: [{ debugId: "x", path: "X", source: "return 1", scriptHash: "expired-hash" }],
  });
  recordDecompilerProviderSuccess("builtin", 10, DEFAULT_DECOMPILER_RUNTIME_SETTINGS, clientId);
  assert.ok(getDecompilerHealthSnapshot(clientId).providers.builtin);

  client.lastHttpPoll = 0;
  assert.equal(cleanupInactiveHttpClients(Date.now()), 1);
  assert.equal(getClientById(clientId), undefined);
  assert.equal(getDecompilerHealthSnapshot(clientId).providers.builtin, undefined);
  assert.equal(getScriptSourceIndex({ clientId, placeId: 1, jobId: "job" }).mappedSources, 0);
  resetRegistry();
});

test("semantic index status formatting uses the canonical completeness value", () => {
  const warning = semanticPartialIndexWarning({
    chunkCount: 10,
    embeddedChunks: 10,
    sourceIndexComplete: false,
  });
  assert.match(warning ?? "", /source sync is incomplete/i);

  assert.equal(
    semanticIndexReadyMessage(
      { chunkCount: 0, embeddedChunks: 0, sourceIndexComplete: true },
      { mappedSources: 0, sourcesToMap: 0, skippedSources: 0 }
    ),
    "Semantic index ready: 0/0 chunks embedded."
  );
});
