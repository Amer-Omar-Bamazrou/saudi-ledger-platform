/**
 * Mailer seam (M11.7) — PROVIDER-AGNOSTIC BY DESIGN.
 *
 * The platform sends no email yet: no provider is integrated, no domain is
 * verified, and no secrets exist for one. Rather than block invitations on that
 * decision, invitations are **link-based** — the API returns the invite URL and
 * the admin shares it out of band. This interface is the seam a real provider
 * (SES / Resend / Postmark) drops into later WITHOUT touching the invitation
 * service: implement `send`, swap the export, and the flow starts emailing.
 *
 * The no-op implementation logs at debug level and reports `delivered: false`, so
 * callers (and the UI) can honestly say "copy this link" instead of implying an
 * email went out.
 */
import { logger } from "./logger";

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. A real provider would also take an HTML part. */
  text: string;
}

export interface MailResult {
  /** False when no provider is configured — the caller must surface the link. */
  delivered: boolean;
}

export interface Mailer {
  send(message: MailMessage): Promise<MailResult>;
}

/** The default: records the intent, delivers nothing. */
export const noopMailer: Mailer = {
  async send(message: MailMessage): Promise<MailResult> {
    logger.debug({ to: message.to, subject: message.subject }, "mailer: no provider configured, not sending");
    return { delivered: false };
  },
};

/** The mailer the application uses. Swap here when a provider is integrated. */
export const mailer: Mailer = noopMailer;
