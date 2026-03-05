import IORedis from "ioredis";
import { env } from "./env.js";

const redisOptions = {
  maxRetriesPerRequest: null as number | null,
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: () => null
};

export const redis = new IORedis(env.REDIS_URL, redisOptions);
export const redisPub = new IORedis(env.REDIS_URL, redisOptions);
