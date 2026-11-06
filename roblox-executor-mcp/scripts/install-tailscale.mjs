#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const COMMAND_TIMEOUT_MS = 30000;
const INSTALL_TIMEOUT_MS = 300000;
const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
const TAILSCALE_STABLE_PACKAGES_URL = "https://pkgs.tailscale.com/stable/";
const LINUX_INSTALL_COMMAND = "curl -fsSL https://tailscale.com/install.sh | sh";

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes") || args.includes("-y");
const dryRun = args.includes("--dry-run");
const statusOnly = args.includes("--status");
const installOnly = args.includes("--install-only") || args.includes("--no-up");

function log(message = "") {
  console.log(message);
}

function runCommand(file, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const stdio = options.stdio ?? "pipe";

  return new Promise((resolve) => {
    const child = spawn(file, commandArgs, { windowsHide: true, stdio });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || `Command timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdio === "pipe" && options.echo) process.stdout.write(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stdio === "pipe" && options.echo) process.stderr.write(chunk);
      });
    }

    child.on("error", (error) => {
      finish({ ok: false, code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandToShell(file, commandArgs) {
  return [file, ...commandArgs].map(shellQuote).join(" ");
}

function appleScriptString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function commandExists(command) {
  const result =
    process.platform === "win32"
      ? await runCommand("where.exe", [command], { timeoutMs: 5000 })
      : await runCommand("which", [command], { timeoutMs: 5000 });
  if (!result.ok) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

async function findTailscaleBinary() {
  const fromPath = await commandExists(process.platform === "win32" ? "tailscale.exe" : "tailscale");
  if (fromPath) return fromPath;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "/opt/homebrew/bin/tailscale",
          "/usr/local/bin/tailscale",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Tailscale\\tailscale.exe",
            "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
          ]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function getTailscaleStatus() {
  const binary = await findTailscaleBinary();
  if (!binary) {
    return {
      installed: false,
      binary: null,
      connected: false,
      ip: null,
      backendState: null,
    };
  }

  const statusResult = await runCommand(binary, ["status", "--json"], { timeoutMs: 10000 });
  const ipResult = await runCommand(binary, ["ip", "-4"], { timeoutMs: 10000 });
  let statusJson = null;

  if (statusResult.ok && statusResult.stdout) {
    try {
      statusJson = JSON.parse(statusResult.stdout);
    } catch {
      statusJson = null;
    }
  }

  const ip = ipResult.ok ? ipResult.stdout.split(/\s+/).find(Boolean) || null : null;
  const backendState = typeof statusJson?.BackendState === "string" ? statusJson.BackendState : null;

  return {
    installed: true,
    binary,
    connected: Boolean(ip),
    ip,
    backendState,
    statusOk: statusResult.ok,
    statusError: statusResult.ok ? null : statusResult.stderr || statusResult.stdout || null,
    ipError: ipResult.ok ? null : ipResult.stderr || ipResult.stdout || null,
  };
}

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "roblox-mcp-tailscale-installer" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirected = new URL(res.headers.location, url).toString();
          res.resume();
          httpsGetText(redirected).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    const request = https.get(url, { headers: { "User-Agent": "roblox-mcp-tailscale-installer" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirected = new URL(res.headers.location, url).toString();
        file.close(() => {
          fs.rm(destination, { force: true }, () => {
            downloadFile(redirected, destination).then(resolve, reject);
          });
        });
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        file.close(() => {
          fs.rm(destination, { force: true }, () => reject(new Error(`HTTP ${res.statusCode} from ${url}`)));
        });
        return;
      }

      res.pipe(file);
      file.on("finish", () => {
        file.close(resolve);
      });
    });

    request.on("error", (error) => {
      file.close(() => {
        fs.rm(destination, { force: true }, () => reject(error));
      });
    });
  });
}

async function latestMacPkgUrl() {
  const html = await httpsGetText(TAILSCALE_STABLE_PACKAGES_URL);
  const matches = [...html.matchAll(/href="([^"]*Tailscale-[^"]+-macos\.pkg)"/g)];
  const href = matches[0]?.[1];
  if (!href) throw new Error("Unable to find the latest macOS Tailscale pkg on the stable package page.");
  return new URL(href, TAILSCALE_STABLE_PACKAGES_URL).toString();
}

async function getInstallPlan() {
  if (process.platform === "darwin") {
    const pkgUrl = await latestMacPkgUrl();
    const filename = path.basename(new URL(pkgUrl).pathname);
    const pkgPath = path.join(os.tmpdir(), filename);
    return {
      label: "Install Tailscale with the official macOS pkg",
      prepare: async () => {
        if (!fs.existsSync(pkgPath)) {
          log(`Downloading ${pkgUrl}`);
          await downloadFile(pkgUrl, pkgPath);
        }
      },
      file: "installer",
      args: ["-pkg", pkgPath, "-target", "/"],
      requiresElevation: true,
      commandPreview: `installer -pkg ${pkgPath} -target /`,
    };
  }

  if (process.platform === "linux") {
    const hasCurl = await commandExists("curl");
    if (!hasCurl) {
      throw new Error("curl is required for the official Linux installer, but it was not found.");
    }
    return {
      label: "Install Tailscale with the official Linux install script",
      prepare: async () => {},
      file: "sh",
      args: ["-c", LINUX_INSTALL_COMMAND],
      requiresElevation: true,
      commandPreview: LINUX_INSTALL_COMMAND,
    };
  }

  if (process.platform === "win32") {
    const winget = await commandExists("winget.exe");
    if (!winget) {
      throw new Error(`winget was not found. Download Tailscale from ${TAILSCALE_DOWNLOAD_URL}.`);
    }
    return {
      label: "Install Tailscale with winget",
      prepare: async () => {},
      file: winget,
      args: ["install", "--id", "Tailscale.Tailscale", "-e", "--source", "winget"],
      requiresElevation: true,
      commandPreview: `${winget} install --id Tailscale.Tailscale -e --source winget`,
    };
  }

  throw new Error(`Automatic Tailscale install is not supported on ${process.platform}.`);
}

async function runElevated(file, commandArgs, timeoutMs) {
  if (process.platform === "darwin") {
    const command = commandToShell(file, commandArgs);
    return runCommand(
      "osascript",
      ["-e", `do shell script "${appleScriptString(command)}" with administrator privileges`],
      { timeoutMs, echo: true },
    );
  }

  if (process.platform === "win32") {
    const argList = commandArgs.length ? `@(${commandArgs.map(psQuote).join(",")})` : "@()";
    const script =
      `$p = Start-Process -FilePath ${psQuote(file)} -ArgumentList ${argList} -Verb RunAs -Wait -PassThru; ` +
      "if ($p.ExitCode -ne $null) { exit $p.ExitCode }";
    return runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeoutMs,
      echo: true,
    });
  }

  const sudo = await commandExists("sudo");
  if (sudo) {
    return runCommand(sudo, [file, ...commandArgs], { timeoutMs, stdio: "inherit" });
  }

  const pkexec = await commandExists("pkexec");
  if (pkexec) {
    return runCommand(pkexec, [file, ...commandArgs], { timeoutMs, echo: true });
  }

  return {
    ok: false,
    code: null,
    stdout: "",
    stderr: "No sudo or pkexec command is available for administrator permission.",
  };
}

async function confirmPlan(plan) {
  if (assumeYes || dryRun) return true;
  log("");
  log(`${plan.label} requires administrator permission.`);
  log(`Command: ${plan.commandPreview}`);
  log("");
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("Continue and show the administrator prompt? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printStatus(status) {
  if (!status.installed) {
    log("Tailscale is not installed.");
    return;
  }
  log(`Tailscale binary: ${status.binary}`);
  if (status.connected) {
    log(`Tailscale is connected at ${status.ip}.`);
    log(`MCP relay flag: --baseurl http://${status.ip}:16384`);
  } else if (status.backendState) {
    log(`Tailscale is installed, state: ${status.backendState}.`);
  } else {
    log("Tailscale is installed but not connected.");
    if (status.statusError) log(`status error: ${status.statusError}`);
    if (status.ipError) log(`ip error: ${status.ipError}`);
  }
}

async function installTailscale() {
  const status = await getTailscaleStatus();
  if (status.installed) {
    log("Tailscale is already installed.");
    return status;
  }

  const plan = await getInstallPlan();
  await plan.prepare();

  if (dryRun) {
    log(`[dry-run] ${plan.label}`);
    log(`[dry-run] ${plan.commandPreview}`);
    return status;
  }

  const confirmed = await confirmPlan(plan);
  if (!confirmed) {
    log("Cancelled. Tailscale was not installed.");
    return status;
  }

  const result = plan.requiresElevation
    ? await runElevated(plan.file, plan.args, INSTALL_TIMEOUT_MS)
    : await runCommand(plan.file, plan.args, { timeoutMs: INSTALL_TIMEOUT_MS, echo: true });

  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "Tailscale install failed.");
  }

  log("Tailscale install completed.");
  return getTailscaleStatus();
}

async function runTailscaleUp() {
  const status = await getTailscaleStatus();
  if (!status.installed) return status;
  if (status.connected) return status;
  if (installOnly || dryRun) return status;

  log("");
  log("Connecting Tailscale. This may open a browser or ask you to sign in.");
  const result = await runCommand(status.binary, ["up"], { timeoutMs: 180000, stdio: "inherit" });
  if (!result.ok) {
    log("Tailscale did not connect automatically.");
    log("Run this manually when ready:");
    log(`  ${status.binary} up`);
    return getTailscaleStatus();
  }
  return getTailscaleStatus();
}

try {
  log("Tailscale setup for Roblox Executor MCP");
  log("----------------------------------------");

  if (statusOnly) {
    printStatus(await getTailscaleStatus());
    process.exit(0);
  }

  await installTailscale();
  const finalStatus = await runTailscaleUp();
  log("");
  printStatus(finalStatus);
  log("");
  log("Install Tailscale on the other machine too, then sign in to the same Tailscale account.");
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Manual download: ${TAILSCALE_DOWNLOAD_URL}`);
  process.exit(1);
}
