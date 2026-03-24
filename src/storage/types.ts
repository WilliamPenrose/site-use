// src/storage/types.ts

export interface IngestItem {
  site: string;
  id: string;
  text: string;
  author: string;
  timestamp: string;
  url: string;
  rawJson: string;
  siteMeta?: Record<string, unknown>;
  mentions?: string[];
  hashtags?: string[];
}

export interface IngestResult {
  inserted: number;
  duplicates: number;
  timeRange?: { from: string; to: string };
}

export interface SearchParams {
  query?: string;
  site?: string;
  author?: string;
  start_date?: string;
  end_date?: string;
  max_results?: number;
  hashtag?: string;
  min_likes?: number;
  min_retweets?: number;
  fields?: Array<'author' | 'text' | 'url' | 'timestamp' | 'likes' | 'retweets' | 'replies' | 'views'>;
}

export interface SearchResultItem {
  id: string;
  site: string;
  text: string;
  author: string;
  timestamp: string;
  url: string;
  snippet?: string;
  siteMeta?: Record<string, unknown>;
}

export interface SearchResult {
  items: SearchResultItem[];
}

export interface StoreStats {
  totalItems: number;
  bySite: Record<string, number>;
  uniqueAuthors: number;
  timeRange: { from: string; to: string } | null;
  embeddingModel: string | null;         // Phase 2, returns null in Phase 1
  embeddingCoverage: number;             // Phase 2, returns 0 in Phase 1
}

export interface RebuildResult {
  processed: number;
  elapsed: number;
}

export interface KnowledgeStore {
  ingest(items: IngestItem[]): Promise<IngestResult>;
  search(params: SearchParams): Promise<SearchResult>;
  stats(): Promise<StoreStats>;
  rebuild(opts?: { model?: string }): Promise<RebuildResult>;  // Phase 2
  close(): void;
}
