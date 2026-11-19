import { pgTable, uuid, integer, varchar, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

/**
 * 🔴 Phase 19A (19.4/19.5, owner approval 2026-11-17) — ONE RECORD PER SIGN-IN, the thing a person sees as "a session"
 * and ends. Identity layer, like `user_sessions` beside it: no organization, no RLS, OWNER-ONLY (the application role
 * holds nothing on it; 0165 revokes explicitly), read and written on the owner connection by the identity layer only.
 *
 * It never holds the session ID — that is a bearer credential and stays in `user_sessions`. The session carries this
 * record's id instead (`req.session.sessionRecordId`), and `endEndedSessions` refuses a session whose record has ended
 * (or that carries none: a session from before records existed fails closed, once).
 *
 * A record is ACTIVE while it has not ended AND a live `user_sessions` row carries it — an idle-expired or deleted
 * session is not shown, whatever this row says. Ending is recorded once: the database refuses un-ending a record and
 * refuses rewriting who, when, how and from where (0165's trigger); only `last_seen_at` moves while it is open.
 *
 * Personal data (PDPL, proposal §5.2): the sign-in IP and a COARSE client description ("Chrome · Windows"), never the
 * full user-agent. Retention is an open question for the PDPL adviser (Q-PDPL).
 */
export const sessionRecordsTable = pgTable(
  "session_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    /** How the session was opened: a sign-in, a signup, an accepted invitation. */
    kind: varchar("kind", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: varchar("ip_address", { length: 45 }),
    client: varchar("client", { length: 80 }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: integer("ended_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
    /** signed_out · ended_by_self · ended_by_admin · ended_by_operator */
    endReason: varchar("end_reason", { length: 30 }),
  },
  (t) => [
    index("session_records_user_idx").on(t.userId, t.createdAt),
    check("session_records_kind_chk", sql`${t.kind} in ('sign_in', 'signup', 'invitation')`),
    check("session_records_end_chk", sql`(${t.endedAt} is null) = (${t.endReason} is null)`),
    check("session_records_reason_chk", sql`${t.endReason} is null or ${t.endReason} in ('signed_out', 'ended_by_self', 'ended_by_admin', 'ended_by_operator')`),
  ],
);

export type SessionRecord = typeof sessionRecordsTable.$inferSelect;
