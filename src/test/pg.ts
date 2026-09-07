import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

/**
 * Test harness: a real Postgres (PGlite, in-process WASM) with the project's
 * actual migrations applied.
 *
 * Why not mock the database? RLS is the security boundary of this milestone.
 * A mock proves nothing about it. PGlite runs the same policies Postgres will,
 * with no Docker required, so `user A cannot read user B` is a real assertion.
 *
 * The only thing PGlite lacks is Supabase's managed `auth` schema and roles, so
 * we recreate the parts our schema depends on -- exactly what the Supabase
 * platform provides in front of the same migrations.
 */

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Mirrors the columns our schema and trigger actually touch.
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

-- Supabase resolves the current user from the request JWT claims GUC.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::json ->> 'sub',
      current_setting('request.jwt.claim.sub', true)
    ),
    ''
  )::uuid;
$$;
`;

export interface TestDb {
  /** Runs as the migration owner. Bypasses RLS: setup only. */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** Runs as a signed-in end user: role `authenticated` + their uid claim. */
  asUser<T = Record<string, unknown>>(userId: string, query: string, params?: unknown[]): Promise<T[]>;
  /** Runs as trusted server-side ingestion. */
  asServiceRole<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** Creates an auth user (firing the profile trigger) and returns its id. */
  createUser(email: string): Promise<string>;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const db = await PGlite.create({ extensions: { pgcrypto } });

  await db.exec(`create extension if not exists "pgcrypto";`);
  await db.exec(SUPABASE_SHIM);

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }

  async function asRole<T>(
    role: string,
    userId: string | null,
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return db.transaction(async (tx) => {
      await tx.exec(`set local role ${role};`);
      if (userId) {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: userId, role }),
        ]);
      }
      const result = await tx.query<T>(query, params);
      return result.rows;
    });
  }

  return {
    async sql<T>(query: string, params: unknown[] = []) {
      return (await db.query<T>(query, params)).rows;
    },
    asUser: (userId, query, params) => asRole("authenticated", userId, query, params ?? []),
    asServiceRole: (query, params) => asRole("service_role", null, query, params ?? []),
    async createUser(email: string) {
      const rows = await db.query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [email],
      );
      return rows.rows[0].id;
    },
    close: () => db.close(),
  };
}
