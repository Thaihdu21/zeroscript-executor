export const serverStartTime = Date.now();
export const WS_PORT = 16384;

export const HTTP_POLL_TIMEOUT = 10000;
export const PROMOTION_JITTER_MAX = 300;
export const TOOL_RESPONSE_TIMEOUT = 15000;

const args = process.argv.slice(2);
const baseUrlIdx = args.indexOf("--baseurl");
export const BASE_URL: string | null =
  baseUrlIdx !== -1 ? (args[baseUrlIdx + 1] ?? null) : null;

const serverNameIdx = args.indexOf("--server-name");
export const SERVER_NAME =
  serverNameIdx !== -1 && args[serverNameIdx + 1]
    ? args[serverNameIdx + 1]
    : process.env.ROBLOX_MCP_SERVER_NAME || "roblox-mcp";

if (BASE_URL) {
  console.error(
    `[Config] --baseurl specified: ${BASE_URL} (will run as secondary relay to this host)`,
  );
}
