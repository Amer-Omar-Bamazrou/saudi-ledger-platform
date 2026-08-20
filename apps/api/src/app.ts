import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { sessionPool } from "@workspace/db";
import { loadEnv } from "@workspace/config";
import router from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { logger } from "./lib/logger";

const env = loadEnv();
const isProduction = env.NODE_ENV === "production";

const PgSession = connectPgSimple(session);

const app: Express = express();

/**
 * 🔴 C1 — proxy trust is now an EXPLICIT deployment fact, not inferred.
 *
 * Two problems with keying this off `NODE_ENV === "production"`:
 *
 *  1. **It was wrong in both directions.** A deployment named anything else
 *     ("staging") ran WITHOUT `trust proxy` — so `req.ip` was the proxy's
 *     address, every IP-keyed limiter collapsed onto one bucket, and the
 *     session cookie shipped without `Secure` (audit 2026-08-20). And a
 *     production deploy WITHOUT a proxy would trust an `X-Forwarded-For`
 *     header any client can forge, which makes every IP-keyed limit a no-op.
 *  2. **The number matters.** `trust proxy` must equal the count of proxies
 *     that actually rewrite the header; more, and a client-supplied hop is
 *     believed; fewer, and the real client IP is never reached.
 *
 * `TRUST_PROXY_HOPS` states it. Default 0 = no proxy = use the socket address,
 * which is the safe posture for a direct-to-node deployment. C1's remaining
 * half is a deployment-time check: confirm exactly one proxy rewrites XFF.
 */
if (env.TRUST_PROXY_HOPS > 0) {
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// Explicit CORS allow-list from config (replaces the old reflect-any
// `origin: true`, which combined with credentials let any site call the API).
app.use(
  cors({
    origin: env.CORS_ALLOWED_ORIGINS,
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware — backed by PostgreSQL. Auth is the httpOnly session cookie
// only: the previous localStorage bearer-token workaround (a Replit cross-site
// iframe hack that exposed the raw session id to JS) has been removed entirely.
app.use(
  session({
    store: new PgSession({
      pool: sessionPool,
      tableName: "user_sessions",
      // The table is provisioned by migration 0005 (createTableIfMissing's
      // runtime path is unreliable in the esbuild bundle — see 0005).
      createTableIfMissing: false,
    }),
    name: "ksa_ledger_sid",
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh the cookie's max-age on activity
    cookie: {
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      httpOnly: true,
      sameSite: "lax",
      // C1: explicit, defaulting to ON in production. `loadEnv` refuses a
      // production boot with this set false (a session cookie in clear text).
      secure: env.SESSION_COOKIE_SECURE ?? isProduction,
    },
  }),
);

app.use("/api", router);

/**
 * OPTIONALLY serve the built frontend from this process (`SERVE_WEB_DIST`).
 *
 * 🔴 Default OFF, and unset everywhere today — this changes nothing for any
 * existing deployment. It exists because a single-origin deployment is
 * materially SAFER for this app than a split one, not merely cheaper: auth is
 * an httpOnly session cookie, and splitting the frontend onto its own origin
 * forces `SameSite=None` plus a credentialed CORS allow-list — loosening two
 * cookie protections to solve a hosting-layout problem. Same origin keeps
 * `sameSite: strict` and needs no CORS entry at all.
 *
 * Mounted AFTER `/api` so a route can never be shadowed by a file, and the SPA
 * fallback deliberately excludes `/api` so an unknown endpoint still returns
 * the API's 404 JSON rather than an HTML page a fetch caller cannot parse.
 */
if (env.SERVE_WEB_DIST) {
  const dist = env.SERVE_WEB_DIST;
  app.use(express.static(dist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res, next) => {
    res.sendFile("index.html", { root: dist }, (err) => {
      if (err) next(err);
    });
  });
  logger.info({ dist }, "serving the web build from this process");
}

// Centralized error handler — must be registered last, after the router.
app.use(errorHandler);

export default app;
