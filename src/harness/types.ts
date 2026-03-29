// src/harness/types.ts
import type { FeedItem } from '../registry/types.js';
import type { IngestItem, SearchResultItem } from '../storage/types.js';
import type { DisplaySchema } from '../display/resolve.js';

// --- Assertion types ---

export interface AssertionContext {
  variant: string;
  layer: number;
  input: unknown;
  output: unknown;
}

export interface AssertionResult {
  pass: boolean;
  message?: string;
}

export type AssertionFn = (ctx: AssertionContext) => AssertionResult;

// --- Domain descriptor ---

export interface DomainDescriptor {
  /** Extract individual entries from a full API response body. */
  extractEntries: (responseBody: string) => unknown[];
  /** Parse a single raw entry into a structured intermediate form. */
  parseEntry: (rawEntry: unknown) => unknown;
  /** Convert parsed result into a FeedItem. */
  toFeedItem: (parsed: unknown) => FeedItem;
  /** Compute a variant signature string from a raw entry. */
  variantSignature: (rawEntry: unknown) => string;
  /** Domain-specific assertions keyed by variant tag. */
  assertions: Record<string, AssertionFn[]>;
}

// --- Site harness descriptor ---

export interface SiteHarnessDescriptor {
  domains: Record<string, DomainDescriptor>;
  storeAdapter: (items: FeedItem[]) => IngestItem[];
  displaySchema: DisplaySchema;
  formatFn?: (item: SearchResultItem) => string;
  formatAssertions?: Record<string, AssertionFn[]>;
}

// --- Structural diff ---

export interface StructuralDiffEntry {
  path: string;
  type: 'added' | 'removed' | 'type_changed';
  goldenType?: string;
  capturedType?: string;
}

// --- Layer result ---

export interface LayerResult {
  layer: string;
  pass: boolean;
  output?: unknown;
  errors: string[];
}

// --- Variant result ---

export interface VariantResult {
  variant: string;
  pass: boolean;
  /** The first layer that failed, e.g. "Layer 4a→4b" */
  failedLayer?: string;
  message?: string;
  layers: LayerResult[];
  structuralDiff?: StructuralDiffEntry[];
}

// --- Harness report ---

export interface HarnessReport {
  site: string;
  domain: string;
  source: 'golden' | 'captured' | 'quarantine';
  totalVariants: number;
  passed: number;
  failed: number;
  results: VariantResult[];
}
