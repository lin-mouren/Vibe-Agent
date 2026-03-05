import { PrismaClient } from "@prisma/client";
import { DEFAULT_CANVAS_ID, DEFAULT_PROJECT_ID } from "@frame2/shared";

const prisma = new PrismaClient();

async function main() {
  await prisma.project.upsert({
    where: { id: DEFAULT_PROJECT_ID },
    create: { id: DEFAULT_PROJECT_ID, name: "Frame2 Demo Project" },
    update: { name: "Frame2 Demo Project" }
  });

  const canvas = await prisma.canvas.upsert({
    where: { id: DEFAULT_CANVAS_ID },
    create: {
      id: DEFAULT_CANVAS_ID,
      projectId: DEFAULT_PROJECT_ID,
      name: "Main Canvas",
      viewport: { x: 0, y: 0, zoom: 1 },
      version: 0
    },
    update: {}
  });

  const existingRenderNode = await prisma.node.findFirst({
    where: { canvasId: canvas.id, type: "RENDER_GRID" }
  });

  if (!existingRenderNode) {
    await prisma.node.create({
      data: {
        canvasId: canvas.id,
        type: "RENDER_GRID",
        pos: { x: 420, y: 180 },
        config: {
          rows: 3,
          cols: 3,
          ratio: "16:9",
          engine: "gemini-visual-pro",
          resolution: "720p",
          prompt: "Cinematic city night sequence, consistent character, dramatic lighting",
          continuity: true,
          maxParallel: 4
        },
        status: { state: "IDLE" }
      }
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
