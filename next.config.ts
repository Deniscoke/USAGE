import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next does not walk up to an unrelated lockfile.
  turbopack: { root: path.resolve(process.cwd()) },
  // A build identifier for client diagnostics (M16B.1). Public and harmless.
  env: { NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "local" },
  // The download page used to live behind the app nav at /miners/install, which
  // meant the official way to get the miner was a page you reached by already
  // having an account. /download is the public one (M16D). The old path keeps
  // working because it has been linked to.
  async redirects() {
    return [{ source: "/miners/install", destination: "/download", permanent: true }];
  },
  // Headers that cannot break a page. The site had HSTS and nothing else, so
  // any other site could frame the sign-in, wallet or 2FA screens and overlay
  // them. A full Content-Security-Policy is deliberately not here: it needs
  // testing against Supabase, Vercel and the chat stream before it can be
  // enforced without breaking something.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
