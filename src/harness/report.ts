import type { HarnessReport, VariantResult, StructuralDiffEntry } from './types.js';

function formatDiffEntry(entry: StructuralDiffEntry): string {
  switch (entry.type) {
    case 'added':
      return `    + ${entry.path}  (${entry.capturedType}, new)`;
    case 'removed':
      return `    - ${entry.path}  (${entry.goldenType}, missing)`;
    case 'type_changed':
      return `    ~ ${entry.path}  (${entry.goldenType} → ${entry.capturedType})`;
  }
}

function formatVariantResult(result: VariantResult): string {
  const lines: string[] = [];

  for (const layer of result.layers) {
    const icon = layer.pass ? '✓' : '✗';
    lines.push(`  ${icon} ${layer.layer}${layer.pass ? '' : ': FAILED'}`);
    for (const err of layer.errors) {
      lines.push(`    Error: ${err}`);
    }
  }

  if (result.structuralDiff && result.structuralDiff.length > 0) {
    lines.push('');
    lines.push('  Structural diff:');
    for (const d of result.structuralDiff) {
      lines.push(formatDiffEntry(d));
    }
  }

  return lines.join('\n');
}

/** Format a HarnessReport into human-readable diagnostic text. */
export function formatReport(report: HarnessReport): string {
  const lines: string[] = [];

  lines.push(`[HARNESS] ${report.site}/${report.domain} — ${report.source} (${report.totalVariants} variants)`);
  lines.push(`  Passed: ${report.passed}  Failed: ${report.failed}`);
  lines.push('');

  for (const result of report.results) {
    if (result.pass) {
      lines.push(`  ✓ ${result.variant}`);
    } else {
      lines.push(`  ✗ ${result.variant}`);
      lines.push(formatVariantResult(result));
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Format a summary line for stderr output. */
export function formatSummary(reports: HarnessReport[]): string {
  let totalPassed = 0;
  let totalFailed = 0;
  for (const r of reports) {
    totalPassed += r.passed;
    totalFailed += r.failed;
  }

  if (totalFailed === 0) {
    return `[harness] All ${totalPassed} variants passed.`;
  }

  return `[harness] ${totalFailed} of ${totalPassed + totalFailed} variants FAILED.`;
}
