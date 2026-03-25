/** Convert a UTC ISO string to local time display with timezone label. */
export function utcToLocalDisplay(utcIso: string): string {
  if (!utcIso) return '';
  const d = new Date(utcIso);
  const pad = (n: number) => String(n).padStart(2, '0');

  const offsetMin = d.getTimezoneOffset();
  const sign = offsetMin <= 0 ? '+' : '-';
  const absHours = Math.floor(Math.abs(offsetMin) / 60);
  const absMinutes = Math.abs(offsetMin) % 60;
  const tz = absMinutes === 0
    ? `UTC${sign}${absHours}`
    : `UTC${sign}${absHours}:${pad(absMinutes)}`;

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${tz})`;
}
