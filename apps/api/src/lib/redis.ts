import IORedis from "ioredis";
import { env } from "./env.js";

const redisOptions = {
  maxRetriesPerRequest: null as number | null,
  lazyConnect: true,
  enableOfflineQueue: true,
  retryStrategy: (attempt: number) => Math.min(200 * Math.max(1, attempt), 2000)
};

export const redis = new IORedis(env.REDIS_URL, redisOptions);
export const redisPub = new IORedis(env.REDIS_URL, redisOptions);

export function createRedisSub() {
  return new IORedis(env.REDIS_URL, redisOptions);
}

export function closeRedisClients() {
  redis.disconnect();
  redisPub.disconnect();
}
