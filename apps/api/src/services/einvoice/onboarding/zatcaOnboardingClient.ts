/**
 * The ZATCA onboarding API client (M12.4).
 *
 * Shapes here were established from LIVE sandbox responses, not from the PDF —
 * the same discipline that produced thirteen documented divergences. Base URLs
 * differ only in their path segment; the host is the same for all environments.
 */
import { loadEnv } from "@workspace/config";
import type { ZatcaEnvironment } from "@workspace/db";

const HOST = "https://gw-fatoora.zatca.gov.sa/e-invoicing";

/**
 * Path segment per environment.
 *
 * 🔴 `developer-portal` (sandbox) requires NO account and accepts ANY OTP.
 * `simulation` and `core` (production) require a real taxpayer account with
 * ERAD credentials — the M12.7/M12.9 dependency that does not exist yet.
 */
const PATHS: Record<ZatcaEnvironment, string> = {
  sandbox: "developer-portal",
  simulation: "simulation",
  production: "core",
};

export function zatcaBaseUrl(environment: ZatcaEnvironment): string {
  return `${process.env.ZATCA_API_HOST ?? HOST}/${PATHS[environment]}`;
}

export interface ComplianceCsidResult {
  requestId: string;
  certificatePem: string;
  /** The Basic-auth password half. A SECRET — encrypted in the vault. */
  secret: string;
  binarySecurityToken: string;
}

export interface ZatcaApiError extends Error {
  httpStatus: number | null;
  body: unknown;
}

function apiError(message: string, httpStatus: number | null, body: unknown): ZatcaApiError {
  return Object.assign(new Error(message), { httpStatus, body }) as ZatcaApiError;
}

/** ZATCA returns base64(base64(DER)); unwrap one layer and PEM-wrap the rest. */
export function tokenToPem(binarySecurityToken: string): string {
  const inner = Buffer.from(binarySecurityToken, "base64").toString();
  return `-----BEGIN CERTIFICATE-----\n${inner.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;
}

export function basicAuth(binarySecurityToken: string, secret: string): string {
  return "Basic " + Buffer.from(`${binarySecurityToken}:${secret}`).toString("base64");
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "Accept-Version": "V2",
} as const;

export interface ZatcaOnboardingClient {
  requestComplianceCsid(env: ZatcaEnvironment, csrPem: string, otp: string): Promise<ComplianceCsidResult>;
  submitComplianceDocument(
    env: ZatcaEnvironment,
    credentials: { binarySecurityToken: string; secret: string },
    document: { invoiceHash: string; uuid: string; signedXmlBase64: string },
  ): Promise<ComplianceValidation>;
  requestProductionCsid(
    env: ZatcaEnvironment,
    credentials: { binarySecurityToken: string; secret: string },
    complianceRequestId: string,
  ): Promise<ComplianceCsidResult>;
}

export interface ComplianceValidation {
  status: string;
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

export const zatcaOnboardingClient: ZatcaOnboardingClient = {
  async requestComplianceCsid(env, csrPem, otp) {
    const res = await fetch(`${zatcaBaseUrl(env)}/compliance`, {
      method: "POST",
      headers: { ...JSON_HEADERS, OTP: otp },
      body: JSON.stringify({ csr: Buffer.from(csrPem, "utf8").toString("base64") }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, string> | null;
    if (res.status !== 200 || !body?.binarySecurityToken) {
      throw apiError("ZATCA did not issue a compliance CSID.", res.status, body);
    }
    return {
      requestId: String(body.requestID),
      certificatePem: tokenToPem(body.binarySecurityToken),
      secret: body.secret,
      binarySecurityToken: body.binarySecurityToken,
    };
  },

  async submitComplianceDocument(env, credentials, document) {
    const res = await fetch(`${zatcaBaseUrl(env)}/compliance/invoices`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        "Accept-Language": "en",
        Authorization: basicAuth(credentials.binarySecurityToken, credentials.secret),
      },
      body: JSON.stringify({
        invoiceHash: document.invoiceHash,
        uuid: document.uuid,
        invoice: document.signedXmlBase64,
      }),
    });
    const body = (await res.json().catch(() => null)) as
      | { validationResults?: { status?: string; errorMessages?: unknown; warningMessages?: unknown } }
      | null;
    const v = body?.validationResults ?? {};
    const list = (x: unknown): { code: string; message: string }[] =>
      Array.isArray(x) ? (x as { code: string; message: string }[]) : [];
    return {
      status: v.status ?? "UNKNOWN",
      errors: list(v.errorMessages),
      warnings: list(v.warningMessages),
    };
  },

  async requestProductionCsid(env, credentials, complianceRequestId) {
    const res = await fetch(`${zatcaBaseUrl(env)}/production/csids`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: basicAuth(credentials.binarySecurityToken, credentials.secret),
      },
      body: JSON.stringify({ compliance_request_id: complianceRequestId }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, string> | null;
    if (res.status !== 200 || !body?.binarySecurityToken) {
      throw apiError("ZATCA did not issue a production CSID.", res.status, body);
    }
    return {
      requestId: String(body.requestID),
      certificatePem: tokenToPem(body.binarySecurityToken),
      secret: body.secret,
      binarySecurityToken: body.binarySecurityToken,
    };
  },
};

/** The environment a tenant onboards against, from validated config. */
export function defaultOnboardingEnvironment(): ZatcaEnvironment {
  return (loadEnv().ZATCA_ENVIRONMENT ?? "sandbox") as ZatcaEnvironment;
}
