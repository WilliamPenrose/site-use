import { vi } from 'vitest';
import { z } from 'zod';
import type { Primitives, Snapshot, SnapshotNode } from '../primitives/types.js';

/**
 * Create a mock Primitives object with all methods as Vitest spies.
 */
export function createMockPrimitives(overrides: Partial<Primitives> = {}): Primitives {
  return {
    navigate: vi.fn(async () => {}),
    takeSnapshot: vi.fn(async () => ({ idToNode: new Map() })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    pressKey: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    scrollIntoView: vi.fn(async () => {}),
    evaluate: vi.fn(async () => undefined as never),
    screenshot: vi.fn(async () => ''),
    interceptRequest: vi.fn(async () => () => {}),
    getRawPage: vi.fn(async () => ({}) as never),
    ...overrides,
  };
}

/**
 * Build a Snapshot (idToNode Map) from an array of nodes.
 */
export function buildSnapshot(nodes: SnapshotNode[]): Snapshot {
  const idToNode = new Map<string, SnapshotNode>();
  for (const node of nodes) {
    idToNode.set(node.uid, node);
  }
  return { idToNode };
}

/**
 * Create a mock KnowledgeStore with all methods as Vitest spies.
 */
export function createMockStore() {
  return {
    ingest: vi.fn(async () => ({ inserted: 0, duplicates: 0 })),
    search: vi.fn(async () => ({ items: [] })),
    countItems: vi.fn(async () => 0),
    statsBySite: vi.fn(async () => ({})),
    deleteItems: vi.fn(async () => ({ deleted: 0 })),
    previewDelete: vi.fn(async () => ({ totalCount: 0, authors: [], timeRange: null })),
    exportItems: vi.fn(),
    rebuild: vi.fn(async () => ({ processed: 0, elapsed: 0 })),
    close: vi.fn(),
  };
}

const IngestItemSchema = z.object({
  site: z.string(),
  id: z.string(),
  text: z.string(),
  author: z.string(),
  timestamp: z.string(),
  url: z.string(),
  rawJson: z.string(),
  metrics: z.array(z.object({
    metric: z.string(),
    numValue: z.number().optional(),
    realValue: z.number().optional(),
    strValue: z.string().optional(),
  })).optional(),
  mentions: z.array(z.string()).optional(),
  hashtags: z.array(z.string()).optional(),
});

/**
 * Validate that an array of items conforms to the IngestItem schema.
 */
export function assertIngestItems(items: unknown[]): void {
  z.array(IngestItemSchema).parse(items);
}
