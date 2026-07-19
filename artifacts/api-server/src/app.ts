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

// Trust the Replit reverse proxy so express-session sets Secure cookies correctly
app.set("trust proxy", 1);

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

// Session middleware — backed by PostgreSQL (auto-creates "session" table on first run)
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
      maxAge: 8 * 60 * 60 * 1000, // 8-hour session
      httpOnly: true,
      // "none" + secure required: Replit preview iframe (*.replit.dev) is
      // embedded inside replit.com — browsers block SameSite=Lax cookies
      // in cross-site iframe contexts (Chrome 80+).
      sameSite: "none",
      secure: true,
    },
  }),
);

app.use("/api", router);

export default app;
