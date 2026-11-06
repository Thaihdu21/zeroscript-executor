import type { WebSocket } from "ws";
import { handleRobloxResponse } from "../../bridge/handlers/shared/communication.js";
import {
  getClientIdByWs,
  registerClient,
  unregisterClient,
} from "../../bridge/handlers/shared/registry.js";
import type { RobloxResponse } from "../../bridge/types.js";

interface RegisterMessage {
  type: "register";
  username?: string;
  userId?: number;
  placeId?: number;
  jobId?: string;
  placeName?: string;
  sessionId?: string;
}

export function WS(ws: WebSocket): void {
  console.error("[Primary] Roblox client connected via WebSocket (awaiting registration).");

  ws.on("message", (rawData) => {
    try {
      const data = JSON.parse(rawData.toString()) as RegisterMessage | RobloxResponse;

      if ((data as RegisterMessage).type === "register") {
        const info = data as RegisterMessage;
        const clientId = registerClient({
          username: info.username || "Unknown",
          userId: info.userId || 0,
          placeId: info.placeId || 0,
          jobId: info.jobId || "",
          placeName: info.placeName || "Unknown",
          sessionId: info.sessionId,
          transport: "ws",
          ws,
        });
        ws.send(JSON.stringify({ type: "registered", clientId }));
        return;
      }

      handleRobloxResponse(data as RobloxResponse);
    } catch (e) {
      console.error("[Primary] Error parsing Roblox WS message:", e);
    }
  });

  ws.on("close", () => {
    const clientId = getClientIdByWs(ws);
    if (clientId) unregisterClient(clientId);
    console.error("[Primary] Roblox client disconnected.");
  });
}
