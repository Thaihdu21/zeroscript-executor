import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const installerPath = path.join(repoRoot, "scripts", "install-harnesses.mjs");

test("harness installer exposes machine-readable detected targets", async () => {
  const { stdout } = await execFileAsync(process.execPath, [installerPath, "--list-harnesses-json", "--plain"], {
    cwd: repoRoot,
  });
  const targets = JSON.parse(stdout);

  assert.ok(Array.isArray(targets));
  assert.ok(targets.some((target) => target.id === "codex"));
  assert.ok(targets.every((target) => typeof target.detected === "boolean"));
  assert.ok(!targets.some((target) => target.id === "manual"));
});

test("install-only mode selects explicit harnesses and never restarts them", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [installerPath, "--harnesses", "codex", "--yes", "--plain", "--install-only", "--dry-run"],
    { cwd: repoRoot }
  );

  assert.match(stdout, /Codex: configured/);
  assert.match(stdout, /Restart Codex to load the MCP server\./);
  assert.doesNotMatch(stdout, /Restart running harnesses now/);
  assert.doesNotMatch(stdout, /Installing dependencies|Building server/);
  assert.doesNotMatch(stdout, /while not getgenv\(\)\.MCP_Loaded/);
});

test("dashboard add menu routes harness installs through the client setup API", async () => {
  const [html, clientSetupJs, route] = await Promise.all([
    fs.readFile(path.join(repoRoot, "src", "http", "assets", "dashboard", "index.html"), "utf8"),
    fs.readFile(path.join(repoRoot, "src", "http", "assets", "dashboard", "client-setup.js"), "utf8"),
    fs.readFile(path.join(repoRoot, "src", "http", "routes", "api", "client-setup.ts"), "utf8"),
  ]);

  assert.match(html, /data-add-client-kind="roblox"/);
  assert.match(html, /data-add-client-kind="mcp"/);
  assert.match(html, /data-add-client-kind="harness"/);
  assert.match(clientSetupJs, /action: 'install-harnesses'/);
  assert.match(route, /"--install-only"/);
  assert.match(route, /restartMessage/);
});
