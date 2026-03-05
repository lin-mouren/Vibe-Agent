import { z } from "zod";

export const NodeTypeSchema = z.enum([
  "PROMPT",
  "RENDER_GRID",
  "SCENE_BOARD",
  "EXPORT",
  "ANALYSIS"
]);

export const ExecutionStatusSchema = z.enum([
  "CREATED",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELED"
]);

export const JobStatusSchema = z.enum([
  "WAITING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "RETRYING",
  "CANCELED"
]);

export const ProviderTypeSchema = z.enum(["MOCK", "OPENAI"]);
export const HighResStatusViewSchema = z.enum([
  "NOT_REQUESTED",
  "WAITING",
  "RUNNING",
  "RETRYING",
  "SUCCEEDED",
  "FAILED"
]);

export const ExecutionModeSchema = z.enum(["NODE", "GRAPH", "CONTINUITY"]);

export type NodeType = z.infer<typeof NodeTypeSchema>;
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type ProviderType = z.infer<typeof ProviderTypeSchema>;
export type HighResStatusView = z.infer<typeof HighResStatusViewSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const RenderGridConfigSchema = z.object({
  rows: z.number().int().min(1).max(6).default(3),
  cols: z.number().int().min(1).max(6).default(3),
  ratio: z.enum(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"]).default("16:9"),
  engine: z.string().default("gemini-visual-pro"),
  resolution: z.enum(["720p", "1080p", "4k"]).default("720p"),
  prompt: z.string().min(1).default(""),
  continuity: z.boolean().default(false),
  maxParallel: z.number().int().min(1).max(16).default(4)
});

export const ContinuityConfigSchema = z.object({
  enabled: z.boolean().default(true),
  strategy: z.enum(["LAST_RENDER", "LAST_EXECUTION"]).default("LAST_RENDER")
});

export const QualityConfigSchema = z.object({
  highResTarget: z.enum(["2k", "4k"]).default("4k"),
  denoise: z.number().min(0).max(1).default(0.35)
});

export const NodeConfigSchema = z.object({
  renderGridConfig: RenderGridConfigSchema.default({}),
  continuityConfig: ContinuityConfigSchema.default({}),
  qualityConfig: QualityConfigSchema.default({})
});

export const CanvasNodeSchema = z.object({
  id: z.string().uuid(),
  type: NodeTypeSchema,
  x: z.number(),
  y: z.number(),
  config: z.record(z.any()).default({}),
  status: z.record(z.any()).default({})
});

export const CanvasEdgeSchema = z.object({
  id: z.string().uuid(),
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  type: z.string().default("DATA"),
  config: z.record(z.any()).default({})
});

export const CanvasSnapshotSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.number().int(),
  viewport: z.object({
    x: z.number().default(0),
    y: z.number().default(0),
    zoom: z.number().default(1)
  }),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema)
});

export const CreateNodeInputSchema = z.object({
  type: NodeTypeSchema,
  x: z.number(),
  y: z.number(),
  config: z.record(z.any()).default({})
});

export const CreateEdgeInputSchema = z.object({
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  type: z.string().default("DATA"),
  config: z.record(z.any()).default({})
});

export const UpdateCanvasStateInputSchema = z.object({
  version: z.number().int().nonnegative(),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number()
  }),
  nodes: z.array(CanvasNodeSchema),
  edges: z.array(CanvasEdgeSchema)
});

export const CreateExecutionInputSchema = z.object({
  canvasId: z.string().uuid(),
  mode: ExecutionModeSchema,
  rootNodeId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  options: z
    .object({
      promptOverride: z.string().optional(),
      maxParallel: z.number().int().min(1).max(16).optional()
    })
    .optional()
});

export const CreateExportInputSchema = z.object({
  canvasId: z.string().uuid(),
  executionId: z.string().uuid().optional(),
  include: z.object({
    images: z.boolean().default(true),
    prompts: z.boolean().default(true),
    metadata: z.boolean().default(true)
  })
});

export const PatchNodeInputSchema = z.object({
  position: z
    .object({
      x: z.number(),
      y: z.number()
    })
    .optional(),
  config: z.record(z.any()).optional(),
  status: z.record(z.any()).optional()
});

export const NodeRendersQuerySchema = z.object({
  executionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(["createdAt:desc", "createdAt:asc"]).default("createdAt:desc")
});

export const InspectorViewModelSchema = z.object({
  properties: z.object({
    nodeId: z.string().uuid(),
    nodeType: NodeTypeSchema,
    aspect: z.string(),
    prompt: z.string()
  }),
  analysis: z.object({
    continuity: z.number().int().min(0).max(100),
    coverage: z.number().int().min(0).max(100),
    promptStrength: z.number().int().min(0).max(100),
    notes: z.array(z.string()),
    evidence: z.array(
      z.object({
        key: z.string(),
        value: z.string()
      })
    )
  }),
  history: z.object({
    totalRenders: z.number().int().nonnegative(),
    latestExecutionId: z.string().uuid().nullable()
  }),
  highres: z.object({
    status: HighResStatusViewSchema,
    downloadUrl: z.string().nullable()
  })
});

export const EventTypeSchema = z.enum([
  "execution.updated",
  "job.updated",
  "render.created",
  "highres.updated",
  "node.updated",
  "export.updated",
  "log.appended"
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export type CanvasEvent<TPayload = Record<string, unknown>> = {
  id: string;
  type: EventType;
  canvasId: string;
  ts: string;
  payload: TPayload;
};

export const REDIS_EVENTS_CHANNEL_PREFIX = "frame2:events";
export const REDIS_QUEUE_NAME = "frame2-jobs";

export const DEFAULT_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
export const DEFAULT_CANVAS_ID = "00000000-0000-0000-0000-000000000001";
