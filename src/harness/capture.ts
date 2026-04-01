import type { DomainDescriptor } from './types.js';
import { loadGoldenVariants, upsertCaptured, type FixtureEntry } from './fixture-io.js';
import { structuralDiff } from './structural-diff.js';

export interface CaptureResult {
  captured: number;
  skipped: number;
}

/**
 * Extract entries from a raw response body, compute variant signatures,
 * compare structure against golden fixtures, and upsert novel entries
 * into captured/{domain}-variants.json.
 */
export async function captureForHarness(
  responseBody: string,
  domain: DomainDescriptor,
  domainName: string,
  goldenDirPath: string,
  capturedDirPath: string,
): Promise<CaptureResult> {
  let captured = 0;
  let skipped = 0;

  const entries = domain.extractEntries(responseBody);
  if (entries.length === 0) return { captured: 0, skipped: 0 };

  const goldenVariants = loadGoldenVariants(goldenDirPath, domainName);
  const goldenByVariant = new Map<string, FixtureEntry>();
  for (const g of goldenVariants) {
    goldenByVariant.set(g._variant, g);
  }

  const novelEntries: FixtureEntry[] = [];

  for (const entry of entries) {
    const sig = domain.variantSignature(entry);
    const goldenMatch = goldenByVariant.get(sig);

    if (goldenMatch) {
      const { _variant: _ignored, ...goldenData } = goldenMatch;
      const diff = structuralDiff(goldenData, entry);
      if (diff.length === 0) {
        skipped++;
        continue;
      }
    }

    novelEntries.push({ _variant: sig, ...(entry as Record<string, unknown>) });
    captured++;
  }

  if (novelEntries.length > 0) {
    upsertCaptured(capturedDirPath, domainName, novelEntries);
  }

  return { captured, skipped };
}
