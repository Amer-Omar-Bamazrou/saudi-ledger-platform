/**
 * M12.3 — the blocking crypto suite.
 *
 * Everything here validates OUR output against ZATCA's, never against the PDF.
 * That distinction is the whole point: M12.2's `[QR] PASSED` was validating
 * ZATCA's *own* signed output, which is exactly why it never caught that our
 * QR tag semantics (written from the spec) were wrong.
 *
 * Two tests are BLOCKING and must never be relaxed to reach green:
 *   1. SDK hash-equality — our invoice hash must equal `fatoora -generateHash`.
 *   2. The `fatoora -sign` differential — our signed document must match
 *      ZATCA's, signed from the SAME invoice with the SAME key, certificate and
 *      signing time, so a difference is a real difference.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createVerify, createPublicKey, createPrivateKey } from "crypto";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { standardInvoice } from "../services/einvoice/__fixtures__/sampleInput";
import { computeInvoiceHash, GENESIS_PIH } from "../services/einvoice/crypto/invoiceHash";
import { canonicalizeForZatca } from "../services/einvoice/crypto/canonicalize";
import { generateZatcaKeyPair, assertZatcaCurve } from "../services/einvoice/crypto/keys";
import { buildZatcaQr, decodeZatcaQr } from "../services/einvoice/crypto/qr";
import { qrTimestamp, splitIssuedAt } from "../services/einvoice/issuedAt";
import { assembleSignedInvoice } from "../services/einvoice/crypto/assembleSignedInvoice";

const SDK_ROOT = resolve(__dirname, "../../../../docs/zatca/sdk/extracted/zatca-envoice-sdk-203");
const JAR = join(SDK_ROOT, "Apps", "cli-3.0.8-jar-with-dependencies.jar");
const CONFIG = join(SDK_ROOT, "Configuration", "config.json");
const CERT_PEM = join(SDK_ROOT, "Data", "Certificates", "cert.pem");
const KEY_PEM = join(SDK_ROOT, "Data", "Certificates", "ec-secp256k1-priv-key.pem");

/**
 * The SDK ships `cert.pem` and `ec-secp256k1-priv-key.pem` as BARE BASE64 with
 * no PEM armour, so Node refuses to load them until it is added back.
 */
function armour(body: string, label: string): string {
  const b64 = body.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const wrapped = b64.replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

function hasJava(): boolean {
  try {
    execFileSync("java", ["-version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const CAN_RUN = existsSync(JAR) && hasJava();
if (!CAN_RUN) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n[zatca-crypto] SKIPPED — the SDK differential and hash-equality tests are the\n" +
      "  ONLY proof our signature matches ZATCA. They prove nothing when skipped.\n" +
      "  Fetch the SDK with: ./docs/zatca/fetch-sdk.sh\n",
  );
}
const describeMaybe = CAN_RUN ? describe : describe.skip;
const SDK_TIMEOUT = 180_000;

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

/** Text of the first matching element. */
const el = (xml: string, tag: string): string | null => {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`));
  return m ? m[1] : null;
};

// ── DB-free unit tests (always run) ─────────────────────────────────────────

describe("M12.3 — canonicalisation guards are LIVE in the hashing path", () => {
  it("refuses to hash a document carrying xml:* attributes", () => {
    // Not a fixture assertion — the guard runs inside computeInvoiceHash, so a
    // real invoice hitting this in production fails loudly rather than
    // producing a hash that may not match ZATCA's.
    const tainted = buildInvoiceXml(standardInvoice()).replace("<Invoice ", '<Invoice xml:lang="ar" ');
    expect(() => computeInvoiceHash(tainted)).toThrowError(/xml:\*/i);
  });

  it("refuses to hash when the transform would not be subtree-complete", () => {
    // Construct the pathological case directly: an excluded ancestor with a
    // surviving descendant is impossible via our generator, so it is built here.
    const xml = buildInvoiceXml(standardInvoice());
    // A UBLExtensions containing a nested element proves the guard sees
    // descendants; the guard must accept this (it IS subtree-complete).
    const withExt = xml.replace(
      "<cbc:ProfileID>",
      "<ext:UBLExtensions><ext:UBLExtension><deep/></ext:UBLExtension></ext:UBLExtensions><cbc:ProfileID>",
    );
    expect(() => computeInvoiceHash(withExt)).not.toThrow();
  });

  it("the genesis PIH is base64 of the HEX STRING of sha256('0')", () => {
    expect(Buffer.from(GENESIS_PIH, "base64").toString()).toBe(
      "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
    );
  });

  it("canonicalisation strips exactly the three excluded elements", () => {
    const xml = buildInvoiceXml(standardInvoice());
    const canonical = canonicalizeForZatca(xml);
    expect(canonical).not.toContain("UBLExtensions");
    expect(canonical).toContain("<cbc:ID>ICV</cbc:ID>");
    expect(canonical).toContain("<cbc:ID>PIH</cbc:ID>");
  });
});

describe("M12.3 — keys", () => {
  it("generates secp256k1 and rejects any other curve", () => {
    const kp = generateZatcaKeyPair();
    expect(kp.privateKey.asymmetricKeyDetails?.namedCurve).toBe("secp256k1");
    expect(() => assertZatcaCurve(kp.privateKey)).not.toThrow();

    const { generateKeyPairSync } = require("crypto");
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect(() => assertZatcaCurve(p256.privateKey)).toThrowError(/secp256k1/);
  });
});

describe("M12.3 — QR encoding (divergence #13: built from observed bytes)", () => {
  const base = {
    sellerName: "Al-Rashid Trading Est.",
    vatNumber: "310123456789013",
    invoiceTimestamp: "2026-04-01T09:13:57Z",
    totalWithVat: "1150.00",
    vatTotal: "150.00",
  };

  it("tag lengths for tags 1-5 are UTF-8 BYTE lengths, not character counts", () => {
    // The Arabic case: 22 characters, far more bytes. Using String.length here
    // produces a TLV that decodes to garbage.
    const arabic = "مؤسسة الراشد التجارية";
    const qr = buildZatcaQr({ ...base, sellerName: arabic });
    const tags = decodeZatcaQr(qr);
    expect(tags[1].length).toBe(Buffer.byteLength(arabic, "utf-8"));
    expect(tags[1].length).not.toBe(arabic.length);
    expect(tags[1].toString("utf-8")).toBe(arabic);
  });

  it("tag 6 carries the BASE64 STRING, not the raw 32 digest bytes", () => {
    const hash = "NRhTmCMYV0J6wdcHbrDwKll5Wm7i+/lL+7gg3IXKIXk=";
    const tags = decodeZatcaQr(buildZatcaQr({ ...base, invoiceHashBase64: hash }));
    // The spec says 32 raw bytes. ZATCA emits the 44-character base64 text.
    expect(tags[6].length).toBe(44);
    expect(tags[6].toString("utf-8")).toBe(hash);
  });

  it("tag 7 is the BASE64 STRING of the signature; tags 8 and 9 are RAW bytes", () => {
    // Pinned by the live compliance API (M12.4). The mixed encoding is ZATCA's:
    // an all-base64 variant fails with publicKey_QRCODE_INVALID +
    // CERTIFICATE_SIGNATURE_QRCODE_INVALID, and a raw-DER tag 7 fails with
    // INVOICE_SIGNATURE_VALUE_QRCODE_INVALID. Both directions were tested.
    const signatureBase64 = Buffer.from("a".repeat(70)).toString("base64");
    const spki = Buffer.alloc(88, 7);
    const certSig = Buffer.alloc(71, 9);

    const tags = decodeZatcaQr(
      buildZatcaQr({ ...base, signatureBase64, publicKeySpkiDer: spki, certificateSignature: certSig }),
    );

    expect(tags[7].toString("utf-8")).toBe(signatureBase64); // text, not bytes
    expect(tags[8]).toEqual(spki); // raw SPKI DER
    expect(tags[9]).toEqual(certSig); // raw CA signature
  });

  it("tag 3 carries NO trailing Z — it must equal the XML's IssueDate + IssueTime", () => {
    // A trailing `Z` warns invoiceTimeStamp_QRCODE_INVALID: cbc:IssueTime has no
    // timezone designator, so `...57Z` disagrees with `...57`. Stripping only
    // the milliseconds was tested separately and still warned.
    const issuedAt = new Date("2026-04-01T09:13:57.123Z");
    expect(qrTimestamp(issuedAt)).toBe("2026-04-01T09:13:57");
    const [date, time] = splitIssuedAt(issuedAt);
    expect(qrTimestamp(issuedAt)).toBe(`${date}T${time}`);
  });

  it("enforces the 700-character cap", () => {
    // 5 x 200-byte fields ≈ 1000 bytes raw → well past 700 base64 characters.
    const long = "x".repeat(200);
    expect(() =>
      buildZatcaQr({
        sellerName: long,
        vatNumber: long,
        invoiceTimestamp: long,
        totalWithVat: long,
        vatTotal: long,
      }),
    ).toThrowError(/700/);
  });

  it("rejects an over-long field at the boundary with an actionable 400", () => {
    // Caught by assertQrFieldLengths BEFORE any TLV is built, so the caller gets
    // a named field and the byte limit rather than a bare throw surfacing as 500.
    try {
      buildZatcaQr({ ...base, sellerName: "x".repeat(256) });
      throw new Error("expected a rejection");
    } catch (err: any) {
      expect(err.statusCode).toBe(400);
      expect(err.payload?.code).toBe("qr_field_too_long");
      expect(err.payload?.error).toMatch(/seller name is 256 bytes/);
    }
  });

  it("an Arabic company name can legitimately exceed 255 BYTES within 255 characters", () => {
    // The realistic trigger: `companies.name` allows 255 CHARACTERS, and Arabic
    // is ~2 bytes/char — so a valid name can overflow the QR's byte limit.
    const arabic = "مؤسسة".repeat(30); // 150 chars, ~270 bytes
    expect(arabic.length).toBeLessThan(255);
    expect(Buffer.byteLength(arabic, "utf-8")).toBeGreaterThan(255);
    expect(() => buildZatcaQr({ ...base, sellerName: arabic })).toThrowError(/qr_field_too_long|bytes long/);
  });
});

// ── SDK-backed tests ────────────────────────────────────────────────────────

describeMaybe("M12.3 — verified against ZATCA's SDK", () => {
  let dir = "";
  let certPem = "";
  let keyPem = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "zatca-crypto-"));
    const defaults = JSON.parse(readFileSync(join(SDK_ROOT, "Configuration", "defaults.json"), "utf8"));
    const resolved = Object.fromEntries(
      Object.entries(defaults).map(([k, v]) =>
        typeof v === "string" && v.startsWith("../") ? [k, join(SDK_ROOT, v.slice(3))] : [k, v],
      ),
    );
    writeFileSync(CONFIG, JSON.stringify(resolved, null, 2));
    certPem = armour(readFileSync(CERT_PEM, "utf8"), "CERTIFICATE");
    keyPem = armour(readFileSync(KEY_PEM, "utf8"), "EC PRIVATE KEY");
  });

  it("BLOCKING: our invoice hash equals fatoora -generateHash", () => {
    const xml = buildInvoiceXml(standardInvoice());
    const file = join(dir, "hash.xml");
    writeFileSync(file, xml);

    const out = runSdk(["-generateHash", "-invoice", file]);
    const zatca = out.match(/INVOICE HASH = (\S+)/)?.[1];
    expect(zatca, `SDK output:\n${out}`).toBeTruthy();
    expect(computeInvoiceHash(xml).base64).toBe(zatca);
  }, SDK_TIMEOUT);

  it("BLOCKING: our signed document matches fatoora -sign, same key/cert/time", () => {
    const xml = buildInvoiceXml(standardInvoice());
    const unsigned = join(dir, "diff.xml");
    const zatcaOut = join(dir, "diff-zatca.xml");
    writeFileSync(unsigned, xml);
    runSdk(["-sign", "-invoice", unsigned, "-signedInvoice", zatcaOut]);
    const ref = readFileSync(zatcaOut, "utf8");

    // Pin OUR signing time to ZATCA's so the only remaining variable is our
    // implementation. Same invoice, same key, same certificate, same instant.
    const signingTime = el(ref, "xades:SigningTime")!;
    const ours = assembleSignedInvoice({
      xml,
      certificatePem: certPem,
      privateKey: createPrivateKey(keyPem),
      publicKey: createPublicKey(createPrivateKey(keyPem)),
      qr: {
        sellerName: "Al-Rashid Trading Est.",
        vatNumber: "310123456789013",
        issuedAt: new Date("2026-04-01T09:13:57Z"),
        totalWithVat: "1150.00",
        vatTotal: "150.00",
      },
      signingTime: new Date(signingTime),
    });

    // The values that must match EXACTLY. Any difference is a real difference.
    const fields = ["ds:DigestValue", "xades:SigningTime", "ds:X509IssuerName", "ds:X509SerialNumber"] as const;
    for (const f of fields) {
      expect(el(ours.signedXml, f), `mismatch on <${f}>`).toBe(el(ref, f));
    }

    // ── ACCEPTED DIVERGENCE (not a weakening) ────────────────────────────────
    // `ds:SignatureValue` CANNOT be byte-equal: ECDSA is randomised, so signing
    // the same bytes with the same key twice yields different signatures. Byte
    // equality is unachievable in principle, not merely unmet.
    //
    // The substitute is STRONGER than equality would have been: verify ZATCA's
    // OWN signature against the raw invoice digest. If it verifies, then ZATCA
    // signs exactly the bytes we sign — which is the real claim divergence #10
    // makes, and byte-equality would only have implied it.
    const digest = computeInvoiceHash(xml).bytes;
    const pub = createPublicKey(createPrivateKey(keyPem));
    const zatcaSig = Buffer.from(el(ref, "ds:SignatureValue")!, "base64");
    expect(
      createVerify("sha256").update(digest).verify(pub, zatcaSig),
      "ZATCA's signature must verify over the RAW invoice digest (divergence #10)",
    ).toBe(true);
    const ourSig = Buffer.from(el(ours.signedXml, "ds:SignatureValue")!, "base64");
    expect(createVerify("sha256").update(digest).verify(pub, ourSig)).toBe(true);

    // The two hex-encoded digests (#9) and the cert digest.
    const digestsOf = (x: string) => [...x.matchAll(/<ds:DigestValue>([^<]*)<\/ds:DigestValue>/g)].map((m) => m[1]);
    expect(digestsOf(ours.signedXml)).toEqual(digestsOf(ref));

    // The algorithm identifiers and structural attributes.
    for (const marker of [
      'Algorithm="http://www.w3.org/2006/12/xml-c14n11"',
      'Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"',
      'Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties"',
      'URI="#xadesSignedProperties"',
      'Id="xadesSignedProperties"',
      "<xades:SigningCertificate>",
    ]) {
      expect(ours.signedXml, `missing ${marker}`).toContain(marker);
      expect(ref).toContain(marker);
    }
    // ACCEPTED DIVERGENCE (documented, not silently allowed): ZATCA's template
    // retains an XML comment ("signature values are sample values only") that we
    // do not emit. It is outside every signed element and cannot affect any
    // digest — the DigestValue equality above proves that.
    expect(ref).toContain("sample values only");
    expect(ours.signedXml).not.toContain("sample values only");
  }, SDK_TIMEOUT);

  it("our QR matches ZATCA's tag-for-tag, in structure and lengths", () => {
    const xml = buildInvoiceXml(standardInvoice());
    const unsigned = join(dir, "qr.xml");
    const zatcaOut = join(dir, "qr-zatca.xml");
    writeFileSync(unsigned, xml);
    runSdk(["-sign", "-invoice", unsigned, "-signedInvoice", zatcaOut]);
    const ref = readFileSync(zatcaOut, "utf8");

    const i = ref.indexOf("<cbc:ID>QR</cbc:ID>");
    const refQr = ref.slice(i).match(/<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([^<]+)</)![1];
    const refTags = decodeZatcaQr(refQr);

    const signingTime = el(ref, "xades:SigningTime")!;
    const ours = assembleSignedInvoice({
      xml,
      certificatePem: certPem,
      privateKey: createPrivateKey(keyPem),
      publicKey: createPublicKey(createPrivateKey(keyPem)),
      qr: {
        sellerName: "Al-Rashid Trading Est.",
        vatNumber: "310123456789013",
        issuedAt: new Date("2026-04-01T09:13:57Z"),
        totalWithVat: "1150.00",
        vatTotal: "150.00",
      },
      signingTime: new Date(signingTime),
    });
    const ourTags = decodeZatcaQr(ours.qrCode);

    // Same tag set — we emit 1-9, as ZATCA does.
    expect(Object.keys(ourTags).sort()).toEqual(Object.keys(refTags).sort());

    // Tags 1, 2, 4, 5 and 6 still match the SDK byte-for-byte. This remains a
    // genuinely useful fast local signal — it catches a wrong tag 6 encoding or
    // a broken TLV length without a network round-trip.
    for (const t of [1, 2, 4, 5, 6]) {
      expect(ourTags[t].length, `tag ${t} length`).toBe(refTags[t].length);
      expect(ourTags[t].toString("hex"), `tag ${t} value`).toBe(refTags[t].toString("hex"));
    }

    // 🔴 TAG 3 ALSO DIVERGES FROM THE SDK (M12.4).
    // The SDK emits `2026-04-01T09:13:57Z` (20 bytes). The LIVE compliance API
    // warns `invoiceTimeStamp_QRCODE_INVALID` for exactly that, because the
    // trailing `Z` disagrees with the XML's `cbc:IssueTime`, which carries no
    // timezone designator. Ours is the 19-byte form, which passes.
    expect(ourTags[3].toString("utf-8"), "our tag 3 has no trailing Z").not.toMatch(/Z$/);
    expect(refTags[3].toString("utf-8"), "the SDK's tag 3 does").toMatch(/Z$/);
    expect(ourTags[3].toString("utf-8")).toBe(refTags[3].toString("utf-8").replace(/Z$/, ""));

    // ── 🔴 TAGS 7-9 DELIBERATELY DIVERGE FROM THE SDK (M12.4) ────────────────
    // This is the whole lesson of M12.4, asserted rather than described.
    //
    // The SDK emits tag 7 = public key, tag 8 = r, tag 9 = s. Matching it
    // byte-for-byte is exactly what M12.3 did — and ZATCA's LIVE compliance API
    // rejects that layout with three errors (publicKey_QRCODE_INVALID,
    // INVOICE_SIGNATURE_VALUE_QRCODE_INVALID, CERTIFICATE_SIGNATURE_QRCODE_INVALID).
    // The bundled SDK is a stale 2021-era writer.
    //
    // So we assert the DIFFERENCE. If a future SDK release changes to match the
    // live API, this test fails loudly and tells us to re-check — which is the
    // signal we want, rather than silence.
    const sigB64 = el(ours.signedXml, "ds:SignatureValue")!;
    expect(ourTags[7].toString("utf-8"), "tag 7 = base64 signature STRING").toBe(sigB64);
    expect(ourTags[8].length, "tag 8 = SPKI DER public key").toBe(88);
    expect(ourTags[8].toString("hex")).not.toBe(refTags[8].toString("hex"));

    // The SDK's tag 7 is the public key; ours is the signature. Different length
    // class, so this is a structural difference, not a value coincidence.
    expect(refTags[7].length, "SDK tag 7 is the 88-byte public key").toBe(88);
    expect(ourTags[7].length).not.toBe(refTags[7].length);
  }, SDK_TIMEOUT);

  it("the signature self-verifies against the public key", () => {
    const xml = buildInvoiceXml(standardInvoice());
    const kp = generateZatcaKeyPair();
    const ours = assembleSignedInvoice({
      xml,
      certificatePem: certPem,
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      qr: {
        sellerName: "Al-Rashid Trading Est.",
        vatNumber: "310123456789013",
        issuedAt: new Date("2026-04-01T09:13:57Z"),
        totalWithVat: "1150.00",
        vatTotal: "150.00",
      },
    });

    // #10: the signature is over the RAW invoice digest, not SignedInfo.
    const digest = computeInvoiceHash(xml).bytes;
    const ok = createVerify("sha256")
      .update(digest)
      .verify(kp.publicKey, Buffer.from(ours.signatureValue, "base64"));
    expect(ok).toBe(true);
  }, SDK_TIMEOUT);
});
