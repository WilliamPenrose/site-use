// src/storage/index.ts
import { initializeDatabase } from './schema.js';
import { ingest as ingestImpl } from './ingest.js';
import { search as searchImpl, stats as statsImpl } from './query.js';
import type { KnowledgeStore, IngestItem, IngestResult, SearchParams, SearchResult, StoreStats, RebuildResult } from './types.js';

export type { KnowledgeStore, IngestItem, IngestResult, SearchParams, SearchResult, SearchResultItem, StoreStats, RebuildResult } from './types.js';

export function createStore(dbPath: string): KnowledgeStore {
  const db = initializeDatabase(dbPath);

  return {
    async ingest(items: IngestItem[]): Promise<IngestResult> {
      return ingestImpl(db, items);
    },
    async search(params: SearchParams): Promise<SearchResult> {
      return searchImpl(db, params);
    },
    async stats(): Promise<StoreStats> {
      return statsImpl(db);
    },
    async rebuild(): Promise<RebuildResult> {
      throw new Error('rebuild is not available until Phase 2');
    },
    close(): void {
      db.close();
    },
  };
}
