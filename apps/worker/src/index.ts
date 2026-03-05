import { randomUUID, createHash } from "node:crypto";
import { REDIS_QUEUE_NAME } from "@frame2/shared";
import { JobStatus, Prisma } from "@prisma/client";
import { QueueEvents, Worker } from "bullmq";
import JSZip from "jszip";
import { publishCanvasEvent } from "./lib/events.js";
import { env } from "./lib/env.js";
import {
  extensionFromMime,
  generateHighResImage,
  generateRenderCellImage,
  ProviderError
} from "./lib/image-provider.js";
import { prisma } from "./lib/prisma.js";
import { ensureStorage, getObjectBuffer, putObject } from "./lib/s3.js";

const activeJobStatuses: JobStatus[] = [JobStatus.WAITING, JobStatus.RUNNING, JobStatus.RETRYING];

function logStructured(message: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", ts: new Date().toISOString(), message, ...payload }));
}

async function updateNodeStatus(nodeId: string, executionId: string, canvasId: string) {
  const jobs = await prisma.job.findMany({ where: { nodeId, executionId } });
  const running = jobs.some((job) => activeJobStatuses.includes(job.status));
  const failed = jobs.some((job) => job.status === JobStatus.FAILED);

  const state = running ? "RUNNING" : failed ? "FAILED" : "READY";

  await prisma.node.update({
    where: { id: nodeId },
    data: {
      status: {
        state,
        lastExecutionId: executionId
      }
    }
  });

  await publishCanvasEvent(canvasId, "node.updated", { nodeId, state, executionId });
}

async function updateExecutionStatus(executionId: string, canvasId: string) {
  const execution = await prisma.execution.findUnique({ where: { id: executionId } });
  if (!execution || execution.status === "CANCELED") return;

  const jobs = await prisma.job.findMany({ where: { executionId } });
  const hasActive = jobs.some((job) => activeJobStatuses.includes(job.status));
  if (hasActive) return;

  const hasFailure = jobs.some((job) => job.status === JobStatus.FAILED);
  const status = hasFailure ? "FAILED" : "SUCCEEDED";

  await prisma.execution.update({
    where: { id: execution.id },
    data: {
      status,
      endedAt: new Date()
    }
  });

  await publishCanvasEvent(canvasId, "execution.updated", { executionId, status });
}

function buildRetryDelay(attempt: number) {
  return 1000 * Math.pow(2, Math.max(0, attempt - 1));
}

function serializeError(error: unknown) {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status ?? null
    };
  }
  if (error instanceof Error) {
    return {
      code: "UNKNOWN",
      message: error.message,
      retryable: true,
      status: null
    };
  }
  return {
    code: "UNKNOWN",
    message: "Unknown error",
    retryable: false,
    status: null
  };
}

async function processRenderCell(dbJob: Prisma.JobGetPayload<{ include: { execution: true } }>) {
  const payload = dbJob.payload as {
    canvasId: string;
    executionId: string;
    nodeId: string;
    gridIndex: number;
    prompt: string;
    ratio: string;
    resolution: string;
  };

  const execution = await prisma.execution.findUnique({ where: { id: payload.executionId } });
  if (!execution || execution.status === "CANCELED") {
    await prisma.job.update({ where: { id: dbJob.id }, data: { status: JobStatus.CANCELED } });
    return;
  }

  const generated = await generateRenderCellImage({
    prompt: payload.prompt,
    ratio: payload.ratio,
    resolution: payload.resolution,
    gridIndex: payload.gridIndex
  });
  const ext = extensionFromMime(generated.mime);
  const storageKey = `renders/${payload.executionId}/${payload.nodeId}/cell-${payload.gridIndex}-${randomUUID()}.${ext}`;

  await putObject(storageKey, generated.body, generated.mime);

  const sha256 = createHash("sha256").update(generated.body).digest("hex");

  const asset = await prisma.asset.create({
    data: {
      kind: "IMAGE",
      mime: generated.mime,
      storageKey,
      sha256,
      width: generated.width,
      height: generated.height,
      meta: generated.meta as Prisma.InputJsonValue
    }
  });

  const render = await prisma.render.create({
    data: {
      nodeId: payload.nodeId,
      executionId: payload.executionId,
      assetId: asset.id,
      gridIndex: payload.gridIndex,
      promptSnapshot: {
        prompt: payload.prompt,
        ratio: payload.ratio,
        resolution: payload.resolution
      }
    }
  });

  await prisma.job.update({
    where: { id: dbJob.id },
    data: {
      status: JobStatus.SUCCEEDED,
      result: { assetId: asset.id, storageKey }
    }
  });

  await publishCanvasEvent(payload.canvasId, "job.updated", {
    jobId: dbJob.id,
    executionId: payload.executionId,
    nodeId: payload.nodeId,
    status: "SUCCEEDED",
    attempt: dbJob.attempt,
    maxAttempt: dbJob.maxAttempt,
    retryAt: null,
    errorCode: null,
    errorMessage: null
  });

  await publishCanvasEvent(payload.canvasId, "render.created", {
    nodeId: payload.nodeId,
    executionId: payload.executionId,
    gridIndex: payload.gridIndex,
    renderId: render.id,
    assetUrl: `/v1/assets/${asset.id}/content`
  });

  await updateNodeStatus(payload.nodeId, payload.executionId, payload.canvasId);
  await updateExecutionStatus(payload.executionId, payload.canvasId);
}

async function processHighResRender(dbJob: Prisma.JobGetPayload<{ include: { execution: true } }>) {
  const payload = dbJob.payload as {
    canvasId: string;
    executionId: string;
    nodeId: string;
    renderId: string;
    targetResolution?: string;
  };

  const sourceRender = await prisma.render.findUnique({
    where: { id: payload.renderId },
    include: { asset: true }
  });
  if (!sourceRender) {
    throw new Error(`Source render ${payload.renderId} not found`);
  }

  const snapshot = (sourceRender.promptSnapshot ?? {}) as Record<string, unknown>;
  const prompt = String(snapshot.prompt ?? "Storyboard frame");
  const ratio = String(snapshot.ratio ?? "16:9");
  const targetResolution = String(payload.targetResolution ?? "4k");
  const generated = await generateHighResImage({
    prompt,
    ratio,
    targetResolution,
    sourceRenderId: sourceRender.id
  });
  const ext = extensionFromMime(generated.mime);
  const storageKey = `highres/${payload.executionId}/${payload.nodeId}/${payload.renderId}-${randomUUID()}.${ext}`;

  await putObject(storageKey, generated.body, generated.mime);
  const sha256 = createHash("sha256").update(generated.body).digest("hex");

  const asset = await prisma.asset.create({
    data: {
      kind: "IMAGE",
      mime: generated.mime,
      storageKey,
      sha256,
      width: generated.width,
      height: generated.height,
      meta: {
        variant: "highres",
        sourceRenderId: payload.renderId,
        targetResolution,
        ...generated.meta
      } as Prisma.InputJsonValue
    }
  });

  await prisma.job.update({
    where: { id: dbJob.id },
    data: {
      status: JobStatus.SUCCEEDED,
      result: {
        renderId: payload.renderId,
        assetId: asset.id,
        storageKey
      }
    }
  });

  await publishCanvasEvent(payload.canvasId, "highres.updated", {
    renderId: payload.renderId,
    jobId: dbJob.id,
    status: "SUCCEEDED",
    downloadUrl: `/v1/renders/${payload.renderId}/highres`,
    errorCode: null,
    errorMessage: null
  });
}

async function processZipExport(dbJob: Prisma.JobGetPayload<{ include: { execution: true } }>) {
  const payload = dbJob.payload as {
    exportId: string;
    canvasId: string;
    executionId?: string;
    include?: { images?: boolean; prompts?: boolean; metadata?: boolean };
  };

  const exportRow = await prisma.export.findUnique({ where: { id: payload.exportId } });
  if (!exportRow) throw new Error(`Export ${payload.exportId} not found`);

  const executionId = payload.executionId ?? exportRow.executionId;
  if (!executionId) throw new Error("Export requires executionId");

  await prisma.export.update({ where: { id: exportRow.id }, data: { status: "RUNNING" } });
  await publishCanvasEvent(payload.canvasId, "export.updated", {
    exportId: exportRow.id,
    status: "RUNNING",
    downloadUrl: null
  });

  const renders = await prisma.render.findMany({
    where: { executionId },
    include: { asset: true, node: true },
    orderBy: [{ gridIndex: "asc" }, { createdAt: "asc" }]
  });

  const zip = new JSZip();

  if (payload.include?.images ?? true) {
    for (const render of renders) {
      const buffer = await getObjectBuffer(render.asset.storageKey);
      zip.file(`images/node-${render.nodeId}-cell-${render.gridIndex}.svg`, buffer);

      if (payload.include?.prompts ?? true) {
        zip.file(
          `prompts/node-${render.nodeId}-cell-${render.gridIndex}.txt`,
          JSON.stringify(render.promptSnapshot, null, 2)
        );
      }
    }
  }

  if (payload.include?.metadata ?? true) {
    zip.file(
      "metadata.json",
      JSON.stringify(
        {
          exportId: exportRow.id,
          executionId,
          createdAt: new Date().toISOString(),
          count: renders.length
        },
        null,
        2
      )
    );
  }

  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const storageKey = `exports/${exportRow.id}.zip`;

  await putObject(storageKey, archive, "application/zip");

  await prisma.export.update({
    where: { id: exportRow.id },
    data: {
      status: "SUCCEEDED",
      storageKey
    }
  });

  await prisma.job.update({
    where: { id: dbJob.id },
    data: { status: JobStatus.SUCCEEDED, result: { storageKey } }
  });

  await publishCanvasEvent(payload.canvasId, "export.updated", {
    exportId: exportRow.id,
    status: "SUCCEEDED",
    downloadUrl: `/v1/exports/${exportRow.id}/download`
  });

  await publishCanvasEvent(payload.canvasId, "job.updated", {
    jobId: dbJob.id,
    status: "SUCCEEDED",
    executionId,
    nodeId: dbJob.nodeId,
    attempt: dbJob.attempt,
    maxAttempt: dbJob.maxAttempt,
    retryAt: null,
    errorCode: null,
    errorMessage: null
  });
}

await ensureStorage();

const queueConnection = {
  url: env.REDIS_URL,
  maxRetriesPerRequest: null as number | null,
  lazyConnect: true,
  enableOfflineQueue: false,
  retryStrategy: () => null
};

const worker = new Worker(
  REDIS_QUEUE_NAME,
  async (queueJob) => {
    const dbJobId = queueJob.data.dbJobId as string;
    const dbJob = await prisma.job.findUnique({ where: { id: dbJobId }, include: { execution: true } });
    if (!dbJob) throw new Error(`DB job ${dbJobId} not found`);

    if (dbJob.execution.status === "CANCELED") {
      await prisma.job.update({
        where: { id: dbJob.id },
        data: { status: JobStatus.CANCELED }
      });
      await publishCanvasEvent(dbJob.execution.canvasId, "job.updated", {
        jobId: dbJob.id,
        executionId: dbJob.executionId,
        nodeId: dbJob.nodeId,
        status: "CANCELED",
        attempt: dbJob.attempt,
        maxAttempt: dbJob.maxAttempt,
        retryAt: null
      });
      return;
    }

    const attempt = queueJob.attemptsMade + 1;
    await prisma.job.update({
      where: { id: dbJob.id },
      data: {
        status: JobStatus.RUNNING,
        attempt
      }
    });

    await publishCanvasEvent(dbJob.execution.canvasId, "job.updated", {
      jobId: dbJob.id,
      executionId: dbJob.executionId,
      nodeId: dbJob.nodeId,
      status: "RUNNING",
      attempt,
      maxAttempt: dbJob.maxAttempt,
      retryAt: null
    });

    if (dbJob.type === "HIGH_RES_RENDER") {
      const payload = dbJob.payload as { renderId?: string };
      await publishCanvasEvent(dbJob.execution.canvasId, "highres.updated", {
        renderId: String(payload.renderId ?? ""),
        jobId: dbJob.id,
        status: "RUNNING",
        downloadUrl: null,
        errorCode: null,
        errorMessage: null
      });
    }

    try {
      if (dbJob.type === "RENDER_CELL") {
        await processRenderCell(dbJob);
      } else if (dbJob.type === "HIGH_RES_RENDER") {
        await processHighResRender(dbJob);
      } else if (dbJob.type === "ZIP_EXPORT") {
        await processZipExport(dbJob);
      } else {
        throw new Error(`Unsupported job type: ${dbJob.type}`);
      }
    } catch (error) {
      const nextAttempt = queueJob.attemptsMade + 1;
      const retryable = nextAttempt < dbJob.maxAttempt;
      const retryAt = retryable ? new Date(Date.now() + buildRetryDelay(nextAttempt)).toISOString() : null;
      const errorView = serializeError(error);

      await prisma.job.update({
        where: { id: dbJob.id },
        data: {
          status: retryable ? JobStatus.RETRYING : JobStatus.FAILED,
          error: errorView as Prisma.InputJsonValue
        }
      });

      await publishCanvasEvent(dbJob.execution.canvasId, "job.updated", {
        jobId: dbJob.id,
        executionId: dbJob.executionId,
        nodeId: dbJob.nodeId,
        status: retryable ? "RETRYING" : "FAILED",
        attempt: nextAttempt,
        maxAttempt: dbJob.maxAttempt,
        retryAt,
        errorCode: errorView.code,
        errorMessage: errorView.message
      });

      if (dbJob.type === "HIGH_RES_RENDER") {
        const payload = dbJob.payload as { renderId?: string };
        await publishCanvasEvent(dbJob.execution.canvasId, "highres.updated", {
          renderId: String(payload.renderId ?? ""),
          jobId: dbJob.id,
          status: retryable ? "RETRYING" : "FAILED",
          downloadUrl: null,
          errorCode: errorView.code,
          errorMessage: errorView.message
        });
      }
      if (dbJob.type === "ZIP_EXPORT") {
        const payload = dbJob.payload as { exportId?: string };
        if (payload.exportId) {
          await prisma.export.update({
            where: { id: payload.exportId },
            data: { status: "FAILED" }
          });
          await publishCanvasEvent(dbJob.execution.canvasId, "export.updated", {
            exportId: payload.exportId,
            status: "FAILED",
            downloadUrl: null
          });
        }
      }

      if (!retryable && dbJob.type !== "HIGH_RES_RENDER") {
        await updateNodeStatus(dbJob.nodeId, dbJob.executionId, dbJob.execution.canvasId);
        await updateExecutionStatus(dbJob.executionId, dbJob.execution.canvasId);
      }

      throw error;
    }
  },
  { connection: queueConnection, concurrency: 4 }
);

new QueueEvents(REDIS_QUEUE_NAME, { connection: queueConnection });

worker.on("failed", (job, error) => {
  logStructured("queue.job.failed", {
    queueJobId: job?.id ?? null,
    error: error.message
  });
});

worker.on("ready", () => {
  logStructured("worker.ready", { concurrency: 4 });
});
