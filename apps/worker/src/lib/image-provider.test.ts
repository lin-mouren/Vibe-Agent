import test from "node:test";
import assert from "node:assert/strict";

const originalEnv = {
  IMAGE_PROVIDER: process.env.IMAGE_PROVIDER,
  IMAGE_PROVIDER_FALLBACK_TO_MOCK: process.env.IMAGE_PROVIDER_FALLBACK_TO_MOCK,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL,
  OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS
};

const originalFetch = global.fetch;

test.after(() => {
  process.env.IMAGE_PROVIDER = originalEnv.IMAGE_PROVIDER;
  process.env.IMAGE_PROVIDER_FALLBACK_TO_MOCK = originalEnv.IMAGE_PROVIDER_FALLBACK_TO_MOCK;
  process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL;
  process.env.OPENAI_IMAGE_MODEL = originalEnv.OPENAI_IMAGE_MODEL;
  process.env.OPENAI_TIMEOUT_MS = originalEnv.OPENAI_TIMEOUT_MS;
  global.fetch = originalFetch;
});

test("fallback to mock when openai fails and fallback enabled", async () => {
  process.env.IMAGE_PROVIDER = "openai";
  process.env.IMAGE_PROVIDER_FALLBACK_TO_MOCK = "true";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
  process.env.OPENAI_TIMEOUT_MS = "2000";

  global.fetch = async () =>
    new Response("rate limited", {
      status: 429,
      headers: {
        "content-type": "application/json"
      }
    });

  const modulePath = new URL(`./image-provider.js?run=${Date.now()}`, import.meta.url).href;
  const provider = await import(modulePath);

  const image = await provider.generateRenderCellImage({
    prompt: "futuristic city",
    ratio: "16:9",
    resolution: "720p",
    gridIndex: 0
  });

  assert.equal(image.meta.provider, "mock");
  assert.equal(image.meta.fallbackFrom, "openai");
  assert.equal(image.meta.fallbackReason, "RATE_LIMIT");
  assert.equal(image.mime, "image/svg+xml");
});

test("extensionFromMime maps common image types", async () => {
  process.env.IMAGE_PROVIDER = "mock";
  const modulePath = new URL(`./image-provider.js?run=${Date.now()}-ext`, import.meta.url).href;
  const provider = await import(modulePath);

  assert.equal(provider.extensionFromMime("image/png"), "png");
  assert.equal(provider.extensionFromMime("image/jpeg"), "jpg");
  assert.equal(provider.extensionFromMime("image/webp"), "webp");
  assert.equal(provider.extensionFromMime("image/svg+xml"), "svg");
});
