/**
 * M16B — latency harness. Subscribes to a user's PRIVATE mining channel with
 * the service role (a server-side observer, standing in for the browser),
 * records the wall-clock instant every event arrives, then optionally
 * triggers ONE routed request and prints T0..T6.
 *
 *   npm run usage:m16b:observe -- --user <uuid> [--connection <uuid> --model openai/gpt-5-nano --prompt "Reply only: LIVE" --confirm]
 *
 * Without --confirm it only listens for 60 s. It spends nothing itself; the
 * request is made by scripts/e2e-openrouter.ts, which refuses without
 * --confirm. Nothing here writes economics.
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { MINING_EVENT_NAMES, miningTopic, type MiningEvent } from "../src/lib/live/events";

const line = (t = "") => process.stdout.write(`${t}\n`);
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const userId = flag("user");
  if (!userId) throw new Error("usage: --user <uuid> [--connection <uuid> --model <id> --prompt <text> --confirm]");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false } });
  await admin.realtime.setAuth(secret);

  const received: { name: string; at: number; event: MiningEvent }[] = [];
  const channel = admin.channel(miningTopic(userId), { config: { private: true } });
  for (const name of MINING_EVENT_NAMES) {
    channel.on("broadcast", { event: name }, (message: { payload: MiningEvent }) => {
      const at = Date.now();
      received.push({ name, at, event: message.payload });
      line(`  ${new Date(at).toISOString()}  ${name.padEnd(28)} seq=${message.payload.seq} server_at=${message.payload.at} (transit ${at - message.payload.at} ms)`);
    });
  }
  const subscribed = await new Promise<boolean>((resolve) => {
    channel.subscribe((status) => {
      line(`  channel ${status}`);
      if (status === "SUBSCRIBED") resolve(true);
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") resolve(false);
    });
    setTimeout(() => resolve(false), 15_000);
  });
  if (!subscribed) {
    line("  could not subscribe to the private channel");
    return 1;
  }

  const confirmed = process.argv.includes("--confirm");
  const connection = flag("connection");
  if (confirmed && connection) {
    line();
    line("  triggering ONE routed request through scripts/e2e-openrouter.ts …");
    const args = ["--env-file-if-exists=.env.local", "--import", "tsx", "scripts/e2e-openrouter.ts", "--connection", connection, "--model", flag("model") ?? "openai/gpt-5-nano", "--prompt", flag("prompt") ?? "Reply only: LIVE", "--confirm"];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    line(out.split("\n").filter((l) => /generation id|status|usage reported|latency|signature|reward status|economic status/.test(l)).join("\n"));
  }

  // Wait for the outcome (or 60 s).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !received.some((r) => /verified|held|ineligible|failed/.test(r.name))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await admin.removeChannel(channel);

  const find = (n: string) => received.find((r) => r.name === n);
  const started = find("mining.request.started");
  const progress = find("mining.request.progress");
  const verifying = find("mining.request.verifying");
  const outcome = received.find((r) => /verified|held|ineligible/.test(r.name));
  if (!started) {
    line("  no started event observed");
    return confirmed ? 1 : 0;
  }
  const t0 = (started.event as { startedAt: number }).startedAt;
  const t1 = started.at;
  const t2 = progress ? (progress.event as { firstChunkAt: number | null }).firstChunkAt : null;
  const t3 = verifying ? (verifying.event as { terminalAt: number }).terminalAt : null;
  const t4 = outcome ? (outcome.event as { persistedAt: number }).persistedAt : null;
  const t5 = outcome?.at ?? null;
  // T6: the authoritative aggregate is readable once the same write that the
  // outcome event announced has committed; measured here as the first
  // successful read of the persisted score row after T5.
  let t6: number | null = null;
  if (outcome) {
    const day = (outcome.event as { occurredAt: string }).occurredAt.slice(0, 10);
    for (let i = 0; i < 50 && t6 === null; i += 1) {
      const { data } = await admin.from("score_records").select("points").eq("user_id", userId).eq("day", day).maybeSingle();
      if (data) t6 = Date.now();
      else await new Promise((r) => setTimeout(r, 100));
    }
  }
  line();
  line("  TIMESTAMPS (ms since epoch; T0 and T3/T4 are server clocks, T1/T5/T6 observer clocks)");
  line(`  T0 route received      ${t0}`);
  line(`  T1 observer MINING_LIVE ${t1}   activation latency T1-T0 = ${t1 - t0} ms`);
  line(`  T2 first stream chunk  ${t2 ?? "n/a"}`);
  line(`  T3 terminal usage      ${t3 ?? "n/a"}`);
  line(`  T4 unit persisted      ${t4 ?? "n/a"}`);
  line(`  T5 observer VERIFIED   ${t5 ?? "n/a"}   verification propagation T5-T3 = ${t5 !== null && t3 !== null ? t5 - t3 : "n/a"} ms`);
  line(`  T6 aggregate readable  ${t6 ?? "n/a"}   reconciliation T6-T4 = ${t6 !== null && t4 !== null ? t6 - t4 : "n/a"} ms`);
  line(`  transitions: ${received.map((r) => r.name.replace("mining.request.", "")).join(" → ")}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => { line(`Failed: ${(e as Error).message}`); process.exit(1); });
