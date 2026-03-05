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

## M6 RC release closure (strict gate)
Gate workflow:
```bash
gh workflow run release-rc.yml \
  --repo lin-mouren/Vibe-Agent \
  --ref work/main \
  -f rc_tag=rc/m6-YYYYMMDD.N \
  -f run_openai_canary=false
```

Local equivalent gate:
```bash
pnpm release:rc:check
```

Generate local audit files:
```bash
RC_TAG=rc/m6-YYYYMMDD.N pnpm release:rc:evidence
```

After gate pass, create RC tag manually on `work/main`:
```bash
git fetch --prune origin
git switch work/main
git pull --rebase origin work/main
git tag -a rc/m6-YYYYMMDD.N -m "M6 RC gate passed"
git push origin rc/m6-YYYYMMDD.N
```

Detailed release closure guide:
- `docs/release-m6-rc.md`

Canary troubleshooting (non-blocking in M6):
- If `RC Gate (Optional OpenAI Canary)` fails with runner acquisition issues (e.g. hosted runner not acquired), do not block M6 GO.
- If workflow dispatch returns HTTP 500 from GitHub API, treat it as platform transient and retry later (do not mutate release conclusion based on dispatch infrastructure errors).
- Record the incident in release docs and retrigger a canary-only validation run later:
```bash
gh workflow run release-rc.yml \
  --repo lin-mouren/Vibe-Agent \
  --ref work/main \
  -f rc_tag=rc/m6-YYYYMMDD.N \
  -f run_openai_canary=true
```

Retry helper for dispatch 500 / EOF windows:
```bash
pnpm release:rc:dispatch-retry -- --rc-tag rc/m6-YYYYMMDD.N --run-openai-canary true --attempts 6 --sleep-seconds 30
```
