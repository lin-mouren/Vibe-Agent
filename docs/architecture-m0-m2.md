# Frame-2 MVP Architecture (M0-M2)

> M3-M5 evolution is documented in `docs/architecture-m3-m5.md`.

## Scope
- Three-pane workbench (Controls, Graph, Inspector).
- Render-grid execution pipeline with queue fan-out.
- Continuity mode, SSE updates, ZIP export.
- Inspector `PROPERTIES / AI_ANALYSIS` tabs with metadata and heuristic scoring.
- Async high-res pipeline: `POST /v1/renders/:id/highres` + `highres.updated` SSE + `GET /v1/renders/:id/highres`.

## Runtime topology
- `apps/web` (Next.js): UI and orchestration.
- `apps/api` (Fastify): CRUD, execution orchestration, SSE.
- `apps/worker` (BullMQ): render and export jobs.
- `PostgreSQL`: state and metadata.
- `Redis`: queue + pub/sub.
- `MinIO` (or local storage fallback): binary assets and exports.

## Core flow
1. UI creates/edits nodes and edges in a canvas.
2. UI triggers `/v1/executions` with mode `NODE|GRAPH|CONTINUITY`.
3. API writes execution + jobs and enqueues BullMQ jobs.
4. Worker renders cells, stores assets, writes renders, updates job state.
5. Worker publishes events to Redis channels.
6. API SSE endpoint streams those events to web clients.
7. UI inspector refreshes renders and metadata in near real-time.

## Data consistency
- Canvas uses optimistic versioning via `canvas.version`.
- Execution is terminal only when no active jobs remain.
- Node status derives from node-scoped jobs in an execution.

## Provider model
- Browser never calls model providers directly.
- Worker uses pluggable image providers via `IMAGE_PROVIDER` (`mock` by default, `openai` optional).
- Provider adapter boundary is centralized in `apps/worker/src/lib/image-provider.ts`.
- Provider failures can optionally degrade to mock via `IMAGE_PROVIDER_FALLBACK_TO_MOCK=true`.
