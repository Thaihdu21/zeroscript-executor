#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

if (!args.length) {
  console.error("usage: node scripts/run-with-bun.mjs <bun-args...>");
  process.exit(1);
}

let bun;
try {
  bun = ensureBun();
} catch (error) {
  console.error(`error: ${error.message || error}`);
  process.exit(1);
}
const env = {
  ...process.env,
  PATH: prependPath(process.env.PATH || "", path.dirname(bun)),
};
const run = spawnSync(bun, args, {
  cwd: repoRoot,
  env,
  stdio: "inherit",
  shell: false,
});

if (run.error) {
  console.error(`error: could not run Bun: ${run.error.message}`);
  process.exit(1);
}

process.exit(run.status ?? 1);

function ensureBun() {
  const existing = findBun();
  if (existing) return existing;

  const version = readPackageBunVersion();
  console.log(`Bun is required for the interactive harness installer. Installing Bun${version ? ` ${version}` : ""}...`);
  installBun(version);

  const installed = findBun();
  if (installed) return installed;

  const expected = defaultBunPath();
  throw new Error(
    `Bun installed, but could not find the executable. Try opening a new terminal, or add ${path.dirname(expected)} to PATH.`,
  );
}

function installBun(version) {
  const tag = version ? `bun-v${version}` : "";
  const command = process.platform === "win32"
    ? installBunWindowsCommand(tag)
    : installBunUnixCommand(tag);
  const result = spawnSync(command.command, command.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw new Error(`could not install Bun: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Bun installer exited with code ${result.status ?? "unknown"}`);
  }
}

function installBunUnixCommand(tag) {
  const suffix = tag ? ` -s "${tag}"` : "";
  return {
    command: "sh",
    args: ["-c", `curl -fsSL https://bun.com/install | bash${suffix}`],
  };
}

function installBunWindowsCommand(tag) {
  const expression = tag
    ? `$script = irm bun.sh/install.ps1; & ([scriptblock]::Create($script)) -Version '${tag.replace(/^bun-v/, "")}'`
    : "irm bun.sh/install.ps1 | iex";
  return {
    command: "powershell",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", expression],
  };
}

function findBun() {
  const candidates = [
    process.env.BUN_BIN,
    path.join(process.env.BUN_INSTALL || "", "bin", bunExecutableName()),
    defaultBunPath(),
    findOnPath("bun"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (canRunBun(candidate)) return candidate;
  }
  return null;
}

function canRunBun(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return false;
  const result = spawnSync(candidate, ["--version"], {
    stdio: "ignore",
    shell: false,
  });
  return !result.error && result.status === 0;
}

function findOnPath(command) {
  const pathEnv = process.env.PATH || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, process.platform === "win32" ? command + ext.toLowerCase() : command);
      if (fs.existsSync(candidate)) return candidate;
      const upperCandidate = path.join(dir, process.platform === "win32" ? command + ext.toUpperCase() : command);
      if (fs.existsSync(upperCandidate)) return upperCandidate;
    }
  }
  return null;
}

function defaultBunPath() {
  return path.join(os.homedir(), ".bun", "bin", bunExecutableName());
}

function bunExecutableName() {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function prependPath(pathEnv, dir) {
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  if (!parts.includes(dir)) parts.unshift(dir);
  return parts.join(path.delimiter);
}

function readPackageBunVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const packageManager = String(packageJson.packageManager || "");
    const match = packageManager.match(/^bun@(.+)$/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}
