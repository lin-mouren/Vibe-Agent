const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

async function main() {
  const health = await fetch(`${API_BASE}/healthz/details`);
  if (!health.ok) throw new Error(`health details failed: ${health.status}`);
  const healthJson = await health.json();
  if (!healthJson?.ok) throw new Error("health details returned not ok");

  const metricsRes = await fetch(`${API_BASE}/metrics`);
  if (!metricsRes.ok) throw new Error(`metrics failed: ${metricsRes.status}`);
  const metrics = await metricsRes.text();

  const requiredKeys = [
    "frame2_queue_waiting",
    "frame2_queue_active",
    "frame2_queue_failed",
    "frame2_queue_completed"
  ];

  for (const key of requiredKeys) {
    if (!metrics.includes(key)) {
      throw new Error(`missing metric ${key}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: healthJson.checks,
        metricsVerified: requiredKeys
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
