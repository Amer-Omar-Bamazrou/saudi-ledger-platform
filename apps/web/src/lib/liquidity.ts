/**
 * Owner-legible labels for an account's liquidity class (Finance Hub Q4).
 * "Quick asset" is jargon; "cash within 12 months" is the same fact in words
 * the reader already has. The stored VALUES stay the accounting terms — it is
 * the label that translates. ONE definition: the chart of accounts and the
 * Zakat classification read the same words.
 */
export const LIQUIDITY_OPTIONS = [
  { value: "cash",        en: "Cash or bank",                     ar: "نقد أو بنك" },
  { value: "quick",       en: "Expected as cash within 12 months", ar: "يُتوقع تحصيله نقداً خلال 12 شهراً" },
  { value: "current",     en: "Used or owed within 12 months",     ar: "يُستخدم أو يُستحق خلال 12 شهراً" },
  { value: "non_current", en: "Longer than 12 months",             ar: "أطول من 12 شهراً" },
] as const;

export const liquidityLabel = (value: string | null | undefined, t: (en: string, ar: string) => string): string | null => {
  const o = LIQUIDITY_OPTIONS.find((x) => x.value === value);
  return o ? t(o.en, o.ar) : null;
};
