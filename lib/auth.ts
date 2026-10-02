import { timingSafeEqual } from "node:crypto";

type Handler = (req: Request) => Promise<Response>;

// Compare two strings without leaking how many characters matched.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Platforms differ in where they put an API key, so accept the usual places:
// `x-api-key: K`, `api-key: K`, `Authorization: Bearer K`, or `Authorization: K`.
function keysFromRequest(req: Request): string[] {
  const keys: string[] = [];
  for (const name of ["x-api-key", "api-key"]) {
    const value = req.headers.get(name);
    if (value) keys.push(value.trim());
  }
  const authz = req.headers.get("authorization");
  if (authz) {
    keys.push(authz.trim());
    const match = authz.match(/^(Bearer|Token|ApiKey|Api-Key)\s+(.+)$/i);
    if (match) keys.push(match[2].trim());
  }
  return keys;
}

// Wraps an MCP handler: only requests carrying MCP_API_KEY (see keysFromRequest) get through.
export function withApiKey(handler: Handler): Handler {
  return async (req) => {
    const expected = process.env.MCP_API_KEY;
    if (!expected) {
      return Response.json(
        { ok: false, error_code: "SERVER_MISCONFIGURED", message: "MCP_API_KEY is not set on the server." },
        { status: 500 },
      );
    }

    const given = keysFromRequest(req);
    if (!given.some((key) => safeEqual(key, expected))) {
      // Log header NAMES only (never values) so we can see where a client put its key.
      const authz = req.headers.get("authorization");
      console.warn("[auth] rejected", req.method, new URL(req.url).pathname, {
        headerNames: [...req.headers.keys()],
        authorizationScheme: authz ? (authz.match(/^(Bearer|Token|Basic|ApiKey|Api-Key)\s/i)?.[1] ?? "(none)") : null,
      });
      return Response.json(
        { ok: false, error_code: "UNAUTHORIZED", message: "Missing or wrong API key." },
        { status: 401 },
      );
    }

    return handler(req);
  };
}
