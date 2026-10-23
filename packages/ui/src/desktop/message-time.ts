const pad = (value: number) => String(value).padStart(2, '0');
const sameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

/** Display the recorded instant in the reader's local calendar, including across DST. */
export function formatMessageTime(createdAtMs: number | undefined, nowMs = Date.now()) {
  if (createdAtMs === undefined || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0)
    return undefined;
  const date = new Date(createdAtMs);
  const now = new Date(nowMs);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) return undefined;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const calendar = `${date.getMonth() + 1}月${date.getDate()}日`;
  const label = sameDay(date, now)
    ? clock
    : sameDay(date, yesterday)
      ? `昨天 ${clock}`
      : `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${calendar} ${clock}`;
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return {
    label,
    dateTime: date.toISOString(),
    full: `${date.getFullYear()}年${calendar} ${clock}:${pad(date.getSeconds())}（${zone}）`,
  };
}
