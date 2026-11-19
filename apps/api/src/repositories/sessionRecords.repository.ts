/**
 * 🔴 Phase 19A (19.4/19.5) — session records: IDENTITY LAYER, owner connection, like `user_sessions` and
 * `userAdmin.repository`. Every caller authorizes explicitly before it gets here (the session's own user, an admin of
 * THESE organizations with a confined target, or a platform operator); nothing here reads a tenant's business data.
 *
 * ACTIVE means: not ended, opened inside the absolute lifetime, and a live `user_sessions` row still carries it — so an
 * idle-expired, signed-out or deleted session is never listed, whatever its record says.
 */
import { ownerDb as db, sessionRecordsTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";

export interface SessionRow {
  id: string;
  userId: number;
  kind: string;
  createdAt: Date;
  lastSeenAt: Date;
  ipAddress: string | null;
  client: string | null;
}
export interface MemberSessionRow extends SessionRow {
  userName: string;
  userEmail: string;
}

/** The record's own live session, inside the 12-hour absolute lifetime (lib/auth.ts SESSION_ABSOLUTE_LIFETIME_MS). */
const LIVE = sql`r.ended_at IS NULL AND r.created_at > now() - interval '12 hours'
  AND EXISTS (SELECT 1 FROM user_sessions s WHERE s.sess ->> 'sessionRecordId' = r.id::text AND s.expire > now())`;

const COLUMNS = sql`r.id, r.user_id AS "userId", r.kind, r.created_at AS "createdAt", r.last_seen_at AS "lastSeenAt",
  r.ip_address AS "ipAddress", r.client`;

function rowsOf<T>(res: { rows: unknown[] }): T[] {
  return (res.rows as T[]).map((r) => ({ ...r, createdAt: new Date((r as any).createdAt), lastSeenAt: new Date((r as any).lastSeenAt) }));
}

export const sessionRecordsRepository = {
  async create(input: { userId: number; kind: "sign_in" | "signup" | "invitation"; ipAddress: string | null; client: string | null }): Promise<string> {
    const [row] = await db.insert(sessionRecordsTable).values(input).returning({ id: sessionRecordsTable.id });
    return row!.id;
  },

  /** What `endEndedSessions` asks on every request: is this user's record still open, and when was it last seen? */
  async openRecord(recordId: string, userId: number): Promise<{ lastSeenAt: Date } | undefined> {
    const [row] = await db
      .select({ lastSeenAt: sessionRecordsTable.lastSeenAt })
      .from(sessionRecordsTable)
      .where(and(eq(sessionRecordsTable.id, recordId), eq(sessionRecordsTable.userId, userId), isNull(sessionRecordsTable.endedAt)))
      .limit(1);
    return row;
  },

  async touch(recordId: string): Promise<void> {
    await db.update(sessionRecordsTable).set({ lastSeenAt: new Date() })
      .where(and(eq(sessionRecordsTable.id, recordId), isNull(sessionRecordsTable.endedAt)));
  },

  async activeForUser(userId: number): Promise<SessionRow[]> {
    return rowsOf<SessionRow>(await db.execute(sql`SELECT ${COLUMNS} FROM session_records r
      WHERE r.user_id = ${userId} AND ${LIVE} ORDER BY r.created_at DESC, r.id`));
  },

  /** Active sessions of the given accounts, with who they belong to. */
  async activeForUsers(userIds: number[]): Promise<MemberSessionRow[]> {
    if (userIds.length === 0) return [];
    return rowsOf<MemberSessionRow>(await db.execute(sql`SELECT ${COLUMNS}, u.name AS "userName", u.email AS "userEmail"
      FROM session_records r JOIN users u ON u.id = r.user_id
      WHERE r.user_id IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}) AND ${LIVE}
      ORDER BY u.name, r.created_at DESC, r.id`));
  },

  /** Platform operators' active sessions — the operator surface's own list. */
  async activeForOperators(): Promise<MemberSessionRow[]> {
    return rowsOf<MemberSessionRow>(await db.execute(sql`SELECT ${COLUMNS}, u.name AS "userName", u.email AS "userEmail"
      FROM session_records r JOIN users u ON u.id = r.user_id
      WHERE r.user_id IN (SELECT user_id FROM platform_operators) AND ${LIVE}
      ORDER BY u.name, r.created_at DESC, r.id`));
  },

  /** One active session by id, with its owner — for the acts that then authorize against the owner. */
  async activeById(recordId: string): Promise<SessionRow | undefined> {
    return rowsOf<SessionRow>(await db.execute(sql`SELECT ${COLUMNS} FROM session_records r WHERE r.id = ${recordId} AND ${LIVE}`))[0];
  },

  /**
   * End the given records (those still open), and delete the sessions that carry them. The deletion is hygiene; the
   * guarantee is `endEndedSessions` refusing an ended record on the next request.
   */
  async end(recordIds: string[], reason: "signed_out" | "ended_by_self" | "ended_by_admin" | "ended_by_operator", byUserId: number | null): Promise<string[]> {
    if (recordIds.length === 0) return [];
    const ids = sql.join(recordIds.map((id) => sql`${id}::uuid`), sql`, `);
    const ended = (await db.execute(sql`UPDATE session_records SET ended_at = now(), end_reason = ${reason}, ended_by_user_id = ${byUserId}
      WHERE id IN (${ids}) AND ended_at IS NULL RETURNING id`)).rows.map((r: any) => String(r.id));
    if (ended.length > 0) {
      await db.execute(sql`DELETE FROM user_sessions WHERE sess ->> 'sessionRecordId' IN (${sql.join(ended.map((id) => sql`${id}`), sql`, `)})`);
    }
    return ended;
  },

  /**
   * The accounts an admin of `orgIds` may see and end the sessions of: an ACTIVE member of one of them, a member of no
   * organization outside them (the confinement `assertAccountConfinedTo` applies to every account-wide act — a
   * session is account-wide), and not a platform operator.
   */
  async confinedMemberIds(orgIds: string[]): Promise<number[]> {
    if (orgIds.length === 0) return [];
    const orgs = sql.join(orgIds.map((o) => sql`${o}::uuid`), sql`, `);
    return (await db.execute(sql`SELECT DISTINCT m.user_id FROM organization_memberships m
      WHERE m.organization_id IN (${orgs}) AND m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM organization_memberships o WHERE o.user_id = m.user_id AND o.organization_id NOT IN (${orgs}))
        AND NOT EXISTS (SELECT 1 FROM platform_operators p WHERE p.user_id = m.user_id)
      ORDER BY 1`)).rows.map((r: any) => Number(r.user_id));
  },
};
