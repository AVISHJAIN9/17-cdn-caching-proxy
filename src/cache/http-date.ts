/**
 * RFC 9110 Section 5.6.7 HTTP Date Parser.
 * Pure function: parseHttpDate(value: string | undefined): number | null
 *
 * Accepts:
 * 1. IMF-fixdate: "Sun, 06 Nov 1994 08:49:37 GMT"
 * 2. RFC 850 date: "Sunday, 06-Nov-94 08:49:37 GMT" (with 50-year rollover)
 * 3. ANSI C asctime: "Sun Nov  6 08:49:37 1994" / "Sun Nov 16 08:49:37 1994"
 *
 * Rejects:
 * - Impossible dates (e.g. Feb 30)
 * - Missing "GMT" on IMF-fixdate or RFC 850
 * - Numeric timezones (+0000)
 * - Trailing or leading garbage
 * - Anything not matching the three standard formats
 */

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

// 1. IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
const IMF_FIXDATE_REGEX =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

// 2. RFC 850: Sunday, 06-Nov-94 08:49:37 GMT
const RFC_850_REGEX =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Formats epoch ms into IMF-fixdate: "Sun, 06 Nov 1994 08:49:37 GMT".
 * Hand-written from UTC fields with fixed day and month name arrays, zero-padded.
 * Supports years 1970-9999.
 */
export function formatHttpDate(epochMs: number): string {
  const d = new Date(epochMs);
  const dayName = DAY_NAMES[d.getUTCDay()];
  const day = pad2(d.getUTCDate());
  const monthName = MONTH_NAMES[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hours = pad2(d.getUTCHours());
  const minutes = pad2(d.getUTCMinutes());
  const seconds = pad2(d.getUTCSeconds());

  return `${dayName}, ${day} ${monthName} ${year} ${hours}:${minutes}:${seconds} GMT`;
}

// 3. ANSI C asctime: Sun Nov  6 08:49:37 1994 or Sun Nov 16 08:49:37 1994
const ASCTIME_REGEX =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: (\d)|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, monthIndex: number): number {
  switch (monthIndex) {
    case 0: // Jan
    case 2: // Mar
    case 4: // May
    case 6: // Jul
    case 7: // Aug
    case 9: // Oct
    case 11: // Dec
      return 31;
    case 3: // Apr
    case 5: // Jun
    case 8: // Sep
    case 10: // Nov
      return 30;
    case 1: // Feb
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Resolves 2-digit year according to RFC 9110:
 * A year that appears to be more than 50 years in the future is interpreted
 * as representing the most recent past year with the same last two digits.
 */
export function resolveTwoDigitYear(
  yy: number,
  referenceYear: number = new Date().getUTCFullYear()
): number {
  const century = Math.floor(referenceYear / 100) * 100;
  let candidate = century + yy;
  if (candidate - referenceYear > 50) {
    candidate -= 100;
  }
  return candidate;
}

/**
 * Validates calendar date and time components.
 * Returns epoch ms in UTC, or null if invalid.
 */
function buildUtcEpoch(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number | null {
  if (year < 1600 || year > 9999) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;

  const maxDays = daysInMonth(year, monthIndex);
  if (day < 1 || day > maxDays) return null;

  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  // Allow leap second (60), clamp to 59 for UTC epoch calculation
  if (second < 0 || second > 60) return null;
  const clampedSecond = Math.min(second, 59);

  return Date.UTC(year, monthIndex, day, hour, minute, clampedSecond);
}

/**
 * Hand-written parser for HTTP-date header values.
 * Returns epoch ms (UTC) or null if invalid.
 */
export function parseHttpDate(
  value: string | undefined,
  referenceYear?: number
): number | null {
  if (!value || typeof value !== 'string') {
    return null;
  }

  // 1. Try IMF-fixdate: "Sun, 06 Nov 1994 08:49:37 GMT"
  const imfMatch = value.match(IMF_FIXDATE_REGEX);
  if (imfMatch) {
    const day = parseInt(imfMatch[2], 10);
    const monthIndex = MONTHS[imfMatch[3]];
    const year = parseInt(imfMatch[4], 10);
    const hour = parseInt(imfMatch[5], 10);
    const minute = parseInt(imfMatch[6], 10);
    const second = parseInt(imfMatch[7], 10);
    return buildUtcEpoch(year, monthIndex, day, hour, minute, second);
  }

  // 2. Try RFC 850: "Sunday, 06-Nov-94 08:49:37 GMT"
  const rfc850Match = value.match(RFC_850_REGEX);
  if (rfc850Match) {
    const day = parseInt(rfc850Match[2], 10);
    const monthIndex = MONTHS[rfc850Match[3]];
    const twoDigitYear = parseInt(rfc850Match[4], 10);
    const year = resolveTwoDigitYear(twoDigitYear, referenceYear);
    const hour = parseInt(rfc850Match[5], 10);
    const minute = parseInt(rfc850Match[6], 10);
    const second = parseInt(rfc850Match[7], 10);
    return buildUtcEpoch(year, monthIndex, day, hour, minute, second);
  }

  // 3. Try ANSI C asctime: "Sun Nov  6 08:49:37 1994" or "Sun Nov 16 08:49:37 1994"
  const asctimeMatch = value.match(ASCTIME_REGEX);
  if (asctimeMatch) {
    const monthIndex = MONTHS[asctimeMatch[2]];
    // If single digit (captured in group 3), use it, otherwise slice the 2-character day
    const dayStr = asctimeMatch[3] !== undefined ? asctimeMatch[3] : value.substring(8, 10).trim();
    const day = parseInt(dayStr, 10);
    const hour = parseInt(asctimeMatch[4], 10);
    const minute = parseInt(asctimeMatch[5], 10);
    const second = parseInt(asctimeMatch[6], 10);
    const year = parseInt(asctimeMatch[7], 10);
    return buildUtcEpoch(year, monthIndex, day, hour, minute, second);
  }

  return null;
}
