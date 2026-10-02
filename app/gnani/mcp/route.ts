import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { registerGnaniTools } from "@/lib/gnani/tools";

// The gnani_janus MCP server: real Gnani speech-to-text and text-to-speech (see lib/gnani/).
const mcpHandler = createMcpHandler(
  (server) => {
    registerGnaniTools(server);
  },
  { serverInfo: { name: "gnani_janus", version: "0.1.0" } },
);

const handler = withApiKey(mcpHandler);

export { handler as GET, handler as POST, handler as DELETE };
