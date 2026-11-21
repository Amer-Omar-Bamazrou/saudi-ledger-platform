/**
 * 🔴 A CERTIFICATE WHOSE BASE64 LENGTH IS A MULTIPLE OF 64 BECOMES A PEM NODE CAN READ (2026-11-21).
 *
 * ZATCA returns a certificate as base64(base64(DER)); `tokenToPem` (onboarding) unwraps one layer and wraps the rest in
 * 64-character lines. It wrapped with `replace(/(.{64})/g, "$1\n")` and then added its own newline before END, so
 * when the base64 length was an exact multiple of 64 the PEM ended in a BLANK LINE — and OpenSSL refuses it
 * ("asn1 encoding routines::wrong tag"). Found 2026-11-21 when the ZATCA sandbox issued a 704-character certificate:
 * a live test could not sign. In production the same function feeds signing, so an onboarded company holding such a
 * certificate could not issue (issuance fails closed). The four live tests carried copies of the same wrapping; they
 * now call this function, so there is one definition.
 *
 * Fixtures: two throwaway self-signed secp256k1 certificates made for this test (no key is kept or committed) — one
 * whose base64 is exactly 704 characters (11 × 64), one of 644 (not a multiple, the comparison).
 */
import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { tokenToPem } from "../services/einvoice/onboarding/zatcaOnboardingClient";

const MULTIPLE_OF_64 = "MIICCzCCAbCgAwIBAgIUASlasCib4kKA+rtEqj399IsJ2ygwCgYIKoZIzj0EAwIwWzEwMC4GA1UEAwwnUEVNLUZJWFRVUkUtMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMRowGAYDVQQKDBFTYXVkaSBMZWRnZXIgVGVzdDELMAkGA1UEBhMCU0EwIBcNMjYxMTIxMTkxOTEyWhgPMjEyNjEwMjgxOTE5MTJaMFsxMDAuBgNVBAMMJ1BFTS1GSVhUVVJFLTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDEaMBgGA1UECgwRU2F1ZGkgTGVkZ2VyIFRlc3QxCzAJBgNVBAYTAlNBMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAED2Vd2UhBF7Fy/ZonaRjpATsXmVgVMBCP7XvLoFCMIA1RXsrRmeaBHb/Tr5HzWKWJb3NcGZ4ttQayPZbuUYiT2KNTMFEwHQYDVR0OBBYEFB6/G8Clnvl2ySFiJBIzaLmCPEK6MB8GA1UdIwQYMBaAFB6/G8Clnvl2ySFiJBIzaLmCPEK6MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAM3b8clTAWwASiwlcSFduJMneKgKy+N3Gp+dP5TcHyhyAiEAmS/Vntwnnj+GizyIMex7tzLafy/R+HVrS0BmxthLZYA=";
const NOT_A_MULTIPLE = "MIIB3zCCAYSgAwIBAgIUZD+dqF/yaPhZT4AwlARrgJTKSQ4wCgYIKoZIzj0EAwIwRTEaMBgGA1UEAwwRUEVNLUZJWFRVUkUtT1RIRVIxGjAYBgNVBAoMEVNhdWRpIExlZGdlciBUZXN0MQswCQYDVQQGEwJTQTAgFw0yNjExMjExOTE5MjdaGA8yMTI2MTAyODE5MTkyN1owRTEaMBgGA1UEAwwRUEVNLUZJWFRVUkUtT1RIRVIxGjAYBgNVBAoMEVNhdWRpIExlZGdlciBUZXN0MQswCQYDVQQGEwJTQTBWMBAGByqGSM49AgEGBSuBBAAKA0IABA9lXdlIQRexcv2aJ2kY6QE7F5lYFTAQj+17y6BQjCANUV7K0ZnmgR2/06+R81iliW9zXBmeLbUGsj2W7lGIk9ijUzBRMB0GA1UdDgQWBBQevxvApZ75dskhYiQSM2i5gjxCujAfBgNVHSMEGDAWgBQevxvApZ75dskhYiQSM2i5gjxCujAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQD1AEzoknSkbY2vs9JY4IsO6NWCFdQLBQqoOaQ3cswMtgIhALorTHrr3S2tZE+JhbV4EljCEmws3EojmqcOoXksCvF/";
/** What ZATCA sends: base64 of the base64 of the DER. */
const asToken = (b64: string) => Buffer.from(b64, "utf8").toString("base64");

describe("tokenToPem: a PEM Node can read, whatever the certificate's length", () => {
  it("anti-vacuity: the fixtures have the lengths this test is about", () => {
    expect(MULTIPLE_OF_64.length % 64).toBe(0);
    expect(MULTIPLE_OF_64.length).toBe(704);
    expect(NOT_A_MULTIPLE.length % 64).not.toBe(0);
  });

  for (const [label, b64] of [["704 characters (11 × 64)", MULTIPLE_OF_64], ["644 characters", NOT_A_MULTIPLE]] as const) {
    it(`🔴 ${label}: Node parses it, every body line is 1–64 characters, and there is no blank line`, () => {
      const pem = tokenToPem(asToken(b64));
      const cert = new X509Certificate(pem);
      expect(cert.subject).toContain("O=Saudi Ledger Test");
      const lines = pem.split("\n");
      expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
      const end = lines.indexOf("-----END CERTIFICATE-----");
      expect(end, "an END line").toBeGreaterThan(0);
      const body = lines.slice(1, end);
      expect(body.every((l) => l.length >= 1 && l.length <= 64), `body lines: ${body.map((l) => l.length).join(",")}`).toBe(true);
      expect(body.join(""), "the body is the certificate, unchanged").toBe(b64);
      expect(pem.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
    });
  }
});
