import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { withCallLog } from "@/lib/calllog";
import { registerWhatsAppTools } from "@/lib/whatsapp/tools";

// The whatsapp_janus MCP server: real outgoing WhatsApp messages and calls through Twilio (see lib/whatsapp/).
const mcpHandler = createMcpHandler(
  (server) => {
    registerWhatsAppTools(server);
  },
  { serverInfo: { name: "whatsapp_janus", version: "0.1.0" } },
);

// Every request is recorded in ops.tool_calls (see npm run calls), including rejected ones.
const handler = withCallLog("whatsapp", withApiKey(mcpHandler));

export { handler as GET, handler as POST, handler as DELETE };
