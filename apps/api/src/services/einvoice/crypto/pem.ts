/**
 * 🔴 PEM ARMOUR, ONCE (2026-11-21): base64 in lines of at most 64 characters between BEGIN and END, and never a blank
 * line. Wrapping with `replace(/(.{64})/g, "$1\n")` and then adding a newline before END leaves a blank line whenever
 * the base64 length is an exact multiple of 64, and OpenSSL refuses that PEM ("wrong tag") — a 704-character ZATCA
 * sandbox certificate did exactly that. Every PEM this service builds (the CSR, the certificate ZATCA returns) goes
 * through here; tests/zatca-pem-wrap.test.ts holds the multiple-of-64 case.
 */
export function pemArmour(label: string, base64: string): string {
  const body = base64.replace(/\s/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
