import { randomUUID } from "node:crypto";
import type { CanvasEvent, EventType } from "@frame2/shared";
import { REDIS_EVENTS_CHANNEL_PREFIX } from "@frame2/shared";
import { redisPub } from "./redis.js";

export async function publishCanvasEvent<TPayload extends Record<string, unknown>>(
  canvasId: string,
  type: EventType,
  payload: TPayload
) {
  const event: CanvasEvent<TPayload> = {
    id: randomUUID(),
    type,
    canvasId,
    ts: new Date().toISOString(),
    payload
  };

  try {
    await redisPub.publish(`${REDIS_EVENTS_CHANNEL_PREFIX}:${canvasId}`, JSON.stringify(event));
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "event.publish.failed",
        canvasId,
        type,
        redisStatus: redisPub.status,
        error: error instanceof Error ? error.message : "unknown"
      })
    );
  }
}
