import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The tower sits inside the adapter repo, which has its own lockfile; pin the root to this app.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  // next dev would otherwise write AGENTS.md and CLAUDE.md into the app.
  agentRules: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No framing (clickjacking on the hold buttons), no plugins, no foreign base or form targets.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // The microphone is for taking over a call; nothing else is used.
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)" },
        ],
      },
    ];
  },
};

export default nextConfig;
