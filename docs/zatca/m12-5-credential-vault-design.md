# M12.5 — ZATCA Credential Vault: Design

**Status:** approved, implemented in M12.5.
**Scope:** storage, encryption, access and lifecycle of per-company ZATCA signing
keys and CSID credentials.

> This is the most security-sensitive component in the platform. **A leaked
> private key lets an attacker issue legally-valid tax invoices in a tenant's
> name**, creating real tax liability for a real business, with a chain and QR
> that ZATCA will accept as genuine. The reasoning below is recorded so it
> outlives the session that produced it.

---

## 1. What is being protected

Per company (per EGS unit — **not** per organization; ZATCA identity is per EGS):

| Artifact | Secret? | Why |
| --- | --- | --- |
| ECDSA `secp256k1` private key | 🔴 **yes** | Signs invoices. Leak ⇒ forged legal invoices. |
| CSID `secret` | 🔴 **yes** | The password half of the transport's Basic auth. |
| CCSID / PCSID certificate | no | Public by construction; embedded in every signed invoice. |
| CSR | no | Public. |
| `not_after` / status / EGS serial | no | Operational metadata. |

**The CSID `secret` is easy to get wrong.** ZATCA returns it in the same JSON body
as the certificate, so it reads like a companion field. It is not: it authenticates
us to ZATCA as that taxpayer and is encrypted exactly like the private key.

---

## 2. Table design — `zatca_credentials`

Owner-only: **no RLS, no app-role grants.** This is the sixth table on that
pattern (`security_audit_logs`, `platform_operators`, `verification_reviews`,
`verification_documents`, `organization_invitations`).

### Why owner-only rather than RLS — the reasoning differs from the earlier five

For the previous tables, owner-only was about keeping identity data out of tenant
scope. Here it is about **blast radius under app-role compromise**.

RLS answers *"can org A read org B's row"*. It does **not** answer *"can a
SQL-injection flaw in any business route read the current tenant's signing key"* —
and under RLS it could, because the app role would be acting as that tenant. Every
one of the ~18 business domains runs as the app role. With **no grants at all**,
the app role cannot `SELECT` this table under any tenant context, so no business
route is on the attack path. The vault is reachable only from the identity/signing
layer on the base connection.

The open **`TRUNCATE` finding** reinforces this: the app role holds `TRUNCATE` on
every business table and **`TRUNCATE` bypasses RLS**. A business-table vault would
inherit that exposure.

### Schema

```
zatca_credentials
  id                     uuid pk
  company_id             uuid not null → companies(id)
  environment            text not null   -- sandbox | simulation | production
  status                 text not null   -- pending_csr | active | superseded | revoked

  -- envelope encryption
  kms_provider           text  not null  -- 'aws-kms' | 'local-dev'
  kms_key_id             text  not null
  wrapped_data_key       bytea not null  -- the DEK, wrapped by the KMS master key
  encrypted_private_key  bytea not null  -- PKCS#8 DER, AES-256-GCM under the DEK
  private_key_iv         bytea not null
  private_key_auth_tag   bytea not null
  encrypted_csid_secret  bytea           -- same envelope, same DEK
  csid_secret_iv         bytea
  csid_secret_auth_tag   bytea

  -- non-secret companions
  csr_pem                text
  certificate_pem        text
  egs_serial_number      text
  not_before, not_after  timestamptz     -- the 5-year PCSID expiry
  created_at, activated_at, rotated_at, revoked_at, revoked_reason
```

**`unique (company_id, environment) WHERE status = 'active'`** — a partial unique
index, hand-written because Drizzle cannot express one (same as M11.7's pending
invitation index). The **database**, not application logic, guarantees at most one
active credential per EGS unit per environment. Two concurrent onboardings cannot
both win.

**`kms_provider` is stored on the row** so a locally-wrapped dev credential is
identifiable and can never be silently mistaken for a production one.

---

## 3. Envelope encryption

**One platform CMK + a per-company data key (DEK).**

```
private key (PKCS#8 DER) ──AES-256-GCM──> encrypted_private_key
                    key: DEK (32 random bytes, per company)
DEK ──KMS Encrypt──> wrapped_data_key      (stored; the plaintext DEK is never stored)
```

### 🔴 Why NOT a CMK per tenant

An earlier note read *"~$1/key/month on AWS KMS"*. Applied per tenant that is
**$1,000/month at 1,000 tenants — for identical isolation**. A per-company DEK
already gives the property that matters: compromising one DEK exposes exactly one
company. The CMK only ever wraps DEKs, never invoice data.

| Item | Cost |
| --- | --- |
| 1 platform CMK | ~$1 / month |
| KMS requests | $0.03 / 10,000 |
| 10,000 invoices/month | ~$0.03 |

DEK caching would cut requests further but keeps plaintext DEKs resident in
memory. **Not done** — the cost is not the constraint, and memory residency is.

### The `KeyWrapper` seam

```ts
interface KeyWrapper {
  readonly provider: "aws-kms" | "local-dev";
  readonly keyId: string;
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}
```

**The provider is chosen at deployment, not compiled in** — the same hedge as
M12.8's storage backend. The KSA data-residency question is still open, and the
CMK must live in a region consistent with wherever invoice data lands; committing
to a KMS now would partially pre-decide the hosting provider. AWS KMS is the
first implementation, not a permanent choice.

### Local development — and why it cannot reach production

No KMS exists locally. `LocalDevWrapper` derives a master key from
`ZATCA_DEV_MASTER_KEY`. The safety property is that it must be **impossible** to
use in production, enforced twice independently:

1. **Config, at boot** — `ZATCA_KMS_PROVIDER=local-dev` with `NODE_ENV=production`
   fails validation; the process does not start.
2. **Signing, at use** — the signing service refuses any row whose stored
   `kms_provider` is `local-dev` when running in production, even if such a row
   somehow exists.

Two checks because this is the failure that silently ships fake cryptography.

---

## 4. The narrow signing service

`services/einvoice/signing/` is the **only** code that unwraps a key.

### Scoped access — plaintext never returns to a caller

The API deliberately offers no `getPrivateKey()`. Instead:

```ts
withSigningKey(companyId, environment, (key: KeyObject) => T): Promise<T>
withTransportCredentials(companyId, environment, (c: {certificateBase64, secret}) => T): Promise<T>
```

Plaintext exists only inside the callback and is wiped on exit. `withTransportCredentials`
exists because Basic auth genuinely needs the secret — it hands it to the HTTP
client, never to a controller.

### Seven enforcement layers

No single mistake should be sufficient to leak a key.

1. **Type level** — no exported type carries a private-key field. `withSigningKey`
   returns only what the callback returns.
2. **Import guard** — the vault repository is not in the repositories barrel, and
   a test fails the build if `zatcaCredentials` is imported outside
   `services/einvoice/signing/`. Same shape as the M-1 landmine guard.
3. **Serialisation** — the credential object's `toJSON()` **throws**.
   `JSON.stringify` on it is a bug and should be loud, not silently redacted.
4. **Logging** — no key-bearing object is passed to a logger; `pino` redaction as
   defence in depth. (M12.3's review confirmed `services/einvoice/` logs nothing.)
5. **Errors** — 🔴 the subtle one. `errorHandler` emits `err.message`, and a crypto
   library's message can embed key material. The signing path catches everything
   and re-throws a typed `SigningError` with a **fixed** message; the original is
   logged internally, never propagated to HTTP.
6. **Memory** — plaintext lives in `Buffer`, zeroed with `.fill(0)` in a `finally`.
   DER → `KeyObject` directly; **never a PEM string** (see §5).
7. **No HTTP surface** — there is deliberately no route that returns key material.
   Onboarding accepts an OTP and returns status only.

### Connection boundary

The vault is owner-only, so the signing service uses the **base/owner connection
explicitly** — never the `db` proxy. Inside a request the proxy resolves to the
tenant connection, which has no grants here and would fail; relying on that
failure would be luck, not design. This mirrors `securityAuditService`. The M12.6
worker runs outside any request and is unaffected.

---

## 5. The two M12.3 prerequisites — land BEFORE the vault stores anything

Neither is exploitable today (nothing persists or transmits keys). **M12.5 is when
the blast radius changes**, so both are fixed first.

### (a) `keys.ts` — eager `privateKeyPem` export

`generateZatcaKeyPair()` eagerly exported the PKCS#8 **PEM as a JS string** on
every call. Strings are immutable and unzeroable: the key stays in the heap until
GC, and may be copied by the runtime.

**Fix: remove `privateKeyPem` from the returned type entirely.** A lazy getter was
considered and rejected — it still yields an unzeroable string the moment it is
touched. The vault exports the `KeyObject` straight to a DER `Buffer`, encrypts
it, and `fill(0)`s the buffer. Verified: nothing outside `keys.ts` consumed the
field.

### (b) `assertZatcaCurve` — DER round-trip on the private key

It exported the **private** key to DER purely to read the curve OID, creating a
second unzeroable copy on every validation.

The DER check is not dead weight — the docstring is right that
`asymmetricKeyDetails.namedCurve` can be aliased, and this curve is divergence #1.
**Fix: run the DER check on the derived public key** (`publicKeyFromPrivate`,
already present). Identical OID assurance, zero private-key copies.

---

## 6. Key lifecycle

```
  generate ──> pending_csr ──(CCSID → compliance checks → PCSID)──> active
                                                                     │
                                          rotate ──> (new row) active│
                                                     old row ──> superseded
                                                                     │
                                          revoke ──────────────> revoked
```

- **Generation** — at onboarding, in-process. The key never leaves the server and
  is wrapped before it is ever written.
- **Activation** — CCSID → six compliance documents → PCSID → `active`.
- **Rotation** — a new key and CSR are created while the old stays `active`; on
  PCSID issue, one transaction flips old → `superseded`, new → `active`. The
  partial unique index enforces exactly one active.
- **Superseded rows are never deleted.** Invoices were signed under them and the
  archive must stay verifiable for ZATCA's 6–11 year retention. The *certificate*
  is retained; the *private key* may be crypto-shredded (drop the wrapped DEK)
  once it will never sign again.
- **Revocation** — status `revoked`, crypto-shred the key material, retain
  metadata and certificate for audit.

### 🔴 The 5-year PCSID expiry — no grace period

Confirmed empirically 2026-08-09: the issued certificate is valid
**2026-08-09 → 2031-08-08**.

At expiry signing **stops dead** — the tenant cannot clear or report invoices, and
therefore cannot legally invoice. This is the **same failure shape as the outbox
alerting gap**: quiet neglect, where nothing looks wrong until it is a compliance
breach.

It is worse in one respect: **renewal requires the tenant's own action** (fresh
CSR plus an OTP they obtain from Fatoora), so a late reminder cannot be fixed by
us alone. **Reminders at T-90 / T-30 / T-7, plus operator visibility (M12.8),
driven off `not_after`.** Recorded in CLAUDE.md as a pre-production requirement.

---

## 7. If the KMS master key is lost or rotated

| Event | Impact | Action |
| --- | --- | --- |
| **Automatic annual rotation** | **Safe.** KMS retains prior key versions and the ciphertext blob names its version, so wrapped DEKs stay decryptable. | None. Holds only while the CMK is never deleted. |
| **Migrate to a different CMK** | Recoverable. | Re-wrap job: unwrap with old, re-wrap with new, update `wrapped_data_key` + `kms_key_id`. Idempotent, resumable, per row. The invoice keys themselves are untouched. |
| **CMK deleted / lost** | 🔴 **Unrecoverable.** Every wrapped DEK is undecryptable ⇒ every tenant's private key is permanently lost. | Re-onboard every tenant (new key, CSR, OTP). |

**Bounding the disaster:** already-issued invoices and their archived signed XML
**survive** — they are signed and stored. What is lost is the ability to sign
*new* ones. Recovery requires action from each tenant, so it is a business event,
not merely an outage.

**Deployment requirements** (configuration, not code — recorded in CLAUDE.md):

- 30-day KMS deletion waiting period (the maximum).
- `kms:ScheduleKeyDeletion` restricted to a break-glass role via key policy.
- CloudTrail alarm on any deletion attempt — it must page a human.
- Multi-region CMK replica.

---

## 8. Testing without a real KMS

The `KeyWrapper` seam makes the whole vault testable with an AES-GCM wrapper under
a fixed test key — deterministic, offline, free in CI.

**The valuable tests are the negative ones:**

| Test | Asserts |
| --- | --- |
| DB boundary | the app role cannot `SELECT zatca_credentials` (mirrors `operator-tables.test.ts`) |
| No HTTP leak | no response body from any route contains key material |
| Serialisation | `JSON.stringify(credentials)` **throws** |
| Logging | across a full onboard + sign flow, captured `pino` output never contains the key |
| Errors | forced failure at each step ⇒ no error message carries key bytes |
| Rotation | exactly one `active` row; superseded retained |
| Provider guard | config refuses `local-dev` under `NODE_ENV=production` |
| Round-trip | generate → store → retrieve → sign → verify against the stored public key |

**🚩 What this does NOT prove: that the AWS IAM/key policy is correct.** That is
deployment verification. This is the same shape as the known M11.4 gap where the
storage tests skip in CI — recorded up front rather than discovered later.

---

## 9. New dependencies, services and costs

| Item | Type | Cost |
| --- | --- | --- |
| `@aws-sdk/client-kms` | npm dependency (lazy-loaded; only when the AWS provider is selected) | — |
| AWS account + 1 CMK | **new external service** | ~$1/mo + $0.03/10k requests |
| IAM role / KMS credentials | **new secret to manage** | — |
| Local dev wrapper | dev/test only | free |

No new runtime service to operate (unlike self-hosted Vault). CI needs no KMS.

**Open decision deliberately deferred:** which KMS/region, pending the KSA
residency decision. The `KeyWrapper` interface is what makes deferring it safe.
