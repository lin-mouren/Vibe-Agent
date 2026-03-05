# Frame-2 M3→M5 rollout

## Summary
This PR delivers the locked roadmap in sequence:
1. M3 platform hardening
2. M4 frame-2 interaction alignment
3. M5 productionization and CI governance

Commits:
- `9067866` feat(m3): harden platform runtime and provider pipeline
- `3352d99` feat(m4): deliver frame-2 workbench interactions and inspector UX
- `2490744` feat(m5): add ci gates, smoke automation, and runbooks

## Major changes

### M3
- Execution idempotency support on `POST /v1/executions` (`idempotencyKey`).
- High-res download content-disposition now follows actual asset mime extension.
- SSE events now include event `id`; endpoint supports `Last-Event-ID` recovery snapshot.
- Worker provider reliability:
  - OpenAI error classification (`AUTH/RATE_LIMIT/QUOTA/TIMEOUT/NETWORK/UPSTREAM/UNKNOWN`)
  - fallback-to-mock with metadata reason trail.
- Job/highres event payload enriched with retry/error fields.

### M4
- Added API endpoints:
  - `PATCH /v1/nodes/:id`
  - `GET /v1/nodes/:id/renders?executionId=&limit=&offset=&sort=`
  - `POST /v1/executions/:id/retry-failed`
- Web workbench enhancements:
  - CONTINUE action
  - retry-failed action
  - render filtering/sorting/limit controls
  - export status state machine
  - analysis evidence fields

### M5
- Added workflows:
  - `.github/workflows/ci.yml`
  - `.github/workflows/e2e-smoke.yml`
- Added operational endpoints:
  - `GET /healthz/details`
  - `GET /metrics`
- Added smoke scripts:
  - `test:smoke:m3`
  - `test:smoke:m4`
  - `test:smoke:m5`
  - `test:smoke:all` (local one-command full verification)
- Added/updated architecture and runbook docs.

## API contract updates
- `POST /v1/executions`: new optional `idempotencyKey`, `options.maxParallel`.
- `GET /v1/events`: supports `Last-Event-ID`; events carry `id`.
- `highres.updated` payload standardization (`renderId/jobId/status/downloadUrl/errorCode/errorMessage`).
- `job.updated` payload standardization (`attempt/maxAttempt/retryAt/errorCode/errorMessage`).

## Validation
Executed in this branch:
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Notes:
- In this sandbox session, runtime socket restrictions can block launching local listeners (`listen/connect EPERM`), so end-to-end smoke is intended to be validated in normal local/CI runtime.
- One-command local verification:
  - `pnpm test:smoke:all`

## Risk and rollback
- Risk: Provider/network failures (mitigated by fallback strategy and retry/error visibility).
- Rollback:
  1. Checkout previous stable `work/main` commit.
  2. Run `pnpm --filter @frame2/api prisma:generate && pnpm db:push && pnpm db:seed`.
  3. Restart services and run smoke checks.

## Post-merge checklist
- Ensure required secrets/variables in CI runtime.
- Trigger `e2e-smoke.yml` once manually after merge.
