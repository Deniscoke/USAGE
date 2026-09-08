import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output of the miner workspace: a generated CommonJS bundle, and a
    // vendored Node runtime. It has its own typecheck; linting the artifact is
    // linting the compiler.
    "miner/dist/**",
  ]),
]);

export default eslintConfig;
