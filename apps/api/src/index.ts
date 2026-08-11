// Load .env (local dev) before anything reads process.env. Production supplies
// real environment variables directly; a missing .env file is not an error.
import "dotenv/config";
import { loadEnv } from "@workspace/config";
import { logger } from "./lib/logger";

// Validate the whole environment up front — the app must not start with missing
// or invalid config (e.g. a short/absent SESSION_SECRET). Throws a clear,
// aggregated error listing every problem.
const env = loadEnv();

// Import the app only after config has validated, so any boot failure surfaces
// as the config error rather than a downstream module-load error.
const { default: app } = await import("./app");

const server = app.listen(env.PORT, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port: env.PORT }, "Server listening");
});

// Background jobs (M12.8) — the e-invoice outbox, the archive sweep and the
// certificate-renewal check. Started AFTER the listener so a job cannot delay
// the port opening, and gated on ZATCA_WORKER_ENABLED (default off).
const { startBackgroundJobs, getScheduler } = await import("./jobs");
startBackgroundJobs();

// Stop polling before the process goes away, so an in-flight ZATCA submission
// is not abandoned mid-flight by a scheduled tick firing during shutdown.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "shutting down");
    getScheduler().stop();
    server.close(() => process.exit(0));
  });
}
