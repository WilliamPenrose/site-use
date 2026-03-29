/** Convert a UTC ISO string to local timezone ISO 8601 with offset. */
export function utcToLocalIso(utcIso: string): string {
  if (!utcIso) return '';
  const d = new Date(utcIso);
  if (isNaN(d.getTime())) return utcIso;

  const offsetMin = d.getTimezoneOffset();
  const sign = offsetMin <= 0 ? '+' : '-';
  const absH = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
  const absM = String(Math.abs(offsetMin) % 60).padStart(2, '0');
  const offset = `${sign}${absH}:${absM}`;

  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());

  return `${y}-${mo}-${day}T${h}:${mi}:${s}${offset}`;
}

/** Recursively convert all 'timestamp' fields in an object from UTC to local ISO. */
export function localizeTimestamps(obj: unknown): unknown {
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(localizeTimestamps);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'timestamp' && typeof val === 'string') {
        result[key] = utcToLocalIso(val);
      } else {
        result[key] = localizeTimestamps(val);
      }
    }
    return result;
  }
  return obj;
}
