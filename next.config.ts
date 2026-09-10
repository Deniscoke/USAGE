import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next does not walk up to an unrelated lockfile.
  turbopack: { root: path.resolve(process.cwd()) },
  // A build identifier for client diagnostics (M16B.1). Public and harmless.
  env: { NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "local" },
};

export default nextConfig;
