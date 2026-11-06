# BLACKBOX AI Setup

BLACKBOX AI supports MCP servers through its VS Code extension, but it does not document a supported local configuration file that this installer can safely edit. The harness installer therefore builds the server and prints a ready-to-paste stdio recipe for BLACKBOX AI.

## Installer

Run the installer, reveal all harnesses if BLACKBOX AI was not detected automatically, and select **BLACKBOX AI (VS Code)**:

```bash
npm run install:harnesses -- --show-all-harnesses
```

The installer prints a recipe containing the absolute path to this checkout's built `dist/index.js`.

## Add the server in BLACKBOX AI

1. Open the BLACKBOX AI panel in VS Code.
2. Open **MCP Servers** from the controls/settings menu.
3. Add a custom `stdio` server.
4. Paste the recipe printed by the installer. If the UI asks for separate fields, use:
   - Name: `roblox-mcp`
   - Command: `node`
   - Arguments: the three values from the printed `args` array, in order
5. Reload the VS Code window, then confirm `roblox-mcp` appears in the installed MCP server list.

The recipe has this shape; use the absolute path printed on your machine:

```json
{
  "mcpServers": {
    "roblox-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/roblox-executor-mcp/dist/index.js",
        "--server-name",
        "roblox-mcp"
      ]
    }
  }
}
```

BLACKBOX AI's current MCP surface is documented in its [Visual Studio Marketplace listing](https://marketplace.visualstudio.com/items?itemName=Blackboxapp.blackbox).

## Connect Roblox

After BLACKBOX AI shows the MCP server as connected, run the loader printed by the installer in your executor. Keep the MCP server process and Roblox client on the same bridge URL.
