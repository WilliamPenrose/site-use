import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGoldenVariants } from '../../src/harness/fixture-io.js';
import { runVariant } from '../../src/harness/runner.js';
import { twitterHarness } from '../../src/sites/twitter/harness.js';
import type { FixtureEntry } from '../../src/harness/fixture-io.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(__dirname, '..', '..', 'src', 'sites', 'twitter', '__tests__', 'fixtures', 'golden');

const variants: FixtureEntry[] = loadGoldenVariants(goldenDir, 'timeline');

describe('harness golden — twitter/timeline', () => {
  beforeAll(() => {
    const tag = `twitter/timeline · ${variants.length} variants`;
    const line = '═'.repeat(tag.length + 6);
    console.log(`\n  ╔═${line}═╗`);
    console.log(`  ║   HARNESS · ${tag}   ║`);
    console.log(`  ╚═${line}═╝`);
  });

  it('golden fixture file loads with expected variant count', () => {
    expect(variants.length).toBeGreaterThanOrEqual(30);
  });

  describe.each(variants.map((v) => [v._variant, v] as const))(
    'variant: %s',
    (_name, fixture) => {
      it('passes all pipeline layers', async () => {
        const result = await runVariant(twitterHarness, 'timeline', fixture);
        if (!result.pass) {
          const failInfo = result.layers
            .filter((l) => !l.pass)
            .map((l) => `${l.layer}: ${l.errors.join(', ')}`)
            .join('\n');
          expect.fail(
            `Variant "${result.variant}" failed at ${result.failedLayer}:\n${failInfo}\n${result.message}`,
          );
        }
        expect(result.pass).toBe(true);
      });
    },
  );
});
