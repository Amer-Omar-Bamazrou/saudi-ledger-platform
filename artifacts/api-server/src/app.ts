import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

const PgSession = connectPgSimple(session);

const app: Express = express();

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

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Replit proxy cookie fix ────────────────────────────────────────────────────
// The Replit TLS proxy does NOT forward X-Forwarded-Proto, so express-session's
// `secure: true` would silently skip setting Set-Cookie entirely.
// Instead we use `secure: false` (so express-session always writes the cookie),
// then this middleware patches every outgoing Set-Cookie header to add the
// `Secure` attribute — which Chrome requires when SameSite=None is used.
// SameSite=None is required because the Replit preview is an iframe at
// replit.com (different eTLD+1 from *.replit.dev), making requests cross-site.
app.use((_req, res, next) => {
  const origSetHeader = res.setHeader.bind(res);
  // @ts-ignore — override to intercept Set-Cookie
  res.setHeader = (name: string, value: unknown) => {
    if (name.toLowerCase() === "set-cookie") {
      const arr = (Array.isArray(value) ? value : [String(value)]) as string[];
      value = arr.map((c) =>
        c.toLowerCase().includes("secure") ? c : c + "; Secure"
      );
    }
    return origSetHeader(name, value as any);
  };
  next();
});

// Session middleware — backed by PostgreSQL
app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    name: "ksa_ledger_sid",
    secret: process.env["SESSION_SECRET"] ?? "change-me-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      httpOnly: true,
      // SameSite=None lets the cookie cross the replit.com → *.replit.dev
      // iframe boundary. Secure is injected by the middleware above rather
      // than here, so that express-session always writes the header.
      sameSite: "none",
      secure: false,
    },
  }),
);

app.use("/api", router);

export default app;
