// tests/unit/harness-structural-diff.test.ts
import { describe, it, expect } from 'vitest';
import { structuralDiff } from '../../src/harness/structural-diff.js';

describe('structuralDiff', () => {
  it('returns empty array for identical structures', () => {
    const a = { name: 'hello', count: 42 };
    const b = { name: 'world', count: 99 };
    expect(structuralDiff(a, b)).toEqual([]);
  });

  it('detects added keys', () => {
    const golden = { name: 'hello' };
    const captured = { name: 'world', age: 25 };
    const diff = structuralDiff(golden, captured);
    expect(diff).toEqual([
      { path: 'age', type: 'added', capturedType: 'number' },
    ]);
  });

  it('detects removed keys', () => {
    const golden = { name: 'hello', age: 25 };
    const captured = { name: 'world' };
    const diff = structuralDiff(golden, captured);
    expect(diff).toEqual([
      { path: 'age', type: 'removed', goldenType: 'number' },
    ]);
  });

  it('detects type changes', () => {
    const golden = { count: 42 };
    const captured = { count: 'forty-two' };
    const diff = structuralDiff(golden, captured);
    expect(diff).toEqual([
      { path: 'count', type: 'type_changed', goldenType: 'number', capturedType: 'string' },
    ]);
  });

  it('recurses into nested objects', () => {
    const golden = { legacy: { full_text: 'hi', favorite_count: 10 } };
    const captured = { legacy: { full_text: 'yo', favorite_count: 20, new_field: 'x' } };
    const diff = structuralDiff(golden, captured);
    expect(diff).toEqual([
      { path: 'legacy.new_field', type: 'added', capturedType: 'string' },
    ]);
  });

  it('detects nested removed keys', () => {
    const golden = { legacy: { full_text: 'hi', original_info: {} } };
    const captured = { legacy: { full_text: 'hi' } };
    const diff = structuralDiff(golden, captured);
    expect(diff).toEqual([
      { path: 'legacy.original_info', type: 'removed', goldenType: 'object' },
    ]);
  });

  it('treats arrays as opaque (compares element types, not length)', () => {
    const golden = { items: [1, 2, 3] };
    const captured = { items: [4, 5] };
    expect(structuralDiff(golden, captured)).toEqual([]);
  });

  it('detects array element type change', () => {
    const golden = { items: [1, 2] };
    const captured = { items: ['a', 'b'] };
    const diff = structuralDiff(golden, captured);
    expect(diff).toEqual([
      { path: 'items[]', type: 'type_changed', goldenType: 'number', capturedType: 'string' },
    ]);
  });

  it('handles null values', () => {
    const golden = { field: null };
    const captured = { field: 'value' };
    const diff = structuralDiff(golden, captured);
    expect(diff).toEqual([
      { path: 'field', type: 'type_changed', goldenType: 'null', capturedType: 'string' },
    ]);
  });
});
