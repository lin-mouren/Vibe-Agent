import { spawn } from "node:child_process";
import process from "node:process";

const ROOT = process.cwd();
const API_PORT = Number(process.env.API_PORT ?? 4010);
const API_BASE_URL = process.env.API_BASE_URL ?? `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://frame2:frame2@127.0.0.1:5432/frame2?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        ...extraEnv
      }
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function startProcess(cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  return child;
}

async function waitForApi(maxTries = 60) {
  for (let i = 0; i < maxTries; i += 1) {
    try {
      const response = await fetch(`${API_BASE_URL}/healthz`);
      if (response.ok) return;
    } catch {
      // keep retrying
    }
    await sleep(1000);
  }
  throw new Error(`API did not become ready: ${API_BASE_URL}`);
}

async function main() {
  await run("pnpm", ["--filter", "@frame2/api", "prisma:generate"]);
  await run("pnpm", ["db:push"]);
  await run("pnpm", ["db:seed"]);
  await run("pnpm", ["build"]);

  const api = startProcess("node", ["apps/api/dist/src/index.js"], {
    API_HOST: "127.0.0.1",
    API_PORT: String(API_PORT),
    DATABASE_URL,
    REDIS_URL,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: "./.data/storage"
  });

  const worker = startProcess("node", ["apps/worker/dist/index.js"], {
    DATABASE_URL,
    REDIS_URL,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: "./.data/storage",
    IMAGE_PROVIDER: process.env.IMAGE_PROVIDER ?? "mock",
    IMAGE_PROVIDER_FALLBACK_TO_MOCK: process.env.IMAGE_PROVIDER_FALLBACK_TO_MOCK ?? "true"
  });

  let exited = false;
  const cleanup = () => {
    if (exited) return;
    exited = true;
    for (const child of [api, worker]) {
      if (!child.killed) child.kill("SIGTERM");
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    await waitForApi();
    await run("pnpm", ["test:smoke:m3"], { API_BASE_URL });
    await run("pnpm", ["test:smoke:m4"], { API_BASE_URL });
    await run("pnpm", ["test:smoke:m5"], { API_BASE_URL });
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
