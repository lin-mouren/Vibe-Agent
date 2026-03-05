# Runbook (M3-M5)

## Environment contract
Required:
- `DATABASE_URL`
- `REDIS_URL`

Optional:
- `STORAGE_DRIVER` (`local` or `s3`, default `local`)
- `LOCAL_STORAGE_DIR`
- `IMAGE_PROVIDER` (`mock` or `openai`, default `mock`)
- `IMAGE_PROVIDER_FALLBACK_TO_MOCK` (default `true`)
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_IMAGE_MODEL`, `OPENAI_TIMEOUT_MS` (only when `IMAGE_PROVIDER=openai`)

## Local startup
```bash
pnpm install
pnpm --filter @frame2/api prisma:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

## Verification order
```bash
pnpm typecheck
pnpm test
pnpm test:smoke:m3
pnpm test:smoke:m4
pnpm test:smoke:m5
```

一键本地端到端（自动启动 API/Worker 再跑 smoke）：
```bash
pnpm test:smoke:all
```

## Runtime health checks
```bash
curl -sS http://localhost:4000/healthz
curl -sS http://localhost:4000/healthz/details
curl -sS http://localhost:4000/metrics
```

## Rollback procedure
1. Checkout previous known-good commit on `work/main`.
2. Re-run schema sync and seed:
```bash
pnpm --filter @frame2/api prisma:generate
pnpm db:push
pnpm db:seed
```
3. Restart services and verify with smoke scripts.

## Break-glass note
- `main` remains mirror-only and must not receive feature commits.
- Any `main` history rewrite follows `docs/git-mirror-runbook.md` break-glass only.
