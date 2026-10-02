import type { McpServer } from "@modelcontextprotocol/server";
import { registerApplianceTools } from "./appliances";
import { registerCheckTools } from "./checks";
import { registerJobTools } from "./jobs";
import { registerMoneyTools } from "./money";
import { registerPeopleTools } from "./people";
import { registerPriceTools } from "./price";
import { registerTechnicianTools } from "./technicians";

// Every janus_core tool except `ping`, which lives in the route file.
export function registerJanusCoreTools(server: McpServer) {
  registerPeopleTools(server);
  registerApplianceTools(server);
  registerTechnicianTools(server);
  registerJobTools(server);
  registerMoneyTools(server);
  registerPriceTools(server);
  registerCheckTools(server);
}
