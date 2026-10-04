// Every tool group, registered by the SAME functions the individual routes use. /janus/mcp serves them all
// from one connector, because AgenticOrg validates an agent's MCP tools against only one connector's catalogue.
import type { McpServer } from "@modelcontextprotocol/server";
import { registerCustomTools } from "./custom/tools";
import { registerDelhiveryTools } from "./delhivery/tools";
import { registerGnaniTools } from "./gnani/tools";
import { registerJanusCoreTools, registerPing } from "./janus-core";
import { registerPineLabsTools } from "./pinelabs/tools";
import { registerStepTools } from "./steps/tools";
import { registerWhatsAppTools } from "./whatsapp/tools";

export const TOOL_GROUPS: [group: string, register: (server: McpServer) => void][] = [
  ["janus_core", (server) => { registerPing(server); registerJanusCoreTools(server); }],
  ["gnani", registerGnaniTools],
  ["delhivery", registerDelhiveryTools],
  ["pinelabs", registerPineLabsTools],
  ["custom", registerCustomTools],
  ["whatsapp", registerWhatsAppTools],
  ["steps", registerStepTools], // only on /janus/mcp (the combined connector)
];

// Registers every group on `server` and returns tool name → group. Throws if two groups use the same tool name.
export function registerAllTools(server: McpServer): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [group, register] of TOOL_GROUPS) {
    const tracking = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "registerTool") {
          return (name: string, ...rest: unknown[]) => {
            if (owner.has(name)) throw new Error(`Duplicate tool name "${name}" in groups "${owner.get(name)}" and "${group}"`);
            owner.set(name, group);
            return (target.registerTool as (...a: unknown[]) => unknown)(name, ...rest);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    register(tracking);
  }
  return owner;
}

// Tool name → group, worked out once without a real server (also runs the duplicate check at startup).
export const TOOL_GROUP_OF: Map<string, string> = registerAllTools({ registerTool: () => undefined } as unknown as McpServer);
