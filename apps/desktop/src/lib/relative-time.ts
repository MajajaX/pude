import { locale } from "./i18n";

const formatters = new Map<string, Intl.RelativeTimeFormat>();
const formatter = () => {
  const language = locale();
  let current = formatters.get(language);
  if (!current) {
    current = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    formatters.set(language, current);
  }
  return current;
};

/** Short "3 days ago" style label; returns the input unchanged when it is not a date. */
export function relativeTimeLabel(timestamp: string, now = Date.now()): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return timestamp;
  // Round in each unit before comparing, so 59.7 minutes reads "1 hour ago", not "60 minutes ago".
  const elapsed = time - now;
  const minutes = Math.round(elapsed / 60_000);
  if (Math.abs(minutes) < 60) return formatter().format(minutes, "minute");
  const hours = Math.round(elapsed / 3_600_000);
  if (Math.abs(hours) < 24) return formatter().format(hours, "hour");
  const days = Math.round(elapsed / 86_400_000);
  if (Math.abs(days) < 45) return formatter().format(days, "day");
  const months = Math.round(elapsed / (86_400_000 * 30.44));
  if (Math.abs(months) < 18) return formatter().format(months, "month");
  return formatter().format(Math.round(elapsed / (86_400_000 * 365.25)), "year");
}
