import { env } from "./env.js";

type GeneratedImage = {
  body: Buffer;
  mime: string;
  width: number;
  height: number;
  meta: Record<string, unknown>;
};

type RenderCellInput = {
  prompt: string;
  ratio: string;
  resolution: string;
  gridIndex: number;
};

type HighResInput = {
  prompt: string;
  ratio: string;
  targetResolution: string;
  sourceRenderId: string;
};

export type ProviderErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "QUOTA"
  | "TIMEOUT"
  | "NETWORK"
  | "UPSTREAM"
  | "UNKNOWN";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: ProviderErrorCode, message: string, status?: number, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function asRecord(input: unknown) {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function escapeXml(text: string) {
  return text.replace(/[<>&"]/g, (char) => {
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === "&") return "&amp;";
    return "&quot;";
  });
}

function normalizeRatio(ratio: string) {
  const [wRaw, hRaw] = ratio.split(":");
  const w = Number(wRaw);
  const h = Number(hRaw);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: 16, h: 9 };
  return { w, h };
}

function ratioToSize(ratio: string, baseWidth: number) {
  const normalized = normalizeRatio(ratio);
  const width = baseWidth;
  const height = Math.max(720, Math.round((baseWidth * normalized.h) / normalized.w));
  return { width, height };
}

function baseWidthFromResolution(resolution: string) {
  if (resolution === "4k") return 3840;
  if (resolution === "1080p") return 1920;
  return 1280;
}

function chooseOpenAIOutputSize(width: number, height: number) {
  if (width === height) return { size: "1024x1024", width: 1024, height: 1024 };
  if (width > height) return { size: "1536x1024", width: 1536, height: 1024 };
  return { size: "1024x1536", width: 1024, height: 1536 };
}

function renderMockCellSvg(input: RenderCellInput, width: number, height: number) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1d4ed8" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <text x="60" y="90" fill="#93c5fd" font-size="34" font-family="Inter, Arial">Frame-2 MVP Render #${input.gridIndex + 1}</text>
  <text x="60" y="145" fill="#cbd5e1" font-size="22" font-family="Inter, Arial">ratio: ${escapeXml(input.ratio)} | resolution: ${escapeXml(input.resolution)}</text>
  <foreignObject x="60" y="190" width="${Math.max(200, width - 120)}" height="${Math.max(200, height - 250)}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-size:24px; color:#f8fafc; font-family:Inter, Arial; line-height:1.4;">
      ${escapeXml(input.prompt)}
    </div>
  </foreignObject>
</svg>`;
}

function renderMockHighResSvg(input: HighResInput, width: number, height: number) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg-hi" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#0b3b95" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg-hi)" />
  <text x="96" y="128" fill="#a3e635" font-size="52" font-family="Inter, Arial">Frame-2 High-Res</text>
  <text x="96" y="196" fill="#cbd5e1" font-size="30" font-family="Inter, Arial">source render: ${escapeXml(input.sourceRenderId)} | ratio: ${escapeXml(input.ratio)} | target: ${escapeXml(input.targetResolution)}</text>
  <foreignObject x="96" y="264" width="${Math.max(200, width - 192)}" height="${Math.max(200, height - 340)}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-size:38px; color:#f8fafc; font-family:Inter, Arial; line-height:1.45;">
      ${escapeXml(input.prompt)}
    </div>
  </foreignObject>
</svg>`;
}

async function requestOpenAIImage(prompt: string, width: number, height: number) {
  if (!env.OPENAI_API_KEY) {
    throw new ProviderError("AUTH", "OPENAI_API_KEY is required when IMAGE_PROVIDER=openai", 401, false);
  }

  const chosenSize = chooseOpenAIOutputSize(width, height);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), env.OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.OPENAI_IMAGE_MODEL,
        prompt,
        size: chosenSize.size
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError("AUTH", `OpenAI authorization failed: ${text}`, response.status, false);
      }
      if (response.status === 408) {
        throw new ProviderError("TIMEOUT", `OpenAI request timed out: ${text}`, response.status, true);
      }
      if (response.status === 429) {
        const codeText = text.toLowerCase();
        const code = codeText.includes("quota") ? "QUOTA" : "RATE_LIMIT";
        throw new ProviderError(code, `OpenAI rate/quota limited: ${text}`, response.status, true);
      }
      if (response.status >= 500) {
        throw new ProviderError("UPSTREAM", `OpenAI upstream failed: ${text}`, response.status, true);
      }
      throw new ProviderError("UNKNOWN", `OpenAI request failed (${response.status}): ${text}`, response.status, false);
    }

    const payload = asRecord(await response.json());
    const data = Array.isArray(payload.data) ? payload.data : [];
    const first = data.length > 0 ? asRecord(data[0]) : {};
    const b64 = String(first.b64_json ?? "");
    if (b64) {
      return {
        body: Buffer.from(b64, "base64"),
        mime: "image/png",
        width: chosenSize.width,
        height: chosenSize.height,
        meta: {
          provider: "openai",
          model: env.OPENAI_IMAGE_MODEL,
          requestedSize: `${width}x${height}`,
          outputSize: chosenSize.size
        }
      } satisfies GeneratedImage;
    }

    const url = String(first.url ?? "");
    if (!url) {
      throw new ProviderError("UPSTREAM", "OpenAI response missing b64_json/url", 502, true);
    }

    const imageResponse = await fetch(url);
    if (!imageResponse.ok) {
      throw new ProviderError(
        "UPSTREAM",
        `Failed to fetch OpenAI image URL (${imageResponse.status})`,
        imageResponse.status,
        true
      );
    }

    const bytes = Buffer.from(await imageResponse.arrayBuffer());
    return {
      body: bytes,
      mime: "image/png",
      width: chosenSize.width,
      height: chosenSize.height,
      meta: {
        provider: "openai",
        model: env.OPENAI_IMAGE_MODEL,
        requestedSize: `${width}x${height}`,
        outputSize: chosenSize.size
      }
    } satisfies GeneratedImage;
  } finally {
    clearTimeout(timeoutId);
  }
}

function shouldFallbackToMock(error: unknown) {
  return env.IMAGE_PROVIDER_FALLBACK_TO_MOCK && env.IMAGE_PROVIDER === "openai" && error instanceof Error;
}

function asProviderError(error: unknown) {
  if (error instanceof ProviderError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderError("TIMEOUT", "OpenAI request aborted by timeout", 408, true);
  }
  if (error instanceof Error) {
    return new ProviderError("NETWORK", error.message, undefined, true);
  }
  return new ProviderError("UNKNOWN", "Unknown provider error", undefined, false);
}

export function extensionFromMime(mime: string) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "svg";
}

export async function generateRenderCellImage(input: RenderCellInput): Promise<GeneratedImage> {
  const targetSize = ratioToSize(input.ratio, baseWidthFromResolution(input.resolution));

  if (env.IMAGE_PROVIDER === "openai") {
    try {
      return await requestOpenAIImage(input.prompt, targetSize.width, targetSize.height);
    } catch (error) {
      const providerError = asProviderError(error);
      if (!shouldFallbackToMock(providerError)) throw providerError;
      console.warn("OpenAI render cell failed, falling back to mock provider", providerError);
      return {
        body: Buffer.from(renderMockCellSvg(input, targetSize.width, targetSize.height), "utf-8"),
        mime: "image/svg+xml",
        width: targetSize.width,
        height: targetSize.height,
        meta: {
          provider: "mock",
          model: "mock-render-engine",
          fallbackFrom: "openai",
          fallbackReason: providerError.code,
          fallbackMessage: providerError.message
        }
      };
    }
  }

  return {
    body: Buffer.from(renderMockCellSvg(input, targetSize.width, targetSize.height), "utf-8"),
    mime: "image/svg+xml",
    width: targetSize.width,
    height: targetSize.height,
    meta: {
      provider: "mock",
      model: "mock-render-engine"
    }
  };
}

export async function generateHighResImage(input: HighResInput): Promise<GeneratedImage> {
  const targetWidth = input.targetResolution === "4k" ? 3840 : 2560;
  const targetSize = ratioToSize(input.ratio, targetWidth);

  if (env.IMAGE_PROVIDER === "openai") {
    try {
      return await requestOpenAIImage(input.prompt, targetSize.width, targetSize.height);
    } catch (error) {
      const providerError = asProviderError(error);
      if (!shouldFallbackToMock(providerError)) throw providerError;
      console.warn("OpenAI high-res failed, falling back to mock provider", providerError);
      return {
        body: Buffer.from(renderMockHighResSvg(input, targetSize.width, targetSize.height), "utf-8"),
        mime: "image/svg+xml",
        width: targetSize.width,
        height: targetSize.height,
        meta: {
          provider: "mock",
          model: "mock-highres-engine",
          fallbackFrom: "openai",
          fallbackReason: providerError.code,
          fallbackMessage: providerError.message
        }
      };
    }
  }

  return {
    body: Buffer.from(renderMockHighResSvg(input, targetSize.width, targetSize.height), "utf-8"),
    mime: "image/svg+xml",
    width: targetSize.width,
    height: targetSize.height,
    meta: {
      provider: "mock",
      model: "mock-highres-engine"
    }
  };
}
