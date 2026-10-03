import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // reset_demo_data reads these SQL files at runtime, so ship them with the janus-core function.
  outputFileTracingIncludes: {
    "/janus-core/mcp": ["./db/schema.sql", "./db/seed.sql", "./db/ops.sql"],
  },
};

export default nextConfig;
