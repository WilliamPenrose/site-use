// src/harness/structural-diff.ts
import type { StructuralDiffEntry } from './types.js';

function typeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function structuralDiff(
  golden: unknown,
  captured: unknown,
  prefix = '',
): StructuralDiffEntry[] {
  const results: StructuralDiffEntry[] = [];

  if (
    golden === null || captured === null ||
    typeof golden !== 'object' || typeof captured !== 'object'
  ) {
    return results;
  }

  // Arrays: compare first-element types only (opaque comparison)
  if (Array.isArray(golden) && Array.isArray(captured)) {
    if (golden.length > 0 && captured.length > 0) {
      const gType = typeLabel(golden[0]);
      const cType = typeLabel(captured[0]);
      if (gType !== cType) {
        results.push({
          path: prefix ? `${prefix}[]` : '[]',
          type: 'type_changed',
          goldenType: gType,
          capturedType: cType,
        });
      }
      if (gType === 'object' && cType === 'object') {
        results.push(
          ...structuralDiff(golden[0], captured[0], prefix ? `${prefix}[]` : '[]'),
        );
      }
    }
    return results;
  }

  if (Array.isArray(golden) || Array.isArray(captured)) {
    return results;
  }

  const gObj = golden as Record<string, unknown>;
  const cObj = captured as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(gObj), ...Object.keys(cObj)]);

  for (const key of allKeys) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const inGolden = key in gObj;
    const inCaptured = key in cObj;

    if (inGolden && !inCaptured) {
      results.push({ path: fullPath, type: 'removed', goldenType: typeLabel(gObj[key]) });
      continue;
    }

    if (!inGolden && inCaptured) {
      results.push({ path: fullPath, type: 'added', capturedType: typeLabel(cObj[key]) });
      continue;
    }

    const gType = typeLabel(gObj[key]);
    const cType = typeLabel(cObj[key]);

    if (gType !== cType) {
      results.push({ path: fullPath, type: 'type_changed', goldenType: gType, capturedType: cType });
      continue;
    }

    if (gType === 'object') {
      results.push(...structuralDiff(gObj[key], cObj[key], fullPath));
    }

    if (gType === 'array') {
      results.push(...structuralDiff(gObj[key], cObj[key], fullPath));
    }
  }

  return results;
}
