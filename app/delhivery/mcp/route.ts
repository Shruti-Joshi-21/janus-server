import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { registerDelhiveryTools } from "@/lib/delhivery/tools";

// The delhivery_janus MCP server: a mock of Delhivery Maps (see lib/delhivery/ and MOCKS.md).
const mcpHandler = createMcpHandler(
  (server) => {
    registerDelhiveryTools(server);
  },
  { serverInfo: { name: "delhivery_janus", version: "0.1.0" } },
);

const handler = withApiKey(mcpHandler);

export { handler as GET, handler as POST, handler as DELETE };
