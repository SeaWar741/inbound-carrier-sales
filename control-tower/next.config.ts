import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The tower sits inside the adapter repo, which has its own lockfile; pin the root to this app.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // next dev would otherwise write AGENTS.md and CLAUDE.md into the app.
  agentRules: false,
};

export default nextConfig;
