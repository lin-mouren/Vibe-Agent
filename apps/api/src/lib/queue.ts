import { Queue } from "bullmq";
import { REDIS_QUEUE_NAME } from "@frame2/shared";
import { env } from "./env.js";

const queueConnection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as number | null,
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: () => null
};

let queue: Queue | null = null;

export function getQueue() {
  if (!queue) {
    queue = new Queue(REDIS_QUEUE_NAME, {
      connection: queueConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1000
        },
        removeOnComplete: 100,
        removeOnFail: 500
      }
    });
  }

  return queue;
}

export async function closeQueue() {
  if (!queue) return;
  await queue.close();
  queue = null;
}
