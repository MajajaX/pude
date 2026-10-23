import { locale } from "./i18n";

const formatters = new Map<string, Intl.RelativeTimeFormat>();
const formatter = () => {
  const language = locale();
  let current = formatters.get(language);
  if (!current) formatters.set(language, current = new Intl.RelativeTimeFormat(language, { numeric: "auto" }));
  return current;
};

/** Short "3 days ago" style label; returns the input unchanged when it is not a date. */
export function relativeTimeLabel(timestamp: string, now = Date.now()): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return timestamp;
  const elapsedDays = (time - now) / 86_400_000;
  const elapsedHours = elapsedDays * 24;
  const elapsedMinutes = elapsedHours * 60;
  if (Math.abs(elapsedMinutes) < 60) return formatter().format(Math.round(elapsedMinutes), "minute");
  if (Math.abs(elapsedHours) < 24) return formatter().format(Math.round(elapsedHours), "hour");
  if (Math.abs(elapsedDays) < 45) return formatter().format(Math.round(elapsedDays), "day");
  const elapsedMonths = elapsedDays / 30.44;
  if (Math.abs(elapsedMonths) < 18) return formatter().format(Math.round(elapsedMonths), "month");
  return formatter().format(Math.round(elapsedDays / 365.25), "year");
}
