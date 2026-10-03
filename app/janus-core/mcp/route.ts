import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { withCallLog } from "@/lib/calllog";
import { registerJanusCoreTools, registerPing } from "@/lib/janus-core";

// The janus_core MCP server: Janus's own database tools (see lib/janus-core/).
const mcpHandler = createMcpHandler(
  (server) => {
    registerPing(server);
    registerJanusCoreTools(server);
  },
  { serverInfo: { name: "janus_core", version: "0.1.0" } },
);

// Every request is recorded in ops.tool_calls (see npm run calls), including rejected ones.
const handler = withCallLog("janus_core", withApiKey(mcpHandler));

export { handler as GET, handler as POST, handler as DELETE };
