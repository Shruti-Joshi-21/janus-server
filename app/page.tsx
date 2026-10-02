export default function Home() {
  return (
    <main>
      <h1>Janus server</h1>
      <p>This app hosts the MCP connectors Janus calls. There is nothing to see here in a browser.</p>
      <ul>
        <li>
          <code>/api/health</code> — health check
        </li>
        <li>
          <code>/janus-core/mcp</code> — janus_core MCP server (needs <code>x-api-key</code> header)
        </li>
      </ul>
    </main>
  );
}
