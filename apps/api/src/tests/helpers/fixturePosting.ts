/**
 * 🔴 A15 (owner decision 2026-11-17) — a SYNTHETIC entry through the posting seam, tagged `test_fixture`.
 *
 * For a test whose subject is the seam itself (its balance guard, its party rules, a bank leaf, a calendar date, a
 * period lock) or a report that reads the ledger, where no document stands behind the entry. The seam's own type cannot
 * name `test_fixture` (`postJournalEntry`'s `sourceType`), so the tag is passed here, and the database admits it only
 * because this helper declares it first, in the caller's own transaction (`journal_entries_source_tag_guard`, 0163).
 * A test of a document's own behaviour calls the seam with that document's tag instead.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { postJournalEntry } from "../../services/accounting/glPosting";
import { SYNTHETIC_SOURCE_SETTING, TEST_FIXTURE_SOURCE } from "./journalFixtures";

type SeamOptions = Parameters<typeof postJournalEntry>[0];
export type FixturePostingOptions = Omit<SeamOptions, "sourceType" | "sourceId">;

/** Posts `opts` through the seam as `test_fixture`, inside the caller's tenant transaction. */
export async function postFixtureJournalEntry(opts: FixturePostingOptions): ReturnType<typeof postJournalEntry> {
  await db.execute(sql`SELECT set_config(${SYNTHETIC_SOURCE_SETTING}, ${TEST_FIXTURE_SOURCE}, true)`);
  try {
    return await postJournalEntry({ ...opts, sourceType: TEST_FIXTURE_SOURCE } as unknown as SeamOptions);
  } finally {
    // An aborted transaction cannot run this, and is rolled back by its caller — which reverts the setting anyway.
    await db.execute(sql`SELECT set_config(${SYNTHETIC_SOURCE_SETTING}, '', true)`).catch(() => undefined);
  }
}
