// `npm run send:test -- +918530921384 "Test from Janus server"`             → sends through the LIVE server
// `npm run send:test -- +918530921384 "Test" http://localhost:3000`          → through a local server
// Sends ONE real WhatsApp message via the send_whatsapp tool, then checks its delivery status.
const [to, body, base = "https://janus-server.vercel.app"] = process.argv.slice(2);
if (!to || !body) {
  console.error('Usage: npm run send:test -- <phone> "<message>" [base-url]');
  process.exit(1);
}

async function call(name: string, args: Record<string, unknown>) {
  // The combined route, the one Janus uses on AgenticOrg.
  const res = await fetch(`${base}/janus/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": process.env.MCP_API_KEY!, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`HTTP ${res.status} from ${base}`);
  return JSON.parse(line.slice(6)).result.structuredContent;
}

async function main() {
  console.log(`Sending to ${to} via ${base} …`);
  const sent = await call("send_whatsapp", { to, body });
  console.log("send_whatsapp:", sent);
  if (!sent.ok) process.exit(1);
  await new Promise((r) => setTimeout(r, 5000));
  const status = await call("get_message_status", { message_sid: sent.message_sid });
  console.log("get_message_status after 5 s:", status);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
