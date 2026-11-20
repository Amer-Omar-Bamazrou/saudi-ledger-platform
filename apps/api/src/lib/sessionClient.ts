/**
 * 🔴 Phase 19A (19.4; PDPL minimisation, proposal §5.2): what a session record keeps of the client — a COARSE
 * description a person recognises ("Chrome · Windows"), never the full user-agent string, which identifies a device far
 * more precisely than anyone needs to tell their own sessions apart.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/\bWindows\b/, "Windows"],
  [/\b(iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

export function describeClient(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? "Other browser";
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1] ?? "Other system";
  return `${browser} · ${system}`;
}
