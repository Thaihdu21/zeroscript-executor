# ZeroScript Executor - Free AI Agent for your running Roblox game

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)

**ZeroScript Executor** is a free browser extension that turns ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena or Meta AI into an AI agent for your **running Roblox game client** (through your executor). Control the live game with AI directly from your browser: run Luau and get values back, inspect the game tree, decompile and search scripts, spy on remotes, click buttons, type into text boxes, take screenshots - all from a normal AI chat. No API key, no coding needed.

This repository merges two projects:

- **[ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free)** (GPL-3.0) - the browser extension that drives AI chat sites. The extension, its providers and the agentic loop are kept as they were; only the backend was replaced.
- **[roblox-executor-mcp](https://github.com/dissering/roblox-executor-mcp)** (MIT) - the local MCP server that connects to a Roblox game client through an executor. Vendored unmodified in [`roblox-executor-mcp/`](roblox-executor-mcp/).

What was **removed** from the original ZeroScript-Free (the Roblox Studio layer):

- `start.bat`, `MacOS_Start.command` - the Python-bridge launchers. The backend server now manages itself (`npm start` / `npm run install:harnesses`), so there is nothing to double-click.
- `bridge.py`, `launch_studio_mcp.py`, `config.json` - the Python WebSocket bridge and the Roblox Studio MCP (`StudioMCP.exe`) launcher. The extension's background worker now talks to roblox-executor-mcp directly.

## How it works

```
AI chat (ChatGPT / DeepSeek / Gemini / Kimi / GLM / Qwen / Arena / Meta AI, in your browser)
   └─ ZeroScript extension (zeroscript-extension/)
        └─ roblox-executor-mcp server on your PC (localhost:16384)
             ├─ WebSocket  ws://127.0.0.1:16384/mcp-relay   (client-side tools)
             ├─ HTTP       /api/tool, /api/status, …         (server-side tools)
             └─ your Roblox game client (connector script run in your executor)
```

The extension runs inside the chat page. When you type a request, the AI writes ZeroScript commands (a `###LUA###` block for code-with-output, or JSON for everything else); the extension sends them to the local roblox-executor-mcp server, which forwards them to your Roblox client through the connector script, and feeds the result back as the next message.

## Setup

### 1. Install the extension

- Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
- Enable **Developer mode** (top right toggle)
- Click **Load unpacked**
- Select the `zeroscript-extension` folder

### 2. Start the MCP server

Requires **Node.js >= 18** (and [Bun](https://bun.sh) for the interactive installer):

```bash
cd roblox-executor-mcp
npm install
npm run install:harnesses   # optional: configure AI clients, prints the loader script
npm start
```

The server listens on `localhost:16384`. Its dashboard is at http://localhost:16384/ (connected clients, scripts, server logs, settings).

### 3. Connect from Roblox

Join a game with your executor and run the MCP connector/loader script in it (the installer prints it; it is also in [`roblox-executor-mcp/README.md`](roblox-executor-mcp/README.md#3-connect-from-roblox), and can be installed into your executor's autoexec folder with `npm run getscript -- --autoexec`).

### 4. Start a session

Go to https://chat.deepseek.com (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai or https://www.meta.ai and open a new chat. The ZeroScript bar appears above the input box. Click **Start session**. Type what you want to do.

> On Arena, keep the mode dropdown on **Direct**. On ChatGPT, image input is disabled on purpose (free-tier file quota).

### Server not on `127.0.0.1:16384`? (custom server address)

The extension ships pointing at `http://127.0.0.1:16384`. If your server is not
there - a different port, another PC on your LAN, or your own MCP server
implementing the same API - open the extension popup and expand
**MCP server address**:

- Enter e.g. `http://192.168.1.5:16384` (or just `192.168.1.5:16384` - the
  `http://` prefix is optional, and the port defaults to `16384` when omitted),
  then **Save**. Chrome asks once for permission to reach that address (the
  extension declares it via `optional_host_permissions`).
- **Reset** returns to the default `http://127.0.0.1:16384`.
- The change applies immediately (the relay socket reconnects) and is
  remembered across browser restarts. The in-page menu (⋯) shows the address
  currently in use.

⚠ The address must point at a server that speaks the **roblox-executor-mcp
HTTP/WS API** (`/mcp-relay` WebSocket, `/api/status`, `/api/tool`,
`/api/screenshot`, `/api/windows`). A plain MCP server over **stdio** (what
Claude Desktop / Cursor connect to) cannot be plugged in by URL - there is no
`/mcp` HTTP endpoint.

**URL reference** (there is no `/mcp` endpoint):

| What | URL |
| --- | --- |
| Dashboard | `http://localhost:16384/` |
| Extension relay (WebSocket) | `ws://127.0.0.1:16384/mcp-relay` |
| Status API | `GET http://localhost:16384/api/status` |
| Tool API | `POST http://localhost:16384/api/tool` |
| AI clients (Claude Desktop, Cursor, …) | no URL - the MCP server speaks **stdio**; configure the command (see `roblox-executor-mcp/docs/setup-*.md`) |

## What the AI can do (in your live game client)

- Run Luau code and get returned values (through your executor)
- Read the developer console
- Search instances with CSS-like selectors; explore the game tree
- Decompile scripts, grep them, or search them semantically
- Spy on / block / ignore remotes (Cobalt remote spy)
- Click buttons, type into text boxes (GUI automation)
- Screenshot the Roblox window (Windows only)
- Work with several connected Roblox clients at once (list-clients / set-active-client)

## Panel status

| Dot | Meaning |
|-----|---------|
| Green | MCP server + Roblox client ready |
| Yellow | Server OK, but no Roblox client is connected - join a game and run the connector script in your executor (hover the dot for details) |
| Grey | MCP server offline - run `npm start` inside `roblox-executor-mcp/` |

## Requirements

- Windows, macOS or Linux
- Node.js >= 18 (Bun >= 1.3 for the interactive installer)
- A Roblox executor that supports `loadstring`, HTTP requests and (preferably) WebSocket
- Microsoft Edge or Chrome

## Command format (what the AI writes)

```
###LUA###
return game.Players.LocalPlayer.Character.Humanoid.Health
###END_LUA###
```

```json
{"command": "search-instances", "params": {"selector": "Humanoid", "root": "game.Workspace"}}
```

`###LUA###` blocks become `get-data-by-code` calls (code runs in the client, returned values come back). Everything else is a JSON command whose names and parameters mirror the MCP tools registered by the backend (`roblox-executor-mcp/src/tools/index.ts`).

## ⚠️ Security

> The roblox-executor-mcp server **allows arbitrary code execution** in the Roblox client and port `16384` has **no authentication** - keep it on `localhost`, never expose it to the internet. See [`roblox-executor-mcp/docs/advanced.md`](roblox-executor-mcp/docs/advanced.md) before doing anything cross-machine. The browser extension talks to `127.0.0.1:16384` by default (you can point it at another address in the popup's "MCP server address" field - but don't, unless you know what you are doing).

## Repository layout

```
zeroscript-extension/     the browser extension (Chrome/Edge, MV3)
  core/config.js            system prompt + tool notes for the executor backend
  core/parser.js            command parsing (###LUA### → get-data-by-code)
  core/main.js              agentic loop + UI
  background.js             WS relay + HTTP client for roblox-executor-mcp
  providers/*.js            per-AI-site integrations (8 providers)
roblox-executor-mcp/      the MCP backend (vendored, unmodified upstream)
assets/                   banners
```

## Credits & licenses

- The extension is derived from [ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free) by sebattfg - GPL-3.0 (see `LICENSE`). macOS/Linux support and the multi-MCP idea came from its contributors (archivealf, javnpa).
- The backend is [roblox-executor-mcp](https://github.com/dissering/roblox-executor-mcp) by dissering - MIT (see `roblox-executor-mcp/LICENSE`).

ZeroScript is free. If it saves you time: [Ko-fi](https://ko-fi.com/sebattfg) - Robux tip passes available in the extension panel.
