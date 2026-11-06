import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireProcessLease,
  publishTrackedProcess,
  registrationIntentDirectory,
  releaseProcessLease,
  trackLocalDecompilerProcess,
} from "../dist/decompiler/local-process-lifetime.js";

const IMMEDIATE_POLICY = {
  zeroLeaseGraceMs: 0,
  registrationIntentQuietMs: 0,
  graceMs: 0,
  forceWaitMs: 0,
  pollMs: 1,
};

function tracked(pid, commandLine, commandToken, startToken = `start-${pid}`) {
  return { pid, commandLine, commandToken, startToken };
}

function fakeOperations(processes, behavior = {}) {
  return {
    snapshot(pid) {
      return processes.get(pid) ?? null;
    },
    terminate(pid, force) {
      behavior.onTerminate?.(pid, force, processes);
      if (!behavior.onTerminate) processes.delete(pid);
    },
    wait() {},
  };
}

test("the final MCP process lease terminates managed local decompilers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const processes = new Map([
    [101, { commandLine: "/repo/dist/index.js", startToken: "mcp-101" }],
    [102, { commandLine: "/repo/dist/index.js", startToken: "mcp-102" }],
    [201, { commandLine: "/managed/Fission.Server --port 3001", startToken: "provider-201" }],
  ]);
  const terminated = [];
  const operations = fakeOperations(processes, {
    onTerminate(pid, force, live) {
      terminated.push([pid, force]);
      live.delete(pid);
    },
  });

  try {
    publishTrackedProcess(paths.leases, tracked(101, "/repo/dist/index.js", "/repo/dist/index.js", "mcp-101"));
    publishTrackedProcess(paths.leases, tracked(102, "/repo/dist/index.js", "/repo/dist/index.js", "mcp-102"));
    publishTrackedProcess(paths.providers, tracked(201, "/managed/Fission.Server --port 3001", "/managed/Fission.Server", "provider-201"));

    assert.equal(releaseProcessLease(101, paths, operations, IMMEDIATE_POLICY), 0);
    assert.deepEqual(terminated, [], "providers must survive while another MCP process is alive");
    assert.equal(releaseProcessLease(102, paths, operations, IMMEDIATE_POLICY), 1);
    assert.deepEqual(terminated, [[201, false]]);
    assert.equal(fs.existsSync(path.join(paths.providers, "201.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("same-binary PID reuse cannot preserve a stale MCP lease", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-stale-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const processes = new Map([
    [301, { commandLine: "/repo/dist/index.js", startToken: "new-process" }],
    [401, { commandLine: "/managed/medal", startToken: "provider-401" }],
  ]);
  const terminated = [];
  const operations = fakeOperations(processes, {
    onTerminate(pid, force, live) {
      terminated.push([pid, force]);
      live.delete(pid);
    },
  });

  try {
    publishTrackedProcess(paths.leases, tracked(301, "/repo/dist/index.js", "/repo/dist/index.js", "old-process"));
    publishTrackedProcess(paths.providers, tracked(401, "/managed/medal", "/managed/medal", "provider-401"));

    assert.equal(releaseProcessLease(999, paths, operations, IMMEDIATE_POLICY), 1);
    assert.deepEqual(terminated, [[401, false]]);
    assert.equal(fs.existsSync(path.join(paths.leases, "301.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("partial atomic-write temp files are ignored by concurrent lease readers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-atomic-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const processes = new Map([
    [502, { commandLine: "/repo/dist/index.js", startToken: "mcp-502" }],
    [601, { commandLine: "/managed/Fission.Server", startToken: "provider-601" }],
  ]);
  const terminated = [];
  const operations = fakeOperations(processes, {
    onTerminate(pid) {
      terminated.push(pid);
    },
  });

  try {
    publishTrackedProcess(paths.leases, tracked(502, "/repo/dist/index.js", "/repo/dist/index.js", "mcp-502"));
    fs.writeFileSync(path.join(paths.leases, ".503.writer.tmp"), "{\"pid\":503");
    publishTrackedProcess(paths.providers, tracked(601, "/managed/Fission.Server", "/managed/Fission.Server", "provider-601"));

    assert.equal(releaseProcessLease(999, paths, operations, IMMEDIATE_POLICY), 0);
    assert.deepEqual(terminated, []);
    assert.equal(fs.existsSync(path.join(paths.leases, ".503.writer.tmp")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("termination escalates to force and only drops ownership after death", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-force-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const processes = new Map([
    [701, { commandLine: "/managed/medal", startToken: "provider-701" }],
  ]);
  const terminated = [];
  const operations = fakeOperations(processes, {
    onTerminate(pid, force, live) {
      terminated.push([pid, force]);
      if (force) live.delete(pid);
    },
  });

  try {
    publishTrackedProcess(paths.providers, tracked(701, "/managed/medal", "/managed/medal", "provider-701"));
    assert.equal(releaseProcessLease(999, paths, operations, IMMEDIATE_POLICY), 1);
    assert.deepEqual(terminated, [[701, false], [701, true]]);
    assert.equal(fs.existsSync(path.join(paths.providers, "701.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a lease acquired during the zero-lease grace period prevents shutdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-interleave-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const processes = new Map([
    [901, { commandLine: "/managed/Fission.Server", startToken: "provider-901" }],
    [902, { commandLine: "/repo/dist/index.js", startToken: "mcp-902" }],
  ]);
  const terminated = [];
  let registeredDuringGrace = false;
  const operations = {
    snapshot(pid) {
      return processes.get(pid) ?? null;
    },
    terminate(pid) {
      terminated.push(pid);
    },
    wait(milliseconds) {
      if (milliseconds === 50 && !registeredDuringGrace) {
        registeredDuringGrace = acquireProcessLease(902, "/repo/dist/index.js", paths, operations);
      }
    },
  };

  try {
    publishTrackedProcess(paths.providers, tracked(901, "/managed/Fission.Server", "/managed/Fission.Server", "provider-901"));
    const policy = { ...IMMEDIATE_POLICY, zeroLeaseGraceMs: 50 };
    assert.equal(releaseProcessLease(999, paths, operations, policy), 0);
    assert.equal(registeredDuringGrace, true);
    assert.deepEqual(terminated, [], "a concurrently registered MCP must keep providers alive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration intent published after the final zero-lease scan prevents shutdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-final-interleave-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const processes = new Map([
    [1201, { commandLine: "/managed/Fission.Server", startToken: "provider-1201" }],
    [1202, { commandLine: "node dist/index.js", startToken: "mcp-1202" }],
  ]);
  const terminated = [];
  let intentPublished = false;
  const operations = {
    snapshot(pid) {
      return processes.get(pid) ?? null;
    },
    terminate(pid) {
      terminated.push(pid);
    },
    wait(milliseconds) {
      if (milliseconds === 10 && !intentPublished) {
        intentPublished = true;
        publishTrackedProcess(
          registrationIntentDirectory(paths),
          tracked(1202, "node dist/index.js", "", "mcp-1202")
        );
      }
    },
  };

  try {
    publishTrackedProcess(paths.providers, tracked(1201, "/managed/Fission.Server", "/managed/Fission.Server", "provider-1201"));
    const policy = { ...IMMEDIATE_POLICY, registrationIntentQuietMs: 50 };
    assert.equal(releaseProcessLease(999, paths, operations, policy), 0);
    assert.equal(intentPublished, true);
    assert.deepEqual(terminated, [], "a registering MCP intent must stop final provider termination");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration intent arriving during the final identity check cancels signaling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-signal-interleave-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const processes = new Map([
    [1301, { commandLine: "/managed/medal", startToken: "provider-1301" }],
    [1302, { commandLine: "node dist/index.js", startToken: "mcp-1302" }],
  ]);
  const terminated = [];
  let providerSnapshots = 0;
  let intentPublished = false;
  const operations = {
    snapshot(pid) {
      if (pid === 1301) {
        providerSnapshots += 1;
        if (providerSnapshots === 2 && !intentPublished) {
          intentPublished = true;
          publishTrackedProcess(
            registrationIntentDirectory(paths),
            tracked(1302, "node dist/index.js", "", "mcp-1302")
          );
        }
      }
      return processes.get(pid) ?? null;
    },
    terminate(pid) {
      terminated.push(pid);
    },
    wait() {},
  };

  try {
    publishTrackedProcess(paths.providers, tracked(1301, "/managed/medal", "/managed/medal", "provider-1301"));
    assert.equal(releaseProcessLease(999, paths, operations, IMMEDIATE_POLICY), 0);
    assert.equal(intentPublished, true);
    assert.deepEqual(terminated, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a real relative Node launch can publish a live MCP lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-relative-launch-"));
  const child = spawn(process.execPath, ["tests/fixtures/relative-process-lease.mjs", root], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const [chunk] = await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw new Error(`relative lease fixture exited before readiness with code ${String(code)}`);
      }),
    ]);
    assert.equal(String(chunk).trim(), "lease-ready");
    const records = fs.readdirSync(path.join(root, "leases"));
    assert.deepEqual(records, [`${child.pid}.json`]);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watchdog startup failure terminates the new provider and removes its record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-watchdog-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const binary = path.resolve("/managed/Fission.Server");
  const processes = new Map([
    [801, { commandLine: `${binary} --port 3001`, startToken: "provider-801" }],
  ]);
  const terminated = [];
  const operations = fakeOperations(processes, {
    onTerminate(pid, force, live) {
      terminated.push([pid, force]);
      live.delete(pid);
    },
  });
  const listeners = new Map();
  const watchdog = {
    once(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
      return this;
    },
    unref() {},
  };

  try {
    assert.equal(trackLocalDecompilerProcess("fission", 801, binary, {
      paths,
      operations,
      terminationPolicy: IMMEDIATE_POLICY,
      startWatchdog: () => watchdog,
    }), true);
    assert.equal(fs.existsSync(path.join(paths.providers, "801.json")), true);

    listeners.get("error")(new Error("spawn failed"));
    assert.deepEqual(terminated, [[801, false]]);
    assert.equal(fs.existsSync(path.join(paths.providers, "801.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider publication failure is fail-safe and never starts a watchdog", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-publish-failure-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const binary = path.resolve("/managed/medal");
  const processes = new Map([
    [1001, { commandLine: `${binary} --port 3002`, startToken: "provider-1001" }],
  ]);
  const terminated = [];
  let watchdogStarted = false;
  const operations = fakeOperations(processes, {
    onTerminate(pid, force, live) {
      terminated.push([pid, force]);
      live.delete(pid);
    },
  });

  try {
    assert.equal(trackLocalDecompilerProcess("shiny", 1001, binary, {
      paths,
      operations,
      terminationPolicy: IMMEDIATE_POLICY,
      publishTracked: () => {
        throw new Error("disk full");
      },
      startWatchdog: () => {
        watchdogStarted = true;
        throw new Error("must not run");
      },
    }), false);
    assert.deepEqual(terminated, [[1001, false]]);
    assert.equal(watchdogStarted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a watchdog that spawns then exits before readiness fails safe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifetime-watchdog-exit-"));
  const paths = {
    leases: path.join(root, "leases"),
    providers: path.join(root, "providers"),
  };
  const binary = path.resolve("/managed/Fission.Server");
  const processes = new Map([
    [1101, { commandLine: `${binary} --port 3001`, startToken: "provider-1101" }],
  ]);
  const terminated = [];
  const operations = fakeOperations(processes, {
    onTerminate(pid, force, live) {
      terminated.push([pid, force]);
      live.delete(pid);
    },
  });
  const listeners = new Map();
  const watchdog = {
    once(event, listener) {
      listeners.set(event, listener);
      return this;
    },
    removeListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
      return this;
    },
    unref() {},
  };

  try {
    assert.equal(trackLocalDecompilerProcess("fission", 1101, binary, {
      paths,
      operations,
      terminationPolicy: IMMEDIATE_POLICY,
      startWatchdog: () => watchdog,
    }), true);
    listeners.get("exit")(1, null);
    assert.deepEqual(terminated, [[1101, false]]);
    assert.equal(fs.existsSync(path.join(paths.providers, "1101.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
