import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import { loadEnv } from "@workspace/config";
import router from "./routes";
import { logger } from "./lib/logger";

const env = loadEnv();
const isProduction = env.NODE_ENV === "production";

const PgSession = connectPgSimple(session);

const app: Express = express();

// Behind a TLS-terminating reverse proxy in production: trust the first proxy so
// `secure` cookies are honored and express-rate-limit keys on the real client IP.
if (isProduction) {
  app.set("trust proxy", 1);
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
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
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
      secure: isProduction, // require HTTPS for the cookie in production
    },
  }),
);

app.use("/api", router);

export default app;
