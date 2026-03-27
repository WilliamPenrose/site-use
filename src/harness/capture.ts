import type { DomainDescriptor } from './types.js';
import { loadGoldenVariants, saveCaptured, type FixtureEntry } from './fixture-io.js';
import { structuralDiff } from './structural-diff.js';

export interface CaptureResult {
  captured: number;
  skipped: number;
}

/**
 * Async capture hook: extract entries from a raw response body, compute variant
 * signatures, compare structure against golden fixtures, and save novel entries
 * to captured/ directory.
 *
 * This is fire-and-forget — errors are swallowed to avoid disrupting the main flow.
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

  try {
    const entries = domain.extractEntries(responseBody);
    if (entries.length === 0) return { captured: 0, skipped: 0 };

    const goldenVariants = loadGoldenVariants(goldenDirPath, domainName);
    const goldenByVariant = new Map<string, FixtureEntry>();
    for (const g of goldenVariants) {
      goldenByVariant.set(g._variant, g);
    }

    for (const entry of entries) {
      const sig = domain.variantSignature(entry);
      const goldenMatch = goldenByVariant.get(sig);

      if (goldenMatch) {
        // Strip the harness-only _variant key before structural comparison
        const { _variant: _ignored, ...goldenData } = goldenMatch;
        const diff = structuralDiff(goldenData, entry);
        if (diff.length === 0) {
          skipped++;
          continue;
        }
      }

      const fixtureEntry: FixtureEntry = { _variant: sig, ...(entry as Record<string, unknown>) };
      saveCaptured(capturedDirPath, domainName, fixtureEntry);
      captured++;
    }
  } catch {
    // Fire-and-forget: never disrupt the main flow
  }

  return { captured, skipped };
}
