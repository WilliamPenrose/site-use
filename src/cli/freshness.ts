import path from 'node:path';
import { getLastFetchTime } from '../fetch-timestamps.js';

export interface FreshnessCheck {
  shouldFetch: boolean;
  reason: 'no_data' | 'stale' | 'fresh';
  ageMinutes?: number;
}

export function checkFreshness(dataDir: string, site: string, variant: string, maxAgeMinutes: number): FreshnessCheck {
  const filePath = path.join(dataDir, 'fetch-timestamps.json');
  const lastFetch = getLastFetchTime(filePath, site, variant);

  if (!lastFetch) {
    return { shouldFetch: true, reason: 'no_data' };
  }

  const ageMs = Date.now() - new Date(lastFetch).getTime();
  const ageMinutes = Math.round(ageMs / 60_000);

  if (ageMs > maxAgeMinutes * 60_000) {
    return { shouldFetch: true, reason: 'stale', ageMinutes };
  }

  return { shouldFetch: false, reason: 'fresh', ageMinutes };
}

export function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h${mins}min` : `${hours}h`;
}
