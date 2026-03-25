import fs from 'node:fs';

type TimestampData = Record<string, Record<string, string>>;

function readFile(filePath: string): TimestampData {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TimestampData;
  } catch {
    return {};
  }
}

export function getLastFetchTime(filePath: string, site: string, variant: string): string | null {
  const data = readFile(filePath);
  return data[site]?.[variant] ?? null;
}

export function setLastFetchTime(filePath: string, site: string, variant: string): void {
  const data = readFile(filePath);
  if (!data[site]) data[site] = {};
  data[site][variant] = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
