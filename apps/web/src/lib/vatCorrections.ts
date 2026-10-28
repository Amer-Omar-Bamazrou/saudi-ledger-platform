/**
 * 🔴 Phase 18 G2a (owner decision 11): a correction route in the reader's
 * language — keyed on the server's route CODE, never on its English note.
 */
import type { VatCorrectionReturn } from "@workspace/api-client-react";

type T = (en: string, ar: string) => string;

/** The route in the reader's language — keyed on the server's code, never its English note. */
export function correctionRouteText(r: VatCorrectionReturn, t: T): string {
  switch (r.route) {
    case "amend_and_notify": return t(
      `The net tax difference reaches SAR 15,000: amend the original return and notify ZATCA by ${r.notifyBy} (VAT IR Art. 63(1)).`,
      `صافي فرق الضريبة يبلغ 15,000 ريال: عدّل الإقرار الأصلي وأبلغ الهيئة في موعد أقصاه ${r.notifyBy} (المادة 63(1) من اللائحة).`,
    );
    case "discovery_period_return": return t(
      `Below SAR 15,000: include the correction in the return for the period of discovery, ${r.discoveryPeriod} (VAT IR Art. 63(3)).`,
      `أقل من 15,000 ريال: أدرج التصحيح في إقرار فترة الاكتشاف، ${r.discoveryPeriod} (المادة 63(3) من اللائحة).`,
    );
    case "user_choice": return t(
      `Below SAR 15,000, but the return for the period of discovery (${r.discoveryPeriod}) is already filed. Choose how to correct it, and obtain ZATCA's direction first. Nothing is done automatically.`,
      `أقل من 15,000 ريال، لكن إقرار فترة الاكتشاف (${r.discoveryPeriod}) قُدِّم بالفعل. اختر طريقة التصحيح، واحصل أولًا على توجيه الهيئة. لا يُنفَّذ شيء تلقائيًا.`,
    );
    default: return "";
  }
}
