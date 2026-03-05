const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const CANVAS_ID = process.env.DEFAULT_CANVAS_ID ?? "00000000-0000-0000-0000-000000000001";
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS ?? 2000);
const MAX_TRIES = Number(process.env.SMOKE_MAX_TRIES ?? 45);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(url, init) {
  const response = await fetch(url, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} ${url}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function pollExecution(executionId) {
  for (let i = 0; i < MAX_TRIES; i += 1) {
    const view = await readJson(`${API_BASE}/v1/executions/${executionId}`);
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(view.status)) return view;
    await sleep(WAIT_MS);
  }
  throw new Error(`execution ${executionId} timeout`);
}

async function pollHighRes(renderId) {
  for (let i = 0; i < MAX_TRIES; i += 1) {
    const view = await readJson(`${API_BASE}/v1/renders/${renderId}/highres/status`);
    if (["SUCCEEDED", "FAILED"].includes(view.status)) return view;
    await sleep(WAIT_MS);
  }
  throw new Error(`highres ${renderId} timeout`);
}

async function pollExport(exportId) {
  for (let i = 0; i < MAX_TRIES; i += 1) {
    const view = await readJson(`${API_BASE}/v1/exports/${exportId}`);
    if (["SUCCEEDED", "FAILED"].includes(view.status)) return view;
    await sleep(WAIT_MS);
  }
  throw new Error(`export ${exportId} timeout`);
}

async function main() {
  await readJson(`${API_BASE}/healthz`);

  const canvas = await readJson(`${API_BASE}/v1/canvases/${CANVAS_ID}`);
  const rootNode = canvas.nodes.find((node) => node.type === "RENDER_GRID");
  if (!rootNode) throw new Error("no render grid node found");

  const idempotencyKey = `smoke-m3-${Date.now()}`;
  const execution = await readJson(`${API_BASE}/v1/executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canvasId: CANVAS_ID,
      mode: "NODE",
      rootNodeId: rootNode.id,
      idempotencyKey,
      options: { maxParallel: 2 }
    })
  });

  const executionReplay = await readJson(`${API_BASE}/v1/executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canvasId: CANVAS_ID,
      mode: "NODE",
      rootNodeId: rootNode.id,
      idempotencyKey,
      options: { maxParallel: 2 }
    })
  });

  if (!executionReplay.reused) {
    throw new Error("idempotency key did not reuse execution");
  }

  const executionView = await pollExecution(execution.executionId);
  if (executionView.status !== "SUCCEEDED") {
    throw new Error(`execution failed with status ${executionView.status}`);
  }

  const renders = await readJson(`${API_BASE}/v1/nodes/${rootNode.id}/renders?limit=1&sort=createdAt:desc`);
  if (!Array.isArray(renders) || renders.length === 0) {
    throw new Error("no renders found after execution");
  }

  const highResJob = await readJson(`${API_BASE}/v1/renders/${renders[0].id}/highres`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetResolution: "4k" })
  });

  if (!highResJob.jobId) {
    throw new Error("highres job id missing");
  }

  const highResView = await pollHighRes(renders[0].id);
  if (highResView.status !== "SUCCEEDED") {
    throw new Error(`highres failed with status ${highResView.status}`);
  }

  const highResResponse = await fetch(`${API_BASE}/v1/renders/${renders[0].id}/highres`);
  if (!highResResponse.ok) {
    throw new Error(`highres download failed: ${highResResponse.status}`);
  }

  const contentType = highResResponse.headers.get("content-type") ?? "";
  const disposition = highResResponse.headers.get("content-disposition") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`unexpected highres content-type ${contentType}`);
  }
  if (!/highres\.(png|jpg|webp|svg)/.test(disposition)) {
    throw new Error(`unexpected highres filename ${disposition}`);
  }

  const exportReq = await readJson(`${API_BASE}/v1/exports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      canvasId: CANVAS_ID,
      executionId: execution.executionId,
      include: { images: true, prompts: true, metadata: true }
    })
  });

  const exportView = await pollExport(exportReq.exportId);
  if (exportView.status !== "SUCCEEDED") {
    throw new Error(`export failed with status ${exportView.status}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        executionId: execution.executionId,
        renderId: renders[0].id,
        exportId: exportReq.exportId,
        highResContentType: contentType
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  if (error.payload) {
    console.error(JSON.stringify(error.payload, null, 2));
  }
  process.exit(1);
});
