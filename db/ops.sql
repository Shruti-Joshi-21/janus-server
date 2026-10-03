-- Operational tables that must SURVIVE a demo reset. They live in their own schema ("ops"), which
-- resetDatabase() never drops. Everything here uses IF NOT EXISTS, so running it again is harmless.

CREATE SCHEMA IF NOT EXISTS ops;

-- One row per request to any /…/mcp route: lets us prove whether Janus really called a tool.
CREATE TABLE IF NOT EXISTS ops.tool_calls (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  connector    text NOT NULL,          -- 'janus_core' | 'gnani' | 'delhivery' | …
  method       text,                   -- JSON-RPC method: tools/call, tools/list, initialize, … or 'unauthorized'
  tool         text,                   -- tool name for tools/call
  args         jsonb,                  -- tool arguments (trimmed)
  http_status  integer,
  outcome      text,                   -- 'ok' | 'failed' (ok:false) | 'error' (isError) | null
  error_code   text,
  duration_ms  integer,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS tool_calls_at_idx ON ops.tool_calls (at DESC);
