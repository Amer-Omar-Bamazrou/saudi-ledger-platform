/**
 * Mailer seam (M11.7 design, B1 implementation) — PROVIDER-AGNOSTIC BY DESIGN.
 *
 * ── Why this exists at all (queue item B1) ─────────────────────────────────
 * Two alarms in this platform are worth nothing without email:
 *
 *   - the **PCSID renewal reminder**, whose entire value is lead time for an
 *     action ONLY THE TENANT can take (a fresh CSR plus an OTP from *their*
 *     Fatoora portal). At expiry, signing stops dead and they cannot legally
 *     invoice. A reminder that reaches nobody is not a reminder;
 *   - **invitations**, which otherwise require an admin to copy a link out of
 *     band.
 *
 * Both already call this seam and already record whether delivery happened, so
 * B1 is genuinely "implement `send`" — with one thing the queue entry did NOT
 * say, found while building it: the renewal reminder had **no recipient**. It
 * addressed `zatca-admin+<companyId>@invalid.local`, a placeholder that can
 * never receive mail. Delivering to it would have been a working mailer that
 * still reached nobody — the same failure one layer down. Recipient resolution
 * now lives with the caller (see `renewal.service`), which asks the identity
 * layer for the organization's active admins.
 *
 * ── Provider choice is a DEPLOYMENT decision, not a code one ───────────────
 * Same pattern as `KeyWrapper` (M12.5) and `ArchiveStore` (M12.8): the
 * implementations live here, the choice is config. Both providers are thin,
 * **dependency-free REST clients** — the M11.4 `lib/storage.ts` precedent —
 * because an SDK for a single POST is a supply-chain cost with no benefit.
 * AWS SES is deliberately NOT implemented: it needs SigV4 signing (or the SDK),
 * which is a deployment-time addition exactly like `@aws-sdk/client-kms`.
 *
 * ── Fail-closed in production ──────────────────────────────────────────────
 * `loadEnv` refuses to boot a production process with no mail provider
 * (`env.ts`), for the same reason it refuses the `local-dev` key wrapper:
 * shipping a silently-inert alarm is the failure that stays invisible until
 * the thing it was guarding has already happened.
 */
import { loadEnv } from "@workspace/config";
import { logger } from "./logger";

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Providers accept an HTML part too; we do not need one yet. */
  text: string;
}

export interface MailResult {
  /** False when no provider is configured — the caller must surface the link. */
  delivered: boolean;
}

export interface Mailer {
  send(message: MailMessage): Promise<MailResult>;
}

/** The default: records the intent, delivers nothing. Dev and CI only. */
export const noopMailer: Mailer = {
  async send(message: MailMessage): Promise<MailResult> {
    logger.debug({ to: message.to, subject: message.subject }, "mailer: no provider configured, not sending");
    return { delivered: false };
  },
};

/**
 * A failed send must never throw into a caller that has already committed
 * state (the renewal reminder's row, an invitation's row). It is logged and
 * reported as undelivered, so the caller records the truth and the UI can
 * still offer the link.
 */
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  provider: string,
  to: string,
): Promise<MailResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Never log the body of a provider error unfiltered — it echoes the
      // message, and the message can carry tenant data.
      logger.error({ provider, status: res.status, to }, "mailer: provider rejected the message");
      return { delivered: false };
    }
    return { delivered: true };
  } catch (err) {
    logger.error({ err, provider, to }, "mailer: send failed");
    return { delivered: false };
  }
}

/** Resend — https://resend.com/docs/api-reference/emails/send-email */
export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    send: (m) =>
      post(
        "https://api.resend.com/emails",
        { Authorization: `Bearer ${apiKey}` },
        { from, to: [m.to], subject: m.subject, text: m.text },
        "resend",
        m.to,
      ),
  };
}

/** Postmark — https://postmarkapp.com/developer/api/email-api */
export function postmarkMailer(serverToken: string, from: string): Mailer {
  return {
    send: (m) =>
      post(
        "https://api.postmarkapp.com/email",
        { "X-Postmark-Server-Token": serverToken, Accept: "application/json" },
        { From: from, To: m.to, Subject: m.subject, TextBody: m.text, MessageStream: "outbound" },
        "postmark",
        m.to,
      ),
  };
}

function build(): Mailer {
  const env = loadEnv();
  switch (env.MAIL_PROVIDER) {
    case "resend":
      return resendMailer(env.MAIL_API_KEY!, env.MAIL_FROM!);
    case "postmark":
      return postmarkMailer(env.MAIL_API_KEY!, env.MAIL_FROM!);
    default:
      return noopMailer;
  }
}

let instance: Mailer | null = null;

/** The mailer the application uses. Built once, on first send. */
export const mailer: Mailer = {
  send(message: MailMessage): Promise<MailResult> {
    if (!instance) instance = build();
    return instance.send(message);
  },
};

/** Test hook: force a specific implementation (or reset with `null`). */
export function __setMailerForTests(m: Mailer | null): void {
  instance = m;
}
