import { randomUUID } from "node:crypto";
import type { CanvasEvent, EventType } from "@frame2/shared";
import { REDIS_EVENTS_CHANNEL_PREFIX } from "@frame2/shared";
import { redisPub } from "./redis.js";

export function canvasChannel(canvasId: string) {
  return `${REDIS_EVENTS_CHANNEL_PREFIX}:${canvasId}`;
}

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
  await redisPub.publish(canvasChannel(canvasId), JSON.stringify(event));
}
