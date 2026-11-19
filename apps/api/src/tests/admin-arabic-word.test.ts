/**
 * 🔴 One Arabic word for the admin role (owner, 2026-11-19): "مسؤول" everywhere — the Users page and the refusals
 * already said it; the sidebar and a dozen sentences said "مدير", so the same role had two names on one screen.
 * Every user-facing source (the web app, the API's messages, the shared package) is held to it. No database.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "..", "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return ["tests", "generated", "node_modules", "dist"].includes(f) ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("the admin role has one Arabic name: مسؤول", () => {
  it("🔴 no user-facing source calls the admin مدير", () => {
    const hits: string[] = [];
    for (const d of ["apps/web/src", "apps/api/src", "packages/shared/src"]) {
      for (const p of files(join(root, d))) {
        readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
          if (line.includes("مدير")) hits.push(`${p.slice(root.length + 1).replace(/\\/g, "/")}:${i + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });

  it("🔴 the sidebar's role chip and the Users page say مسؤول", () => {
    expect(readFileSync(join(root, "apps/web/src/components/Layout.tsx"), "utf8")).toMatch(/admin: "مسؤول"/);
    expect(readFileSync(join(root, "apps/web/src/lib/walkLabels.ts"), "utf8")).toMatch(/admin: \["Admin", "مسؤول"\]/);
  });
});
