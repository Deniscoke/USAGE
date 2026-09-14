import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";

/**
 * Migration 0027: the second factor enforced in RLS, not only in the app.
 *
 * The threat is a stolen password on an account that has 2FA. The password
 * alone yields an aal1 Supabase session, and that session can talk to
 * PostgREST directly, skipping every page and route check. These tests prove
 * the database itself answers it nothing -- while an account without a factor
 * keeps reading exactly what it read before.
 */

let db: TestDb;
let guarded: string;
let plain: string;
let pending: string;

beforeAll(async () => {
  db = await createTestDb();
  guarded = await db.createUser("mfa-guarded@example.com");
  plain = await db.createUser("mfa-plain@example.com");
  pending = await db.createUser("mfa-pending@example.com");
  await db.sql(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [guarded]);
  // Enrolment started but never confirmed: not a factor yet.
  await db.sql(`insert into auth.mfa_factors (user_id, status) values ($1, 'unverified')`, [pending]);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

const ownProfile = `select id from profiles`;

describe("second factor in RLS", () => {
  it("leaves an account without a factor exactly as it was", async () => {
    expect(await db.asUserWithClaims(plain, { aal: "aal1" }, ownProfile)).toHaveLength(1);
    expect(await db.asUser(plain, ownProfile)).toHaveLength(1);
  });

  it("does not count an enrolment that was never verified", async () => {
    expect(await db.asUserWithClaims(pending, { aal: "aal1" }, ownProfile)).toHaveLength(1);
  });

  it("answers a password-only session on a 2FA account with nothing", async () => {
    expect(await db.asUserWithClaims(guarded, { aal: "aal1" }, ownProfile)).toHaveLength(0);
    expect(await db.asUserWithClaims(guarded, { aal: "aal1" }, `select id from miner_devices`)).toHaveLength(0);
  });

  it("fails closed when the token carries no assurance level", async () => {
    expect(await db.asUser(guarded, ownProfile)).toHaveLength(0);
  });

  it("serves a session that passed its factor", async () => {
    expect(await db.asUserWithClaims(guarded, { aal: "aal2" }, ownProfile)).toHaveLength(1);
  });

  it("never lets a passed factor reach somebody else's rows", async () => {
    const rows = await db.asUserWithClaims<{ id: string }>(guarded, { aal: "aal2" }, `select id from profiles`);
    expect(rows.map((row) => row.id)).toEqual([guarded]);
  });

  it("keeps public reference tables readable mid-sign-in", async () => {
    const aal1 = await db.asUserWithClaims(guarded, { aal: "aal1" }, `select 1 from protocol_pricing_versions`);
    const service = await db.asServiceRole(`select 1 from protocol_pricing_versions`);
    expect(aal1).toHaveLength(service.length);
  });

  it("covers every public table with a per-user policy", async () => {
    // A later migration that adds a per-user table without the restrictive
    // policy fails here instead of quietly reopening the gap.
    const uncovered = await db.sql<{ tablename: string }>(`
      select distinct p.tablename
      from pg_policies p
      where p.schemaname = 'public'
        and (coalesce(p.qual, '') ilike '%auth.uid()%' or coalesce(p.with_check, '') ilike '%auth.uid()%')
        and not exists (
          select 1 from pg_policies r
          where r.schemaname = 'public'
            and r.tablename = p.tablename
            and r.policyname = 'require second factor'
            and r.permissive = 'RESTRICTIVE'
        )
    `);
    expect(uncovered).toEqual([]);
    const covered = await db.sql(`select 1 from pg_policies where policyname = 'require second factor'`);
    expect(covered.length).toBeGreaterThanOrEqual(10);
  });

  it("does not expose the check to anonymous callers", async () => {
    await expect(db.asAnon(`select public.session_satisfies_second_factor()`)).rejects.toThrow(/permission denied/i);
  });
});
