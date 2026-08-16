// Load .env (local dev) before anything reads process.env. Production supplies
// real environment variables directly; a missing .env file is not an error.
import "dotenv/config";
import { loadEnv } from "@workspace/config";
import { logger } from "./lib/logger";

// Validate the whole environment up front — the app must not start with missing
// or invalid config (e.g. a short/absent SESSION_SECRET). Throws a clear,
// aggregated error listing every problem.
const env = loadEnv();

// M17.2 — refuse to boot on a runtime that cannot do Umm al-Qura.
//
// 🔴 This is a fail-CLOSED check, matching the posture loadEnv takes with the
// mailer and alerter. A small-ICU Node does not throw when asked for the
// islamic-umalqura calendar — it silently falls back to Gregorian, so every
// Hijri fiscal-year boundary would be confidently wrong rather than missing.
// A Zakat base is a balance measured ON A DATE, so a boundary that is wrong by
// days is a wrong filing figure, and nothing downstream could detect it.
const { assertHijriCalendarAvailable } = await import("./lib/hijriCalendar");
assertHijriCalendarAvailable();

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

// DEMO ONLY — provision the demo tenant on first boot (D2).
//
// 🔴 Deliberately at BOOT rather than as a deploy-time shell command: the demo
// runs on a platform where the ordinary way to get a shell is to add one, and a
// seed step someone has to remember is a seed step that gets skipped after the
// database is recreated. `seedDemoTenant` is idempotent — it short-circuits
// when the tenant already has documents — so every subsequent boot is a no-op.
//
// It cannot affect a normal deployment: the whole block is behind DEMO_MODE,
// and even inside it the seed only ever writes the `demo` organization.
if (env.DEMO_MODE) {
  const { seedDemoTenant } = await import("./services/demo/demoSeed.service");
  seedDemoTenant({
    adminEmail: env.DEMO_ADMIN_EMAIL!,
    adminPassword: env.DEMO_ADMIN_PASSWORD!,
    adminName: "Demo Reviewer",
  })
    .then((r) =>
      logger.info(
        { organizationId: r.organizationId, invoices: r.invoices, bills: r.bills },
        "[demo] tenant ready",
      ),
    )
    // A failed seed must be loud but must not take the API down — the banner
    // and the login page still need to serve, and the reset job records and
    // alarms on the same condition.
    .catch((err) => logger.error({ err }, "[demo] seeding FAILED — the demo has no data"));
}

// Stop polling before the process goes away, so an in-flight ZATCA submission
// is not abandoned mid-flight by a scheduled tick firing during shutdown.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "shutting down");
    getScheduler().stop();
    server.close(() => process.exit(0));
  });
}
