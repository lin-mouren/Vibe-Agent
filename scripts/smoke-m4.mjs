const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const CANVAS_ID = process.env.DEFAULT_CANVAS_ID ?? "00000000-0000-0000-0000-000000000001";

async function readJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${url} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  const canvas = await readJson(`${API_BASE}/v1/canvases/${CANVAS_ID}`);
  const node = canvas.nodes.find((item) => item.type === "RENDER_GRID");
  if (!node) throw new Error("no RENDER_GRID node found");

  const patched = await readJson(`${API_BASE}/v1/nodes/${node.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: {
        prompt: `M4 smoke prompt ${Date.now()}`,
        continuity: true
      }
    })
  });

  if (!patched?.config?.prompt) {
    throw new Error("node patch did not persist prompt");
  }

  const renders = await readJson(`${API_BASE}/v1/nodes/${node.id}/renders?limit=5&offset=0&sort=createdAt:desc`);
  if (!Array.isArray(renders)) {
    throw new Error("renders query did not return array");
  }

  const latestExecution = await readJson(`${API_BASE}/v1/executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ canvasId: CANVAS_ID, mode: "NODE", rootNodeId: node.id })
  });

  const retry = await readJson(`${API_BASE}/v1/executions/${latestExecution.executionId}/retry-failed`, {
    method: "POST"
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        nodeId: node.id,
        rendersCount: renders.length,
        executionId: latestExecution.executionId,
        retried: retry.retried
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
