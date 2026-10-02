import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { withApiKey } from "@/lib/auth";
import { registerJanusCoreTools } from "@/lib/janus-core";

// The janus_core MCP server: Janus's own database tools (see lib/janus-core/).
const mcpHandler = createMcpHandler(
  (server) => {
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

    registerJanusCoreTools(server);
  },
  { serverInfo: { name: "janus_core", version: "0.1.0" } },
);

const handler = withApiKey(mcpHandler);

export { handler as GET, handler as POST, handler as DELETE };
