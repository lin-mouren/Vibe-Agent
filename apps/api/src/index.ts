import { startApp } from "./app.js";

startApp().catch((error) => {
  console.error(error);
  process.exit(1);
});
