import { randomUUID } from "node:crypto";

export type RenderCellPayload = {
  canvasId: string;
  executionId: string;
  nodeId: string;
  gridIndex: number;
  prompt: string;
  ratio: string;
  resolution: string;
};

export function buildPrompts(basePrompt: string, rows: number, cols: number, continuityTag?: string) {
  const total = rows * cols;
  return Array.from({ length: total }, (_, index) => {
    const shot = index + 1;
    return `${basePrompt} | Shot ${shot}/${total}. ${continuityTag ?? ""}`.trim();
  });
}

export function makeStorageKey(executionId: string, nodeId: string, gridIndex: number) {
  return `renders/${executionId}/${nodeId}/cell-${gridIndex}-${randomUUID()}.svg`;
}
