import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import {
  CreateEdgeInputSchema,
  CreateExecutionInputSchema,
  CreateExportInputSchema,
  CreateNodeInputSchema,
  DEFAULT_CANVAS_ID,
  NodeRendersQuerySchema,
  PatchNodeInputSchema,
  UpdateCanvasStateInputSchema
} from "@frame2/shared";
import { JobStatus, NodeType, type Prisma } from "@prisma/client";
import { env } from "./lib/env.js";
import { canvasChannel, publishCanvasEvent } from "./lib/events.js";
import { buildPrompts } from "./lib/jobs.js";
import { prisma } from "./lib/prisma.js";
import { getQueue } from "./lib/queue.js";
import { createRedisSub, redis } from "./lib/redis.js";
import { serializeCanvas } from "./lib/serialize.js";
import { ensureStorage, getObjectStream } from "./lib/s3.js";

type ApiError = {
  code: string;
  message: string;
  details?: unknown;
};

const activeHighResStatuses = new Set<JobStatus>([
  JobStatus.WAITING,
  JobStatus.RUNNING,
  JobStatus.RETRYING
]);

function asRecord(input: unknown) {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function sendError(reply: FastifyReply, statusCode: number, error: ApiError) {
  return reply.code(statusCode).send({ error });
}

function mimeToExtension(mime: string) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "svg";
}

async function findLatestHighResJob(renderId: string, executionId: string, nodeId: string) {
  const jobs = await prisma.job.findMany({
    where: {
      executionId,
      nodeId,
      type: "HIGH_RES_RENDER"
    },
    orderBy: { updatedAt: "desc" },
    take: 100
  });

  return jobs.find((job) => String(asRecord(job.payload).renderId ?? "") === renderId) ?? null;
}

function highResViewStatus(status: JobStatus) {
  if (status === JobStatus.WAITING) return "WAITING";
  if (status === JobStatus.RUNNING) return "RUNNING";
  if (status === JobStatus.RETRYING) return "RETRYING";
  if (status === JobStatus.SUCCEEDED) return "SUCCEEDED";
  return "FAILED";
}

function sendSseEvent(reply: FastifyReply, event: { id: string; type: string; [key: string]: unknown }) {
  reply.raw.write(`id: ${event.id}\nevent: canvas\ndata: ${JSON.stringify(event)}\n\n`);
}

async function emitRecoverySnapshot(reply: FastifyReply, canvasId: string, cursor: string) {
  const [execution, nodes, latestExport] = await Promise.all([
    prisma.execution.findFirst({ where: { canvasId }, orderBy: { createdAt: "desc" } }),
    prisma.node.findMany({ where: { canvasId }, orderBy: { updatedAt: "desc" }, take: 100 }),
    prisma.export.findFirst({ where: { canvasId }, orderBy: { createdAt: "desc" } })
  ]);

  if (execution) {
    sendSseEvent(reply, {
      id: randomUUID(),
      canvasId,
      ts: new Date().toISOString(),
      type: "execution.updated",
      payload: {
        executionId: execution.id,
        status: execution.status,
        resumedFrom: cursor
      }
    });
  }

  for (const node of nodes) {
    const nodeStatus = asRecord(node.status);
    sendSseEvent(reply, {
      id: randomUUID(),
      canvasId,
      ts: new Date().toISOString(),
      type: "node.updated",
      payload: {
        nodeId: node.id,
        state: String(nodeStatus.state ?? "IDLE"),
        resumedFrom: cursor
      }
    });
  }

  if (latestExport) {
    sendSseEvent(reply, {
      id: randomUUID(),
      canvasId,
      ts: new Date().toISOString(),
      type: "export.updated",
      payload: {
        exportId: latestExport.id,
        status: latestExport.status,
        downloadUrl: latestExport.storageKey ? `/v1/exports/${latestExport.id}/download` : null,
        resumedFrom: cursor
      }
    });
  }
}

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        path: request.url,
        statusCode: reply.statusCode
      },
      "request.completed"
    );
  });

  app.get("/healthz", async () => ({ ok: true, service: "api" }));

  app.get("/healthz/details", async (_request, reply) => {
    try {
      await Promise.all([prisma.$queryRaw`SELECT 1`, redis.ping(), ensureStorage()]);
      return {
        ok: true,
        checks: {
          db: "ok",
          redis: "ok",
          storage: "ok"
        }
      };
    } catch (error) {
      return sendError(reply, 503, {
        code: "HEALTHCHECK_FAILED",
        message: error instanceof Error ? error.message : "Healthcheck failed"
      });
    }
  });

  app.get("/metrics", async (_request, reply) => {
    const [waiting, active, failed, completed] = await Promise.all([
      getQueue().getWaitingCount(),
      getQueue().getActiveCount(),
      getQueue().getFailedCount(),
      getQueue().getCompletedCount()
    ]);

    const executionStatuses = await prisma.execution.groupBy({ by: ["status"], _count: { _all: true } });
    const lines = [
      "# HELP frame2_queue_waiting Number of waiting jobs",
      "# TYPE frame2_queue_waiting gauge",
      `frame2_queue_waiting ${waiting}`,
      "# HELP frame2_queue_active Number of active jobs",
      "# TYPE frame2_queue_active gauge",
      `frame2_queue_active ${active}`,
      "# HELP frame2_queue_failed Number of failed jobs",
      "# TYPE frame2_queue_failed counter",
      `frame2_queue_failed ${failed}`,
      "# HELP frame2_queue_completed Number of completed jobs",
      "# TYPE frame2_queue_completed counter",
      `frame2_queue_completed ${completed}`
    ];

    for (const item of executionStatuses) {
      lines.push(`frame2_execution_total{status=\"${item.status}\"} ${item._count._all}`);
    }

    reply.header("Content-Type", "text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });

  app.get("/v1/canvases/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const canvas = await prisma.canvas.findUnique({ where: { id } });
    if (!canvas && id === DEFAULT_CANVAS_ID) {
      return sendError(reply, 404, {
        code: "DEFAULT_CANVAS_MISSING",
        message: "Default canvas missing. Run db seed."
      });
    }
    if (!canvas) {
      return sendError(reply, 404, { code: "CANVAS_NOT_FOUND", message: "Canvas not found" });
    }

    const [nodes, edges] = await Promise.all([
      prisma.node.findMany({ where: { canvasId: canvas.id } }),
      prisma.edge.findMany({ where: { canvasId: canvas.id } })
    ]);

    return serializeCanvas(canvas, nodes, edges);
  });

  app.post("/v1/canvases/:id/nodes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = CreateNodeInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: "VALIDATION_ERROR",
        message: "Invalid create node payload",
        details: parsed.error.flatten()
      });
    }

    const canvas = await prisma.canvas.findUnique({ where: { id } });
    if (!canvas) return sendError(reply, 404, { code: "CANVAS_NOT_FOUND", message: "Canvas not found" });

    const node = await prisma.node.create({
      data: {
        canvasId: id,
        type: parsed.data.type as NodeType,
        pos: { x: parsed.data.x, y: parsed.data.y },
        config: parsed.data.config,
        status: { state: "IDLE" }
      }
    });

    await prisma.canvas.update({ where: { id }, data: { version: { increment: 1 } } });
    await publishCanvasEvent(id, "node.updated", { nodeId: node.id, action: "created" });

    return {
      id: node.id,
      type: node.type,
      x: (node.pos as { x: number }).x,
      y: (node.pos as { y: number }).y,
      config: node.config,
      status: node.status
    };
  });

  app.patch("/v1/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = PatchNodeInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: "VALIDATION_ERROR",
        message: "Invalid patch node payload",
        details: parsed.error.flatten()
      });
    }

    const existing = await prisma.node.findUnique({ where: { id } });
    if (!existing) return sendError(reply, 404, { code: "NODE_NOT_FOUND", message: "Node not found" });

    const currentPos = asRecord(existing.pos);
    const currentConfig = asRecord(existing.config);
    const currentStatus = asRecord(existing.status);

    const nextPos = parsed.data.position
      ? { x: parsed.data.position.x, y: parsed.data.position.y }
      : { x: Number(currentPos.x ?? 0), y: Number(currentPos.y ?? 0) };

    const node = await prisma.node.update({
      where: { id },
      data: {
        pos: nextPos,
        config: (parsed.data.config ? { ...currentConfig, ...parsed.data.config } : (existing.config ?? {})) as Prisma.InputJsonValue,
        status: (parsed.data.status ? { ...currentStatus, ...parsed.data.status } : (existing.status ?? {})) as Prisma.InputJsonValue
      }
    });

    await prisma.canvas.update({ where: { id: existing.canvasId }, data: { version: { increment: 1 } } });
    await publishCanvasEvent(existing.canvasId, "node.updated", {
      nodeId: id,
      action: "patched"
    });

    return {
      id: node.id,
      x: (node.pos as { x: number }).x,
      y: (node.pos as { y: number }).y,
      config: node.config,
      status: node.status
    };
  });

  app.post("/v1/canvases/:id/edges", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = CreateEdgeInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: "VALIDATION_ERROR",
        message: "Invalid create edge payload",
        details: parsed.error.flatten()
      });
    }

    const edge = await prisma.edge.create({
      data: {
        canvasId: id,
        fromNodeId: parsed.data.fromNodeId,
        toNodeId: parsed.data.toNodeId,
        type: parsed.data.type,
        config: parsed.data.config
      }
    });

    await prisma.canvas.update({ where: { id }, data: { version: { increment: 1 } } });
    await publishCanvasEvent(id, "node.updated", { edgeId: edge.id, action: "edge-created" });

    return {
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      type: edge.type,
      config: edge.config
    };
  });

  app.patch("/v1/canvases/:id/state", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateCanvasStateInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: "VALIDATION_ERROR",
        message: "Invalid canvas state payload",
        details: parsed.error.flatten()
      });
    }

    const updated = await prisma.canvas.updateMany({
      where: { id, version: parsed.data.version },
      data: {
        viewport: parsed.data.viewport,
        version: { increment: 1 }
      }
    });

    if (updated.count === 0) {
      return sendError(reply, 409, {
        code: "CANVAS_VERSION_CONFLICT",
        message: "Canvas version conflict"
      });
    }

    await prisma.$transaction([
      prisma.edge.deleteMany({ where: { canvasId: id } }),
      prisma.node.deleteMany({ where: { canvasId: id } }),
      prisma.node.createMany({
        data: parsed.data.nodes.map((node) => ({
          id: node.id,
          canvasId: id,
          type: node.type as NodeType,
          pos: { x: node.x, y: node.y },
          config: node.config,
          status: node.status
        }))
      }),
      prisma.edge.createMany({
        data: parsed.data.edges.map((edge) => ({
          id: edge.id,
          canvasId: id,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          type: edge.type,
          config: edge.config
        }))
      })
    ]);

    await publishCanvasEvent(id, "node.updated", { action: "canvas-state-updated" });
    return { ok: true };
  });

  app.get("/v1/nodes/:id/renders", async (request, reply) => {
    const { id } = request.params as { id: string };
    const queryParsed = NodeRendersQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return sendError(reply, 400, {
        code: "VALIDATION_ERROR",
        message: "Invalid renders query",
        details: queryParsed.error.flatten()
      });
    }

    const orderBy = queryParsed.data.sort === "createdAt:asc" ? [{ createdAt: "asc" as const }] : [{ createdAt: "desc" as const }];

    const renders = await prisma.render.findMany({
      where: {
        nodeId: id,
        ...(queryParsed.data.executionId ? { executionId: queryParsed.data.executionId } : {})
      },
      include: { asset: true, execution: true },
      orderBy,
      take: queryParsed.data.limit,
      skip: queryParsed.data.offset
    });

    return renders.map((render) => ({
      id: render.id,
      nodeId: render.nodeId,
      executionId: render.executionId,
      gridIndex: render.gridIndex,
      promptSnapshot: render.promptSnapshot,
      createdAt: render.createdAt,
      asset: {
        id: render.asset.id,
        mime: render.asset.mime,
        url: `/v1/assets/${render.asset.id}/content`
      }
    }));
  });

  app.get("/v1/assets/:id/content", async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) return sendError(reply, 404, { code: "ASSET_NOT_FOUND", message: "Asset not found" });

    const body = await getObjectStream(asset.storageKey);
    reply.header("Content-Type", asset.mime);
    return reply.send(body);
  });

  app.post("/v1/renders/:id/highres", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    const requestedResolution = String(body.targetResolution ?? "4k");

    const render = await prisma.render.findUnique({
      where: { id },
      include: { execution: true }
    });
    if (!render) return sendError(reply, 404, { code: "RENDER_NOT_FOUND", message: "Render not found" });

    const latest = await findLatestHighResJob(render.id, render.executionId, render.nodeId);
    if (latest) {
      if (latest.status === JobStatus.SUCCEEDED) {
        return {
          jobId: latest.id,
          status: highResViewStatus(latest.status),
          downloadUrl: `/v1/renders/${render.id}/highres`
        };
      }
      if (activeHighResStatuses.has(latest.status)) {
        return { jobId: latest.id, status: highResViewStatus(latest.status) };
      }
    }

    const dbJob = await prisma.job.create({
      data: {
        executionId: render.executionId,
        nodeId: render.nodeId,
        type: "HIGH_RES_RENDER",
        status: JobStatus.WAITING,
        payload: {
          canvasId: render.execution.canvasId,
          executionId: render.executionId,
          nodeId: render.nodeId,
          renderId: render.id,
          targetResolution: requestedResolution
        }
      }
    });

    await getQueue().add("highres", { dbJobId: dbJob.id }, { jobId: dbJob.id });
    await publishCanvasEvent(render.execution.canvasId, "highres.updated", {
      renderId: render.id,
      jobId: dbJob.id,
      status: "WAITING",
      downloadUrl: null,
      errorCode: null,
      errorMessage: null
    });

    return { jobId: dbJob.id, status: highResViewStatus(dbJob.status) };
  });

  app.get("/v1/renders/:id/highres/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const render = await prisma.render.findUnique({ where: { id } });
    if (!render) return sendError(reply, 404, { code: "RENDER_NOT_FOUND", message: "Render not found" });

    const latest = await findLatestHighResJob(render.id, render.executionId, render.nodeId);
    if (!latest) {
      return { renderId: id, status: "NOT_REQUESTED", downloadUrl: null, jobId: null };
    }

    return {
      renderId: id,
      status: highResViewStatus(latest.status),
      jobId: latest.id,
      downloadUrl: latest.status === JobStatus.SUCCEEDED ? `/v1/renders/${id}/highres` : null
    };
  });

  app.get("/v1/renders/:id/highres", async (request, reply) => {
    const { id } = request.params as { id: string };
    const render = await prisma.render.findUnique({ where: { id } });
    if (!render) return sendError(reply, 404, { code: "RENDER_NOT_FOUND", message: "Render not found" });

    const latest = await findLatestHighResJob(render.id, render.executionId, render.nodeId);
    if (!latest) return sendError(reply, 404, { code: "HIGHRES_NOT_FOUND", message: "High-res artifact not found" });
    if (latest.status !== JobStatus.SUCCEEDED) {
      return sendError(reply, 409, {
        code: "HIGHRES_NOT_READY",
        message: "High-res is not ready",
        details: { status: latest.status }
      });
    }

    const result = asRecord(latest.result);
    const assetId = String(result.assetId ?? "");
    if (!assetId) return sendError(reply, 404, { code: "HIGHRES_ASSET_NOT_FOUND", message: "High-res asset not found" });

    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset) return sendError(reply, 404, { code: "HIGHRES_ASSET_MISSING", message: "High-res asset missing" });

    const body = await getObjectStream(asset.storageKey);
    const ext = mimeToExtension(asset.mime);
    reply.header("Content-Type", asset.mime);
    reply.header("Content-Disposition", `attachment; filename=render-${id}-highres.${ext}`);
    return reply.send(body);
  });

  app.post("/v1/executions", async (request, reply) => {
    const parsed = CreateExecutionInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: "VALIDATION_ERROR",
        message: "Invalid execution payload",
        details: parsed.error.flatten()
      });
    }

    const { canvasId, mode, rootNodeId, options, idempotencyKey } = parsed.data;
    const requestedBy = idempotencyKey ? `idemp:${idempotencyKey}` : "local-dev";

    const canvas = await prisma.canvas.findUnique({ where: { id: canvasId } });
    if (!canvas) return sendError(reply, 404, { code: "CANVAS_NOT_FOUND", message: "Canvas not found" });

    if (idempotencyKey) {
      const existing = await prisma.execution.findFirst({
        where: { canvasId, requestedBy },
        orderBy: { createdAt: "desc" }
      });
      if (existing) {
        return {
          executionId: existing.id,
          status: existing.status,
          reused: true
        };
      }
    }

    const renderNodes = await prisma.node.findMany({
      where: {
        canvasId,
        type: "RENDER_GRID",
        ...(mode === "NODE" || mode === "CONTINUITY" ? { id: rootNodeId ?? undefined } : {})
      }
    });

    const targetNodes =
      mode === "GRAPH"
        ? renderNodes
        : renderNodes.length > 0
          ? renderNodes
          : await prisma.node.findMany({ where: { canvasId, type: "RENDER_GRID" }, take: 1 });

    if (targetNodes.length === 0) {
      return sendError(reply, 400, {
        code: "NO_RENDER_NODE",
        message: "No render nodes available"
      });
    }

    const resolvedRootNodeId = rootNodeId ?? targetNodes[0]?.id;
    if (!resolvedRootNodeId) {
      return sendError(reply, 400, {
        code: "ROOT_NODE_REQUIRED",
        message: "Unable to resolve root render node"
      });
    }

    const execution = await prisma.execution.create({
      data: {
        canvasId,
        mode,
        rootNodeId: resolvedRootNodeId,
        status: "RUNNING",
        requestedBy,
        startedAt: new Date()
      }
    });

    const allJobs: Array<{ id: string; maxParallel: number; index: number }> = [];
    let enqueueIndex = 0;

    for (const node of targetNodes) {
      const config = (node.config ?? {}) as Record<string, unknown>;
      const rows = Number(config.rows ?? 3);
      const cols = Number(config.cols ?? 3);
      const ratio = String(config.ratio ?? "16:9");
      const resolution = String(config.resolution ?? "720p");
      const basePrompt = String(options?.promptOverride ?? config.prompt ?? "Cinematic storyboard frame");
      const effectiveMaxParallel = Math.max(1, Math.min(16, Number(options?.maxParallel ?? config.maxParallel ?? 4)));

      let continuityTag = "";
      if (mode === "CONTINUITY") {
        const lastRender = await prisma.render.findFirst({
          where: { nodeId: node.id },
          orderBy: { createdAt: "desc" }
        });
        continuityTag = lastRender ? `Continue visual continuity from render ${lastRender.id}.` : "Maintain continuity.";
      }

      const prompts = buildPrompts(basePrompt, rows, cols, continuityTag);

      for (let gridIndex = 0; gridIndex < prompts.length; gridIndex += 1) {
        const dbJob = await prisma.job.create({
          data: {
            executionId: execution.id,
            nodeId: node.id,
            type: "RENDER_CELL",
            status: JobStatus.WAITING,
            payload: {
              canvasId,
              executionId: execution.id,
              nodeId: node.id,
              gridIndex,
              prompt: prompts[gridIndex],
              ratio,
              resolution,
              maxParallel: effectiveMaxParallel
            }
          }
        });

        allJobs.push({ id: dbJob.id, maxParallel: effectiveMaxParallel, index: enqueueIndex });
        enqueueIndex += 1;
      }

      await prisma.node.update({
        where: { id: node.id },
        data: {
          status: {
            state: "QUEUED",
            lastExecutionId: execution.id
          }
        }
      });
      await publishCanvasEvent(canvasId, "node.updated", {
        nodeId: node.id,
        state: "QUEUED",
        executionId: execution.id
      });
    }

    for (const job of allJobs) {
      const bucket = Math.floor(job.index / job.maxParallel);
      const delay = bucket * 250;
      await getQueue().add("render", { dbJobId: job.id }, { jobId: job.id, delay });
    }

    await publishCanvasEvent(canvasId, "execution.updated", {
      executionId: execution.id,
      status: "RUNNING",
      totalJobs: allJobs.length
    });

    request.log.info({ requestId: request.id, executionId: execution.id, totalJobs: allJobs.length }, "execution.created");

    return { executionId: execution.id, status: execution.status, reused: false };
  });

  app.get("/v1/executions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const execution = await prisma.execution.findUnique({
      where: { id },
      include: { jobs: true }
    });

    if (!execution) return sendError(reply, 404, { code: "EXECUTION_NOT_FOUND", message: "Execution not found" });

    const jobCounts = execution.jobs.reduce<Record<string, number>>((acc, job) => {
      acc[job.status] = (acc[job.status] ?? 0) + 1;
      return acc;
    }, {});

    const nodeSummaries = await prisma.job.groupBy({
      by: ["nodeId", "status"],
      where: { executionId: id },
      _count: { _all: true }
    });

    return {
      id: execution.id,
      status: execution.status,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      jobCounts,
      nodeSummaries
    };
  });

  app.post("/v1/executions/:id/retry-failed", async (request, reply) => {
    const { id } = request.params as { id: string };
    const execution = await prisma.execution.findUnique({ where: { id } });
    if (!execution) return sendError(reply, 404, { code: "EXECUTION_NOT_FOUND", message: "Execution not found" });

    const failedJobs = await prisma.job.findMany({
      where: {
        executionId: id,
        status: JobStatus.FAILED,
        type: { in: ["RENDER_CELL", "ZIP_EXPORT", "HIGH_RES_RENDER"] }
      }
    });

    if (failedJobs.length === 0) {
      return { executionId: id, retried: 0 };
    }

    const retried = await prisma.$transaction(
      failedJobs.map((job) =>
        prisma.job.create({
          data: {
            executionId: job.executionId,
            nodeId: job.nodeId,
            type: job.type,
            status: JobStatus.WAITING,
            payload: job.payload as Prisma.InputJsonValue,
            maxAttempt: job.maxAttempt
          }
        })
      )
    );

    for (const job of retried) {
      const queueName = job.type === "ZIP_EXPORT" ? "zip" : job.type === "HIGH_RES_RENDER" ? "highres" : "render";
      await getQueue().add(queueName, { dbJobId: job.id }, { jobId: job.id });
      await publishCanvasEvent(execution.canvasId, "job.updated", {
        jobId: job.id,
        executionId: job.executionId,
        nodeId: job.nodeId,
        status: "WAITING",
        attempt: job.attempt,
        maxAttempt: job.maxAttempt,
        retryAt: null
      });
    }

    await prisma.execution.update({
      where: { id },
      data: {
        status: "RUNNING",
        endedAt: null
      }
    });

    await publishCanvasEvent(execution.canvasId, "execution.updated", {
      executionId: id,
      status: "RUNNING",
      retried: retried.length
    });

    return { executionId: id, retried: retried.length };
  });

  app.post("/v1/executions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const execution = await prisma.execution.findUnique({ where: { id } });
    if (!execution) return sendError(reply, 404, { code: "EXECUTION_NOT_FOUND", message: "Execution not found" });

    const cancellableJobs = await prisma.job.findMany({
      where: {
        executionId: id,
        status: { in: [JobStatus.WAITING, JobStatus.RETRYING] }
      },
      select: { id: true }
    });

    const updated = await prisma.execution.update({
      where: { id },
      data: { status: "CANCELED", endedAt: new Date() }
    });

    await prisma.job.updateMany({
      where: { executionId: id, status: { in: [JobStatus.WAITING, JobStatus.RETRYING] } },
      data: { status: JobStatus.CANCELED }
    });

    for (const job of cancellableJobs) {
      const queueJob = await getQueue().getJob(job.id);
      if (queueJob) {
        try {
          await queueJob.remove();
        } catch {
          // ignore queue remove race
        }
      }
    }

    await publishCanvasEvent(updated.canvasId, "execution.updated", {
      executionId: updated.id,
      status: "CANCELED"
    });

    return { executionId: updated.id, status: updated.status, canceledJobs: cancellableJobs.length };
  });

  app.post("/v1/exports", async (request, reply) => {
    const parsed = CreateExportInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, {
        code: "VALIDATION_ERROR",
        message: "Invalid export payload",
        details: parsed.error.flatten()
      });
    }

    const executionId =
      parsed.data.executionId ??
      (
        await prisma.execution.findFirst({
          where: { canvasId: parsed.data.canvasId },
          orderBy: { createdAt: "desc" }
        })
      )?.id;

    if (!executionId) {
      return sendError(reply, 400, {
        code: "NO_EXECUTION_FOR_EXPORT",
        message: "No execution available for export"
      });
    }

    const nodeId = (
      await prisma.node.findFirst({
        where: { canvasId: parsed.data.canvasId, type: "RENDER_GRID" }
      })
    )?.id;

    if (!nodeId) {
      return sendError(reply, 400, {
        code: "NO_RENDER_NODE_FOR_EXPORT",
        message: "No render node available for export"
      });
    }

    const exportRow = await prisma.export.create({
      data: {
        canvasId: parsed.data.canvasId,
        executionId,
        status: "WAITING"
      }
    });

    const dbJob = await prisma.job.create({
      data: {
        executionId,
        nodeId,
        type: "ZIP_EXPORT",
        status: JobStatus.WAITING,
        payload: {
          exportId: exportRow.id,
          canvasId: parsed.data.canvasId,
          executionId,
          include: parsed.data.include
        }
      }
    });

    await getQueue().add("zip", { dbJobId: dbJob.id }, { jobId: dbJob.id });

    await publishCanvasEvent(parsed.data.canvasId, "export.updated", {
      exportId: exportRow.id,
      status: exportRow.status
    });

    return { exportId: exportRow.id, status: exportRow.status };
  });

  app.get("/v1/exports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const exportRow = await prisma.export.findUnique({ where: { id } });
    if (!exportRow) return sendError(reply, 404, { code: "EXPORT_NOT_FOUND", message: "Export not found" });

    return {
      id: exportRow.id,
      status: exportRow.status,
      downloadUrl: exportRow.storageKey ? `/v1/exports/${exportRow.id}/download` : null
    };
  });

  app.get("/v1/exports/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const exportRow = await prisma.export.findUnique({ where: { id } });
    if (!exportRow || !exportRow.storageKey) {
      return sendError(reply, 404, { code: "EXPORT_FILE_NOT_FOUND", message: "Export file not found" });
    }

    const body = await getObjectStream(exportRow.storageKey);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename=export-${id}.zip`);
    return reply.send(body);
  });

  app.get("/v1/events", async (request, reply) => {
    const { canvasId } = request.query as { canvasId?: string };
    if (!canvasId) {
      return sendError(reply, 400, { code: "CANVAS_ID_REQUIRED", message: "canvasId required" });
    }

    const lastEventIdHeader = request.headers["last-event-id"];
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    if (lastEventId) {
      await emitRecoverySnapshot(reply, canvasId, lastEventId);
    }

    const subscriber = createRedisSub();
    const channel = canvasChannel(canvasId);

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }, 15000);

    await subscriber.subscribe(channel);

    subscriber.on("message", (_ch, message) => {
      try {
        const payload = asRecord(JSON.parse(message));
        const event = {
          id: String(payload.id ?? randomUUID()),
          type: String(payload.type ?? "log.appended"),
          canvasId: String(payload.canvasId ?? canvasId),
          ts: String(payload.ts ?? new Date().toISOString()),
          payload: asRecord(payload.payload)
        };
        sendSseEvent(reply, event);
      } catch {
        sendSseEvent(reply, {
          id: randomUUID(),
          type: "log.appended",
          canvasId,
          ts: new Date().toISOString(),
          payload: { level: "error", message: "invalid_event_payload" }
        });
      }
    });

    request.raw.on("close", async () => {
      clearInterval(heartbeat);
      await subscriber.unsubscribe(channel);
      subscriber.disconnect();
      reply.raw.end();
    });
  });

  return app;
}

export async function startApp() {
  await ensureStorage();
  const app = await buildApp();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  return app;
}
