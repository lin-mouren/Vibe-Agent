# Local Runbook (M0-M5)

## 1) Prerequisites
- Node.js >= 20
- Corepack enabled (`corepack enable`)
- Docker Desktop

## 2) Install dependencies
```bash
corepack pnpm --version
pnpm install
```

## 3) Start infra
```bash
docker compose -f infra/docker-compose.yml up -d
```
如果本机已存在可用 PostgreSQL/Redis，也可跳过 docker；MVP 默认 `STORAGE_DRIVER=local`，不强依赖 MinIO。

## 4) Configure env files
```bash
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
cp apps/web/.env.local.example apps/web/.env.local
```
可选：启用真实图像 provider（默认 `mock`）
```bash
# apps/worker/.env
IMAGE_PROVIDER=openai
OPENAI_API_KEY=<your_key>
IMAGE_PROVIDER_FALLBACK_TO_MOCK=true
```

## 5) Prepare DB and seed
```bash
pnpm build:shared
pnpm --filter @frame2/api prisma:generate
pnpm db:push
pnpm db:seed
```

## 6) Start all services
```bash
pnpm dev
```

## 7) Access
- Web: `http://localhost:3000`
- API: `http://localhost:4000/healthz`
- MinIO console: `http://localhost:9001`

## 8) Basic E2E check
1. Open web, click `Add Render Node` if needed.
2. Click `Save Canvas`.
3. Click `Execute` (NODE mode).
4. Observe log panel for job updates.
5. Select node in graph and verify renders appear in Inspector.
6. Click `Export ZIP`, then use generated download link.

## 9) Milestone verification scripts
```bash
pnpm typecheck
pnpm test
pnpm test:smoke:m3
pnpm test:smoke:m4
pnpm test:smoke:m5
```

## 10) M5 health endpoints
- `GET /healthz/details`
- `GET /metrics`
