import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerApplianceTools } from "./appliances";
import { registerCheckTools } from "./checks";
import { registerDemoTools } from "./demo";
import { registerInboundTools } from "./inbound";
import { registerJobTools } from "./jobs";
import { registerMoneyTools } from "./money";
import { registerPeopleTools } from "./people";
import { registerPriceTools } from "./price";
import { registerTechnicianTools } from "./technicians";

// Health check for the connector. Kept as originally built in M1 (registered directly, not via addTool).
export function registerPing(server: McpServer) {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check for the janus_core connector. Returns ok:true and the server time.",
      inputSchema: z.object({}),
    },
    async () => {
      const result = { ok: true, server: "janus_core", time: new Date().toISOString() };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}

// Every janus_core tool except `ping` (registerPing above).
export function registerJanusCoreTools(server: McpServer) {
  registerPeopleTools(server);
  registerApplianceTools(server);
  registerTechnicianTools(server);
  registerJobTools(server);
  registerMoneyTools(server);
  registerPriceTools(server);
  registerCheckTools(server);
  registerDemoTools(server);
  registerInboundTools(server);
}
