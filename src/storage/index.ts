// src/storage/index.ts
import { initializeDatabase } from './schema.js';
import { ingest as ingestImpl } from './ingest.js';
import { search as searchImpl, countItems as countItemsImpl, statsBySite as statsBySiteImpl } from './query.js';
import { deleteItems as deleteImpl, previewDelete as previewDeleteImpl, exportItems as exportItemsImpl } from './delete.js';
import type { KnowledgeStore, IngestItem, IngestResult, SearchParams, SearchResult, RebuildResult, CountItemsParams, SiteStats, DeleteParams, DeleteOptions } from './types.js';

export type { KnowledgeStore, IngestItem, IngestResult, SearchParams, SearchResult, SearchResultItem, SiteStats, RebuildResult, MetricEntry, MetricFilter, CountItemsParams, DeleteParams, DeletePreview, DeleteResult, DeleteProgress, DeleteOptions } from './types.js';

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
    async statsBySite(site?: string): Promise<Record<string, SiteStats>> {
      return statsBySiteImpl(db, site);
    },
    async rebuild(): Promise<RebuildResult> {
      throw new Error('rebuild is not available until Phase 2');
    },
    async deleteItems(params: DeleteParams, opts?: DeleteOptions) {
      return deleteImpl(db, params, opts);
    },
    async previewDelete(params: DeleteParams) {
      return previewDeleteImpl(db, params);
    },
    exportItems(params: DeleteParams, onLine: (line: string) => void) {
      return exportItemsImpl(db, params, onLine);
    },
    close(): void {
      db.close();
    },
  };
}
