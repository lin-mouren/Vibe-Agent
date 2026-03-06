import { startApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { closeRedisClients } from "./lib/redis.js";

let shuttingDown = false;

async function main() {
  const app = await startApp();

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, "shutdown.start");

    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, "shutdown.app_close_failed");
    }

    try {
      closeRedisClients();
    } catch (error) {
      app.log.error({ err: error }, "shutdown.redis_close_failed");
    }

    try {
      await prisma.$disconnect();
    } catch (error) {
      app.log.error({ err: error }, "shutdown.prisma_disconnect_failed");
    }

    app.log.info({ signal }, "shutdown.complete");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
