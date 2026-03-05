import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { closeQueue } from "./lib/queue.js";
import { closeRedisClients } from "./lib/redis.js";

test.after(async () => {
  await closeQueue();
  closeRedisClients();
});

test("GET /healthz returns ok", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.service, "api");
  } finally {
    await app.close();
  }
});

test("POST /v1/executions validates payload shape", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/executions",
      payload: { bad: true }
    });

    assert.equal(response.statusCode, 400);
    const payload = response.json();
    assert.equal(payload.error.code, "VALIDATION_ERROR");
  } finally {
    await app.close();
  }
});

test("GET /v1/events requires canvasId", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/events" });
    assert.equal(response.statusCode, 400);
    const payload = response.json();
    assert.equal(payload.error.code, "CANVAS_ID_REQUIRED");
  } finally {
    await app.close();
  }
});
