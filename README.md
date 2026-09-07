# USAGE

**Proof of AI Usage.** See, verify and own your AI usage history.

USAGE reads AI consumption from providers, gateways and developer tools,
normalizes it into one record shape, weights it by how strongly it can be
verified, and turns that into a Proof of Usage score and epoch rewards paid in
off-chain USAGE Points.

Currently running on deterministic demo data — no provider account required.

```bash
npm install
npm run dev     # http://localhost:3000
```

| Command | |
| --- | --- |
| `npm test` | unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm run build` | production build |

Docs: [`docs/PRODUCT.md`](docs/PRODUCT.md) ·
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/STATE.md`](docs/STATE.md) · [`CLAUDE.md`](CLAUDE.md)

USAGE Points are off-chain, non-transferable, and carry no monetary value.
