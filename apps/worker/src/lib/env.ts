import { loadDotEnv } from "./load-env.js";

loadDotEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for worker");
}

const storageDriver = process.env.STORAGE_DRIVER === "s3" ? "s3" : "local";
const imageProvider = process.env.IMAGE_PROVIDER === "openai" ? "openai" : "mock";
const openAiTimeoutMsRaw = Number(process.env.OPENAI_TIMEOUT_MS ?? 60000);
const openAiTimeoutMs = Number.isFinite(openAiTimeoutMsRaw) && openAiTimeoutMsRaw > 0 ? openAiTimeoutMsRaw : 60000;

export const env = {
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  DATABASE_URL: databaseUrl,
  STORAGE_DRIVER: storageDriver as "local" | "s3",
  LOCAL_STORAGE_DIR: process.env.LOCAL_STORAGE_DIR ?? "./.data/storage",
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  S3_REGION: process.env.S3_REGION ?? "us-east-1",
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
  S3_BUCKET: process.env.S3_BUCKET ?? "frame2-assets",
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? "true",
  IMAGE_PROVIDER: imageProvider as "mock" | "openai",
  IMAGE_PROVIDER_FALLBACK_TO_MOCK: process.env.IMAGE_PROVIDER_FALLBACK_TO_MOCK !== "false",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
  OPENAI_TIMEOUT_MS: openAiTimeoutMs
};
