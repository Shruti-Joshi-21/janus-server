import { createMcpHandler } from "mcp-handler";
import { withApiKey } from "@/lib/auth";
import { withCallLog } from "@/lib/calllog";
import { registerPineLabsTools } from "@/lib/pinelabs/tools";

// The pinelabs_janus MCP server: a mock of Pine Labs One-Time Mandate, UPI AutoPay and Payouts (see MOCKS.md).
const mcpHandler = createMcpHandler(
  (server) => {
    registerPineLabsTools(server);
  },
  { serverInfo: { name: "pinelabs_janus", version: "0.1.0" } },
);

// Every request is recorded in ops.tool_calls (see npm run calls), including rejected ones.
const handler = withCallLog("pinelabs", withApiKey(mcpHandler));

export { handler as GET, handler as POST, handler as DELETE };
