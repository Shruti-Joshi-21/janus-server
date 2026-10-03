import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { withCallLog } from "@/lib/calllog";
import { registerAllTools, TOOL_GROUP_OF } from "@/lib/registry";

// The combined janus MCP server: every tool from every group (janus_core, gnani, delhivery, pinelabs, custom,
// whatsapp) on ONE connector, because AgenticOrg only accepts MCP tools from a single connector per agent.
// Tools are registered by the same functions the individual routes use, so they behave identically.
const mcpHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  { serverInfo: { name: "janus", version: "1.0.0" } },
);

// Each call is logged under its tool's group, so partners stay distinguishable in `npm run calls`.
const handler = withCallLog((tool) => (tool ? (TOOL_GROUP_OF.get(tool) ?? "janus") : "janus"), withApiKey(mcpHandler));

export { handler as GET, handler as POST, handler as DELETE };
