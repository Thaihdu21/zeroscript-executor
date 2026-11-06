#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { boot } from "./bridge/boot.js";
import { registerAllTools } from "./tools/index.js";
import { installServerLogCapture } from "./http/server-logs.js";
import { registerLocalDecompilerLifetime } from "./decompiler/local-process-lifetime.js";

// Install log capture early so all console.error calls are buffered.
installServerLogCapture();
registerLocalDecompilerLifetime();

// Import config for CLI arg parsing and startup logging.
import { SERVER_NAME } from "./config.js";

const server = new McpServer(
  {
    name: SERVER_NAME,
    version: "2.0.0",
    description:
      "Expose MCP tools for inspecting, executing Luau in, and interacting with connected Roblox game clients. Dashboard: http://localhost:16384/.",
  },
  {
    instructions: [
      "Roblox executor MCP server. Recommended workflow to keep results small and accurate:",
      "1. If multiple clients may be connected, call list-clients then set-active-client before anything else.",
      "2. Explore structure cheaply first: get-descendants-tree (summaryOnly) or search-instances with a tight selector and low limit; widen only when needed.",
      "3. Find code with script-grep (exact identifiers/regex) or semantic-search-scripts (behavior); then read just the relevant range with get-script-content (use startLine/endLine).",
      "4. Use get-data-by-code only for small, targeted value probes — prefer the specialized inspection tools above, and have the returned code return compact values, never whole instances or large tables.",
      "5. After execute / execute-file, verify effects with a small get-console-output (low limit) or a targeted get-data-by-code probe.",
      "6. Keep tool outputs lean: prefer summaryOnly, filters, and low limits; only raise maxOutputChars when a single result truly needs it. Large/raw outputs degrade reasoning quality.",
      "7. For remote spying, use remote-spy with operation=list first. Start with summaryOnly=true and a low limit; narrow by name before requesting call arguments or changing block/ignore state.",
    ].join("\n"),
  }
);

registerAllTools(server);

const transport = new StdioServerTransport();
server.connect(transport);
console.error("MCP Server started and connected via stdio.");

void boot();
