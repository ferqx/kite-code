const MS_PER_DAY = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Deterministically format an epoch millisecond value without constructing a
 * clock-bearing Date object in the Kernel. The supported interval and expanded
 * year spelling match Date.prototype.toISOString.
 */
export function epochMillisecondsToIsoUtc(value: number): string | null {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_MS) return null;

  const days = Math.floor(value / MS_PER_DAY);
  let milliseconds = value - days * MS_PER_DAY;
  const hours = Math.floor(milliseconds / 3_600_000);
  milliseconds %= 3_600_000;
  const minutes = Math.floor(milliseconds / 60_000);
  milliseconds %= 60_000;
  const seconds = Math.floor(milliseconds / 1_000);
  milliseconds %= 1_000;

  // Inverse proleptic Gregorian calendar, with day zero at 1970-01-01.
  const shiftedDays = days + 719_468;
  const era = Math.floor(shiftedDays / 146_097);
  const dayOfEra = shiftedDays - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex + (monthIndex < 10 ? 3 : -9);
  if (month <= 2) year += 1;
  const yearText =
    year >= 0 && year <= 9_999 ? pad(year, 4) : `${year < 0 ? '-' : '+'}${pad(Math.abs(year), 6)}`;

  return `${yearText}-${pad(month, 2)}-${pad(day, 2)}T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}Z`;
}
