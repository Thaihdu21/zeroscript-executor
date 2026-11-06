# ZeroScript Free - AI Roblox Executor Agent (ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Meta AI)

Control your **running Roblox game client** with AI, for free. ZeroScript turns a normal AI chat (ChatGPT, DeepSeek, Google Gemini, Kimi, GLM, Qwen, Arena, or Meta AI) into an agent that works inside your live Roblox game: just describe what you want, and it runs Luau through your executor, inspects the game tree, decompiles and searches scripts, spies on remotes, clicks buttons, fills text boxes and takes screenshots. No API key, no coding required.

It's a Chrome/Edge browser extension plus the local **roblox-executor-mcp** server (bundled in this repository, `../roblox-executor-mcp/`) that the chat talks to. **DeepSeek is the recommended provider.** ChatGPT, Gemini, Kimi, GLM, Qwen, Arena and Meta AI also work. On ChatGPT, screenshots and image input are disabled on purpose (its free tier caps files/images on a separate quota from messages, so vision would only work part of the day); ChatGPT also summarises its own context in long sessions, so ZeroScript re-states its operating instructions periodically (shown as a "Reminder" chip) to stop it forgetting it can run commands. Gemini and Kimi can be less stable: Gemini tends to stop using the Roblox tools in long sessions, and Kimi sometimes reaches for its own native tools instead of the Roblox commands. On Arena, keep the mode dropdown on **Direct** (ZeroScript only supports Direct mode).

## Setup

**Load the extension manually (Edge or Chrome):**
1. Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `zeroscript-extension` folder
5. The extension is now active

**Then start the MCP server and connect Roblox** (see `../roblox-executor-mcp/README.md` for the full guide):
1. In the `roblox-executor-mcp/` folder: `npm install`, then `npm start` (or run `npm run install:harnesses` once to configure AI clients and print the loader script)
2. **Join a Roblox game** with your executor and **run the MCP connector/loader script** in it (the installer can print it, or copy it from the backend README)
3. **Go to https://chat.deepseek.com** (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai, or https://www.meta.ai, open a new chat (only works on these exact addresses; on Arena use Direct mode)
4. Click **Start session** in the ZeroScript panel
5. Type what you want to do in the game

> **Server not on `127.0.0.1:16384`?** Open the extension popup → *MCP server
> address* and point ZeroScript at your own server (e.g.
> `http://192.168.1.5:16384`; the port defaults to 16384). Chrome asks for
> permission once. **Reset** goes back to the default. The address must speak
> the roblox-executor-mcp HTTP/WS API - a plain stdio MCP server cannot be
> plugged in by URL (there is no `/mcp` endpoint; see the root README).

## What the AI can do (all inside your live game client)

- Run Luau code (with returned values) through your executor
- Inspect the game tree and search instances (CSS-like selectors)
- Decompile, grep and semantically search every script in the game
- Spy on, block and ignore RemoteEvents/RemoteFunctions (Cobalt)
- Click buttons and type into text boxes (GUI automation)
- Screenshot the Roblox window (Windows)
- Read the developer console, switch between multiple connected clients

## Architecture (for contributors)

The extension is split between a provider-agnostic core and per-AI-site providers:

```
core/config.js        system prompt, feedback strings, tool categories (global ZS)
core/parser.js        ZeroScript command parsing - pure string logic   (global ZSParse)
core/main.js          agentic loop, UI, camouflage, session state      (uses ZSProvider)
providers/deepseek.js everything DeepSeek-specific: DOM selectors, generation
                      detection, send mechanics, composer modes…       (global ZSProvider)
providers/gemini.js   same interface for Google Gemini (Angular DOM, Quill
                      composer, code-block masking)                    (global ZSProvider)
providers/kimi.js     same interface for Kimi / Moonshot AI (Vue DOM, Lexical
                      composer, segment-code masking)                  (global ZSProvider)
providers/glm.js      same interface for GLM / Z.ai (Svelte DOM, code-block
                      wrapper masking)                                 (global ZSProvider)
providers/qwen.js     same interface for Qwen / chat.qwen.ai (Vue DOM, network-tap
                      SSE stream, Monaco disposal guard)               (global ZSProvider)
providers/qwen-net.js MAIN-world fetch tap for Qwen SSE stream        (injected by manifest)
providers/chatgpt.js  same interface for ChatGPT / chatgpt.com (React DOM,
                      ProseMirror composer, CodeMirror reply reading) (global ZSProvider)
providers/chatgpt-cm.js MAIN-world CodeMirror tap: republishes each code block's
                      TRUE document (the rendered DOM truncates long
                      lines)                                          (injected by manifest)
providers/arena.js    same interface for Arena / arena.ai (React DOM, multi-model
                      playground, A/B-comparison auto-commit, Direct-mode gate) (global ZSProvider)
providers/meta.js     same interface for Meta AI / meta.ai (React DOM, textarea
                      composer, JSON-viewer + code-collapse masking)   (global ZSProvider)
background.js         connection to the local roblox-executor-mcp server:
                      one WebSocket to ws://127.0.0.1:16384/mcp-relay for
                      client-side tools, HTTP /api/* for server-side tools
                      (script-grep, semantic search, screenshots) and status.
```

`core/main.js` never touches the host site's DOM directly - it only calls the
`ZSProvider` interface. To integrate another AI site: write a new
`providers/<site>.js` exporting the same interface, then add its URL pattern to
`manifest.json` (`content_scripts` + `host_permissions`) and to
`PROVIDER_URLS` in `background.js`. No core change required.

### Command format (what the AI writes)

```
###LUA###
-- runs as get-data-by-code: code executes in the Roblox client,
-- returned values come back to the AI
return game.Players.LocalPlayer.Name
###END_LUA###
```

```json
{"command": "search-instances", "params": {"selector": "Humanoid", "root": "game.Workspace"}}
```

The tool catalogue mirrors the MCP tools registered by the backend
(`roblox-executor-mcp/src/tools/index.ts`) and lives in `background.js` (`TOOLS`).
`###LUA###` blocks are parsed by `core/parser.js` into `get-data-by-code` calls.

Smoke tests (plain Node, no dependencies - run them from this directory):

- `node test-parser.js` - the command parser (`core/parser.js`).
- `node test-chatgpt.js` - ChatGPT reply reading (`providers/chatgpt.js`),
  driven against a stub DOM: CodeMirror line joining, the `data-zs-cm`
  MAIN-world tap that long code blocks depend on, and subtree exclusion.

Both print `PASS`/`FAIL` per case and exit non-zero on failure.

## Support

☕ [Ko-fi](https://ko-fi.com/sebattfg) - Robux tip passes available in the extension panel
