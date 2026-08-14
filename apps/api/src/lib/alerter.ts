/**
 * Alerter seam (queue item B2) — VISIBILITY IS NOT ALERTING.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * M12.8 surfaced both platform alarms in the operator panel and the queue
 * recorded that as delivered. It was not: **a panel only helps someone who is
 * already looking at it, and nobody looks at a panel that is usually green.**
 * Both failures this watches are *quiet neglect*, not loud rejection — which
 * is exactly the shape a dashboard is the wrong instrument for:
 *
 *   - a simplified invoice silently missing ZATCA's **24-hour reporting
 *     deadline** looks like nothing is wrong, and costs the tenant fines from
 *     SAR 5,000;
 *   - a **PCSID expiring** looks like nothing is wrong until signing stops
 *     dead and the tenant cannot legally invoice.
 *
 * ── Deliberately a generic webhook ────────────────────────────────────────
 * PagerDuty (Events API v2), Opsgenie and Slack all accept an inbound JSON
 * POST, so one dependency-free implementation reaches all three and the choice
 * stays a deployment decision — the `KeyWrapper` / `ArchiveStore` / `Mailer`
 * pattern. Vendor-specific payload shaping belongs in whatever receives this,
 * not in the platform.
 *
 * ── This is the OPERATOR's channel, not the tenant's ───────────────────────
 * B1's mailer tells a TENANT to renew their certificate (only they can).
 * This tells US the platform is failing to do its job. Distinct audiences,
 * distinct channels, deliberately not merged.
 */
import { loadEnv } from "@workspace/config";
import { logger } from "./logger";

export type AlertSeverity = "warning" | "critical";

export interface Alert {
  /** Stable identity of the CONDITION, not the occurrence — used to dedupe. */
  key: string;
  severity: AlertSeverity;
  title: string;
  /** One line a human can act on at 3am. */
  detail: string;
  /** Metadata only. 🔴 Never a tenant's financial data, XML, or key material. */
  context?: Record<string, unknown>;
}

export interface Alerter {
  fire(alert: Alert): Promise<{ sent: boolean }>;
  resolve(key: string, title: string): Promise<{ sent: boolean }>;
}

/** Dev/CI default: records the intent, pages no one. Refused in production. */
export const noopAlerter: Alerter = {
  async fire(alert) {
    logger.warn({ alert: alert.key, severity: alert.severity }, `ALERT (not sent — no provider): ${alert.title}`);
    return { sent: false };
  },
  async resolve(key) {
    logger.info({ alert: key }, "alert resolved (not sent — no provider)");
    return { sent: false };
  },
};

async function post(url: string, body: unknown, key: string): Promise<{ sent: boolean }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error({ alert: key, status: res.status }, "alerter: webhook rejected the alert");
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    // 🔴 An alerting failure must never break the job that detected the
    // problem — otherwise a webhook outage hides the outage it was watching.
    logger.error({ err, alert: key }, "alerter: webhook delivery failed");
    return { sent: false };
  }
}

export function webhookAlerter(url: string): Alerter {
  return {
    fire: (a) =>
      post(url, { event: "alert", key: a.key, severity: a.severity, title: a.title, detail: a.detail, context: a.context ?? {} }, a.key),
    resolve: (key, title) => post(url, { event: "resolve", key, severity: "info", title, detail: "Condition cleared." }, key),
  };
}

function build(): Alerter {
  const env = loadEnv();
  return env.ALERT_PROVIDER === "webhook" ? webhookAlerter(env.ALERT_WEBHOOK_URL!) : noopAlerter;
}

let instance: Alerter | null = null;

export const alerter: Alerter = {
  fire(alert) {
    if (!instance) instance = build();
    return instance.fire(alert);
  },
  resolve(key, title) {
    if (!instance) instance = build();
    return instance.resolve(key, title);
  },
};

/** Test hook: force a specific implementation (or reset with `null`). */
export function __setAlerterForTests(a: Alerter | null): void {
  instance = a;
}
