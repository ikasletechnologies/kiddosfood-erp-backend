// Business-calendar date ranges. A "day" is a calendar day in the business
// timezone (IST by default, BUSINESS_TZ_OFFSET_MINUTES to override — the same
// setting POS Day Closing uses), never the server's or the browser's local
// day, so "Today" means the same thing on a UTC cloud host as on an IST one.

const offsetMs = () => Number(process.env.BUSINESS_TZ_OFFSET_MINUTES ?? 330) * 60_000;

/** Business-calendar Y/M/D of an instant, as a UTC-midnight Date. */
function businessDay(now: Date): Date {
  const local = new Date(now.getTime() + offsetMs());
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const isYmd = (s?: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export type DatePreset = 'ALL' | 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'CUSTOM';

/**
 * Inclusive business-calendar day range ("YYYY-MM-DD") for a preset.
 * THIS_WEEK runs Monday–Sunday. CUSTOM takes from/to as given (either may be
 * blank = open-ended; a reversed range is swapped). ALL / unknown → no bounds.
 */
export function resolveDatePreset(preset?: string | null, from?: string | null, to?: string | null, now: Date = new Date()): { from?: string; to?: string } {
  const today = businessDay(now);
  switch ((preset || '').toUpperCase()) {
    case 'TODAY': return { from: ymd(today), to: ymd(today) };
    case 'YESTERDAY': { const y = addDays(today, -1); return { from: ymd(y), to: ymd(y) }; }
    case 'THIS_WEEK': {
      const monday = addDays(today, -((today.getUTCDay() + 6) % 7));
      return { from: ymd(monday), to: ymd(addDays(monday, 6)) };
    }
    case 'THIS_MONTH': {
      const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
      return { from: ymd(first), to: ymd(last) };
    }
    case 'CUSTOM': {
      let lo = isYmd(from) ? from : undefined;
      let hi = isYmd(to) ? to : undefined;
      if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
      return { from: lo, to: hi };
    }
    default: return {};
  }
}

/**
 * Prisma DateTime filter for an inclusive business-day range: from the start
 * of `from` up to (not including) the start of the day after `to`, both in
 * the business timezone. Returns undefined when there is no bound.
 */
export function businessDayRangeFilter(range: { from?: string; to?: string }): { gte?: Date; lt?: Date } | undefined {
  if (!range.from && !range.to) return undefined;
  const start = (s: string) => new Date(Date.parse(`${s}T00:00:00.000Z`) - offsetMs());
  return {
    ...(range.from ? { gte: start(range.from) } : {}),
    ...(range.to ? { lt: new Date(start(range.to).getTime() + 86_400_000) } : {})
  };
}

/** Start of the current business-calendar day (00:00 in the business timezone) as an instant. */
export function startOfBusinessDay(now: Date = new Date()): Date {
  return new Date(businessDay(now).getTime() - offsetMs());
}
