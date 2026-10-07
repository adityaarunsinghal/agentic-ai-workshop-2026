/** Start an explicitly selected local environment on a loopback port. */
import { existsSync } from "node:fs";
import { createApplication } from "../agent/app.mjs";
import { createLocalWorkshop } from "../local/workshop.mjs";
import { serveApp } from "../ui/view.mjs";

const mode = process.argv[2];
if (mode === "live" && existsSync(".env")) process.loadEnvFile(".env");
let workshop;
try {
  workshop = createLocalWorkshop({ mode });
  const application = createApplication({ workshop });
  const runtime = await serveApp(application, {
    port: Number(process.env.PORT || 0),
    host: "127.0.0.1",
  });
  await application.initialize();
  console.info(
    `${mode === "fixture" ? "Synthetic preview" : "Local OpenRouter app"}: http://127.0.0.1:${runtime.port}`,
  );
  console.info(
    mode === "fixture"
      ? "Scripted model and synthetic HN records. No inference charges."
      : "Your configured OpenRouter account pays when you submit a request.",
  );
  const stop = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(workshop?.cleanError(error) ?? String(error.message));
  await workshop?.close();
  process.exitCode = 1;
}
