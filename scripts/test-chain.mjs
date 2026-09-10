// Runs the whole suite on the migration chain PLUS supabase/pending/*.sql,
// so a prepared migration is exercised by every test before approval.
import { spawnSync } from "node:child_process";
const result = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, USAGE_TEST_PENDING: "1" },
});
process.exit(result.status ?? 1);
