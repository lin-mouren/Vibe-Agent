import type { Canvas, Edge, Node } from "@prisma/client";

export function serializeCanvas(canvas: Canvas, nodes: Node[], edges: Edge[]) {
  return {
    id: canvas.id,
    name: canvas.name,
    version: canvas.version,
    viewport: canvas.viewport,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      x: (node.pos as { x: number }).x ?? 0,
      y: (node.pos as { y: number }).y ?? 0,
      config: node.config,
      status: node.status
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      type: edge.type,
      config: edge.config
    }))
  };
}
