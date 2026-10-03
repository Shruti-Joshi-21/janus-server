import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { withCallLog } from "@/lib/calllog";
import { registerDelhiveryTools } from "@/lib/delhivery/tools";

// The delhivery_janus MCP server: a mock of Delhivery Maps (see lib/delhivery/ and MOCKS.md).
const mcpHandler = createMcpHandler(
  (server) => {
    registerDelhiveryTools(server);
  },
  { serverInfo: { name: "delhivery_janus", version: "0.1.0" } },
);

// Every request is recorded in ops.tool_calls (see npm run calls), including rejected ones.
const handler = withCallLog("delhivery", withApiKey(mcpHandler));

export { handler as GET, handler as POST, handler as DELETE };
