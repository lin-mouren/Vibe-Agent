# M3-M5 Delivery Status

## M3 Platform Hardening
Done:
- Execution idempotency contract (`idempotencyKey`) at API layer.
- High-res download filename/content-type alignment.
- SSE event id and Last-Event-ID recovery snapshot.
- Provider error taxonomy + fallback metadata.
- Enriched job/highres event payload fields (`attempt`, `maxAttempt`, `retryAt`, `errorCode`, `errorMessage`).

Validation:
- `pnpm typecheck` passed.
- `pnpm test` passed (API + provider tests).

## M4 Frame-2 Interaction Alignment
Done:
- `PATCH /v1/nodes/:id`
- `GET /v1/nodes/:id/renders` query filters (`executionId`, `limit`, `offset`, `sort`)
- `POST /v1/executions/:id/retry-failed`
- Web workbench enhancements:
  - CONTINUE action
  - Retry failed action
  - Render filter/sort/limit controls
  - Export status machine
  - Analysis evidence panel

Validation:
- Type and test gates above cover API/front-end compilation and integration smoke units.

## M5 Productionization
Done:
- CI workflow (`.github/workflows/ci.yml`)
- Scheduled/manual smoke workflow (`.github/workflows/e2e-smoke.yml`)
- Health detail endpoint (`/healthz/details`)
- Metrics endpoint (`/metrics`)
- Structured log fields for API/worker
- Required/optional env classification in examples/docs
- M3-M5 runbook and architecture docs

Validation:
- Workflow YAML and scripts added.
- Build chain stabilized to sequential mode to avoid intermittent Next.js parallel build failures.

## Smoke caveat in this sandbox session
- Local end-to-end smoke (`test:smoke:m3/m4/m5`) could not be executed inside this sandbox due runtime socket restrictions (`listen/connect EPERM`) when starting API/worker processes.
- Added one-command local verifier for your machine:
  - `pnpm test:smoke:all`

