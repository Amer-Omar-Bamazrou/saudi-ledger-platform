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

app.listen(env.PORT, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port: env.PORT }, "Server listening");
});
