/**
 * 🔴 19B — what the browser suite concludes from the server's capture of unclassified fields (pure; the teardown reads
 * the file and calls this, and src/lib/fieldClassCapture.test.ts holds it).
 *
 * The server writes one line per response in which a field the class table cannot classify was WITHHELD (default deny,
 * a non-admin) or SERVED (the admin, or a request with no organization role) — the route, the role and the NAMES of
 * the fields, never a value — and one `started` line when it boots with the capture named.
 *
 *  - any such line fails the run, by name;
 *  - 🔴 no `started` line means the capture was never on: in CI, where the suite always starts the server itself, that
 *    fails the run ("nothing was withheld" from a capture that was off is not a result); locally, where a server
 *    already up on the port is reused, it is said and does not fail.
 */
export interface CaptureLine { started?: boolean; denied?: boolean; route?: string; role?: string; fields?: string[] }
export type CaptureVerdict = { ok: true; measured: boolean; note: string } | { ok: false; error: string };

export function judgeCapture(text: string | null, ci: boolean): CaptureVerdict {
  const lines: CaptureLine[] = (text ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CaptureLine);
  if (!lines.some((l) => l.started === true)) {
    const why = text === null ? "the capture file was never written" : "the capture file has no `started` line";
    if (ci) return { ok: false, error: `default deny: ${why} — the server did not start with FIELD_CLASS_CAPTURE_FILE, so this run says nothing about what was withheld` };
    return { ok: true, measured: false, note: `[default-deny] ${why}: the server on the port was not started by this run, so what it withheld as unclassified was not measured here` };
  }
  const found = lines.filter((l) => l.started !== true);
  if (found.length) {
    const named = [...new Set(found.map((l) => `${l.denied ? `WITHHELD from ${l.role}` : `served unclassified to ${l.role ?? "the admin or a request with no organization role"}`} — ${l.route}: ${(l.fields ?? []).join(", ")}`))];
    return { ok: false, error: `default deny: the server met ${named.length} response(s) with fields the class table cannot classify. Give each a class (lib/fieldClasses/classTable.ts or outsideContract.ts):\n  ${named.join("\n  ")}` };
  }
  return { ok: true, measured: true, note: "[default-deny] the capture was on, and nothing unclassified was served or withheld in this run" };
}
