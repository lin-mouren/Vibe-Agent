# Frame-2 Roadmap Architecture (M3-M5)

## Milestone goals
- M3: platform hardening (provider reliability, queue semantics, idempotent execution, machine-readable errors, test baseline).
- M4: frame-2 interaction alignment (node patch API, render pagination/filter, retry-failed flow, inspector evidence).
- M5: production readiness (CI gates, metrics/health details, structured logs, smoke automation).

## Interface deltas
- `POST /v1/executions`
  - adds optional `idempotencyKey`
  - supports `options.maxParallel`
- `PATCH /v1/nodes/:id`
  - partial node updates without full-canvas overwrite
- `GET /v1/nodes/:id/renders`
  - supports `executionId`, `limit`, `offset`, `sort`
- `POST /v1/executions/:id/retry-failed`
  - re-enqueues failed jobs for selected execution
- `GET /v1/events`
  - supports `Last-Event-ID` and emits SSE `id` field
- `GET /healthz/details`
  - composite dependency health check
- `GET /metrics`
  - Prometheus text metrics

## Execution and queue semantics
- Execution create can be idempotent by `(canvasId, idempotencyKey)` lookup.
- Cancellation updates DB state and attempts queue-side removal for waiting/retrying jobs.
- Retry-failed creates new jobs with copied payload and resets execution to `RUNNING`.
- Worker publishes enriched status events (`attempt`, `maxAttempt`, `retryAt`, structured error fields).

## Provider reliability model
- Image provider abstraction in worker supports `mock` and `openai`.
- OpenAI errors are classified into `AUTH | RATE_LIMIT | QUOTA | TIMEOUT | NETWORK | UPSTREAM | UNKNOWN`.
- Optional fallback to mock with reason recorded in asset/job metadata.
- Browser remains provider-key blind; all provider IO is server-side only.

## Observability model
- API emits request completion logs with `requestId`.
- Worker emits structured log lines with job/execution context.
- Metrics include queue depth and execution status counts.

## Test and verification baseline
- Type check: `pnpm typecheck`
- Unit/integration: `pnpm test`
- Smoke suites:
  - `pnpm test:smoke:m3`
  - `pnpm test:smoke:m4`
  - `pnpm test:smoke:m5`
