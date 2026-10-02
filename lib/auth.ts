import { timingSafeEqual } from "node:crypto";

type Handler = (req: Request) => Promise<Response>;

// Compare two strings without leaking how many characters matched.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Wraps an MCP handler: only requests with header `x-api-key: <MCP_API_KEY>` get through.
export function withApiKey(handler: Handler): Handler {
  return async (req) => {
    const expected = process.env.MCP_API_KEY;
    if (!expected) {
      return Response.json(
        { ok: false, error_code: "SERVER_MISCONFIGURED", message: "MCP_API_KEY is not set on the server." },
        { status: 500 },
      );
    }

    const given = req.headers.get("x-api-key") ?? "";
    if (!safeEqual(given, expected)) {
      return Response.json(
        { ok: false, error_code: "UNAUTHORIZED", message: "Missing or wrong x-api-key header." },
        { status: 401 },
      );
    }

    return handler(req);
  };
}
