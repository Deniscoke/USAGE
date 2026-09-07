# USAGE

**Proof of AI Usage.** See, verify and own your AI usage history.

USAGE reads AI consumption from providers, gateways and developer tools,
normalizes it into one record shape, weights it by how strongly it can be
verified, and turns that into a Proof of Usage score and epoch rewards paid in
off-chain USAGE Points.

Usage is stored in Postgres behind Supabase Auth and row level security.
Real provider integrations are not implemented yet: development uses
deterministic demo adapters that run through the same ingestion pipeline.

```bash
npm install
npm run db:start          # local Supabase stack (requires Docker)
cp .env.example .env.local   # fill in the values db:start prints
npm run db:reset          # apply migrations + seed
npm run dev               # http://localhost:3000
```

| Command | |
| --- | --- |
| `npm test` | unit tests + Postgres integration tests (no Docker needed) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run build` | production build |
| `npm run db:start` / `db:stop` / `db:reset` | local Supabase stack |
| `npm run db:types` | regenerate database types from the local stack |
| `npm run usage:gateway:probe` | dry run of the AI Gateway probe (costs nothing) |

Docs: [`docs/PRODUCT.md`](docs/PRODUCT.md) ·
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/STATE.md`](docs/STATE.md) · [`CLAUDE.md`](CLAUDE.md)

USAGE Points are off-chain, non-transferable, and carry no monetary value.
