/**
 * M12.2 — THE AUTHORITATIVE CHECK: our generated UBL, run through ZATCA's own
 * Compliance & Enablement Toolbox (SDK).
 *
 * The SDK ships NO sample invoices, so there is no golden file to diff against.
 * The loop is instead: generate → `-sign` (with the SDK's bundled test
 * certificate) → `-validate` (XSD + EN 16931 + 55 BR-KSA schematron rules).
 * That answers the question that actually matters — "is our XML valid?" — which
 * is the only defence against the spec's own errors. Two of those errors have
 * already bitten (see docs/zatca/security-standards-notes.md), and BR-KSA-10's
 * hidden `cbc:CountrySubentity` requirement was found by this very harness.
 *
 * ── Why the SIGNATURE result is deliberately NOT asserted ───────────────────
 * The SDK's bundled certificate (`Data/Certificates/cert.pem`) EXPIRED on
 * 18 April 2024, and its subject VAT (312345678900003) is not our fixture's
 * seller. So `[SIGNATURE] validation result : FAILED` is guaranteed regardless
 * of what we generate — it says nothing about our document. Real signature
 * verification arrives with M12.3 (our own keys) and M12.4 (a sandbox CSID).
 * We assert on XSD, EN, KSA and QR — every stage M12.2 is responsible for.
 *
 * ── Requirements ───────────────────────────────────────────────────────────
 * Java + the SDK on disk (`docs/zatca/fetch-sdk.sh`). The suite SKIPS LOUDLY
 * when either is missing rather than silently passing — a green run that
 * proved nothing is worse than a visible gap (the M11.4 lesson).
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { simplifiedInvoice, standardInvoice } from "../services/einvoice/__fixtures__/sampleInput";
import type { EInvoiceInput } from "../services/einvoice/types";

const SDK_ROOT = resolve(__dirname, "../../../../docs/zatca/sdk/extracted/zatca-envoice-sdk-203");
const JAR = join(SDK_ROOT, "Apps", "cli-3.0.8-jar-with-dependencies.jar");
const CONFIG = join(SDK_ROOT, "Configuration", "config.json");

function hasJava(): boolean {
  try {
    execFileSync("java", ["-version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const SDK_PRESENT = existsSync(JAR);
const JAVA_PRESENT = hasJava();
const CAN_RUN = SDK_PRESENT && JAVA_PRESENT;

if (!CAN_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[ubl-zatca-validator] SKIPPED — this is the ONLY authoritative check that our\n` +
      `  UBL is valid. It proves nothing when skipped.\n` +
      `    Java present: ${JAVA_PRESENT}\n` +
      `    SDK present : ${SDK_PRESENT} (${JAR})\n` +
      `  Fetch the SDK with: ./docs/zatca/fetch-sdk.sh\n`,
  );
}

const describeMaybe = CAN_RUN ? describe : describe.skip;

/**
 * The SDK resolves its paths from the `SDK_CONFIG` env var.
 *
 * It exits NON-ZERO when validation fails, which is a legitimate outcome we
 * need to inspect (the BR-KSA-10 regression case depends on it), so the output
 * is recovered from the error rather than allowed to throw.
 */
function runSdk(args: string[]): string {
  try {
    return execFileSync("java", ["-jar", JAR, "--globalVersion", "3.0.8", "-certpassword", "123456789", ...args], {
      env: { ...process.env, SDK_CONFIG: CONFIG },
      encoding: "utf8",
      stdio: "pipe",
      cwd: join(SDK_ROOT, "Apps"),
    });
  } catch (err: any) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    if (!out) throw err;
    return out;
  }
}

interface ValidationReport {
  xsd?: string;
  en?: string;
  ksa?: string;
  qr?: string;
  signature?: string;
  errors: string[];
}

function parseReport(output: string): ValidationReport {
  const report: ValidationReport = { errors: [] };
  for (const line of output.split(/\r?\n/)) {
    const stage = line.match(/\[(XSD|EN|KSA|QR|SIGNATURE)\] validation result : (\w+)/);
    if (stage) {
      const key = stage[1].toLowerCase() as keyof ValidationReport;
      (report as any)[key] = stage[2];
    }
    const err = line.match(/CODE : ([^,]+), MESSAGE : (.*)$/);
    if (err) report.errors.push(`${err[1].trim()}: ${err[2].trim()}`);
  }
  return report;
}

// Each case shells out to Java twice (sign + validate); the JVM plus schematron
// transforms take tens of seconds, far past vitest's 5s default.
const SDK_TIMEOUT = 180_000;

describeMaybe("M12.2 — generated UBL passes ZATCA's own SDK validator", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zatca-ubl-"));

    // The SDK ships `Configuration/config.json` with hardcoded `D:\...` paths
    // from whatever machine ZATCA built it on — useless anywhere else, and
    // especially on Linux CI. Rebuild it from `defaults.json` (whose paths are
    // relative to Apps/) against wherever the SDK actually lives now. Doing
    // this here rather than in fetch-sdk.sh keeps the test self-contained: it
    // works from a cold download, a warm cache, or a manual extract alike.
    const defaults = JSON.parse(readFileSync(join(SDK_ROOT, "Configuration", "defaults.json"), "utf8"));
    const resolved = Object.fromEntries(
      Object.entries(defaults).map(([k, v]) =>
        typeof v === "string" && v.startsWith("../") ? [k, join(SDK_ROOT, v.slice(3))] : [k, v],
      ),
    );
    writeFileSync(CONFIG, JSON.stringify(resolved, null, 2));
  });

  /** generate → sign → validate, returning the parsed stage results. */
  function validate(name: string, input: EInvoiceInput): ValidationReport {
    const unsigned = join(dir, `${name}.xml`);
    const signed = join(dir, `${name}-signed.xml`);
    writeFileSync(unsigned, buildInvoiceXml(input));

    const signOut = runSdk(["-sign", "-invoice", unsigned, "-signedInvoice", signed]);
    expect(signOut, "the SDK must be able to sign our document").toContain("signed successfully");

    return parseReport(runSdk(["-validate", "-invoice", signed]));
  }

  it("STANDARD (B2B) invoice passes XSD, EN 16931 and all BR-KSA rules", () => {
    const r = validate("standard", standardInvoice());
    expect(r.errors, `validator reported: ${r.errors.join(" | ")}`).toEqual([]);
    expect(r.xsd).toBe("PASSED");
    expect(r.en).toBe("PASSED");
    expect(r.ksa).toBe("PASSED");
  }, SDK_TIMEOUT);

  it("SIMPLIFIED (B2C) invoice passes XSD, EN 16931, BR-KSA and QR", () => {
    const r = validate("simplified", simplifiedInvoice());
    // The SIGNATURE stage is expected to fail — the SDK's bundled cert expired
    // in April 2024 (see the module docstring), so filter it out and assert on
    // everything M12.2 actually owns.
    const realErrors = r.errors.filter((e) => !e.startsWith("signatureValue"));
    expect(realErrors, `validator reported: ${realErrors.join(" | ")}`).toEqual([]);
    expect(r.xsd).toBe("PASSED");
    expect(r.en).toBe("PASSED");
    expect(r.ksa).toBe("PASSED");
    expect(r.qr).toBe("PASSED");
  }, SDK_TIMEOUT);

  it("a B2C sale with NO buyer at all still passes XSD", () => {
    // cac:AccountingCustomerParty is mandatory in UBL even when empty; omitting
    // it fails XSD before any KSA rule is reached.
    const r = validate("no-buyer", simplifiedInvoice({ buyer: null }));
    expect(r.xsd).toBe("PASSED");
    expect(r.ksa).toBe("PASSED");
  }, SDK_TIMEOUT);

  it("REGRESSION: dropping the buyer province reproduces BR-KSA-10", () => {
    // The rule's message names only street/city/postal/country, but the actual
    // assertion also requires cbc:CountrySubentity. This test pins that finding
    // so a future 'cleanup' of the province field fails loudly here.
    const input = standardInvoice();
    const r = validate("no-province", {
      ...input,
      buyer: { ...input.buyer!, address: { ...input.buyer!.address, province: null } },
    });
    expect(r.ksa).toBe("FAILED");
    expect(r.errors.join(" ")).toContain("BR-KSA-10");
  }, SDK_TIMEOUT);
});
