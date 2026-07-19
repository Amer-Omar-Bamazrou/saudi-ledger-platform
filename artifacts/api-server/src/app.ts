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
      sameSite: "lax",
      secure: false,
    },
  }),
);

// ── Bearer-token session loader ───────────────────────────────────────────────
// The Replit preview is an iframe inside replit.com. Chrome blocks third-party
// cookies from cross-site iframes, so the session cookie never reaches the
// browser. Instead, the login route returns req.sessionID as a plain token.
// The client stores it in localStorage and sends it as "Authorization: Bearer
// <sessionID>" on every request. This middleware loads the matching session row
// from PostgreSQL and populates req.session so requireAuth works normally.
app.use((req, _res, next) => {
  // Cookie-based session already worked — nothing to do.
  if (req.session?.userId) { next(); return; }

  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) { next(); return; }

  const sid = auth.slice(7).trim();
  if (!sid) { next(); return; }

  req.sessionStore.get(sid, (err, data) => {
    if (err || !data) { next(); return; }
    const s = data as any;
    req.session.userId    = s.userId;
    req.session.userRole  = s.userRole;
    req.session.userName  = s.userName;
    req.session.userEmail = s.userEmail;
    next();
  });
});

app.use("/api", router);

export default app;
