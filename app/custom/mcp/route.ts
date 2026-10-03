import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { withCallLog } from "@/lib/calllog";
import { registerCustomTools } from "@/lib/custom/tools";

// The janus_custom MCP server: the 3 custom capabilities (see lib/custom/tools.ts).
const mcpHandler = createMcpHandler(
  (server) => {
    registerCustomTools(server);
  },
  { serverInfo: { name: "janus_custom", version: "0.1.0" } },
);

// Every request is recorded in ops.tool_calls (see npm run calls), including rejected ones.
const handler = withCallLog("custom", withApiKey(mcpHandler));

export { handler as GET, handler as POST, handler as DELETE };
