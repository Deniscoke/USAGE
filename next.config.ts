import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next does not walk up to an unrelated lockfile.
  turbopack: { root: path.resolve(process.cwd()) },
};

export default nextConfig;
