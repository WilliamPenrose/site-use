// src/storage/index.ts
import { initializeDatabase } from './schema.js';
import { ingest as ingestImpl } from './ingest.js';
import { search as searchImpl, stats as statsImpl, countItems as countItemsImpl, statsBySite as statsBySiteImpl } from './query.js';
import type { KnowledgeStore, IngestItem, IngestResult, SearchParams, SearchResult, StoreStats, RebuildResult, CountItemsParams, SiteStats } from './types.js';

export type { KnowledgeStore, IngestItem, IngestResult, SearchParams, SearchResult, SearchResultItem, StoreStats, SiteStats, RebuildResult, MetricEntry, MetricFilter, CountItemsParams } from './types.js';

export function createStore(dbPath: string): KnowledgeStore {
  const db = initializeDatabase(dbPath);

  return {
    async ingest(items: IngestItem[]): Promise<IngestResult> {
      return ingestImpl(db, items);
    },
    async search(params: SearchParams): Promise<SearchResult> {
      return searchImpl(db, params);
    },
    async countItems(params: CountItemsParams): Promise<number> {
      return countItemsImpl(db, params);
    },
    async stats(): Promise<StoreStats> {
      return statsImpl(db);
    },
    async statsBySite(site?: string): Promise<Record<string, SiteStats>> {
      return statsBySiteImpl(db, site);
    },
    async rebuild(): Promise<RebuildResult> {
      throw new Error('rebuild is not available until Phase 2');
    },
    close(): void {
      db.close();
    },
  };
}
