// src/storage/types.ts

export interface MetricEntry {
  metric: string;
  numValue?: number;
  realValue?: number;
  strValue?: string;
}

export interface MetricFilter {
  metric: string;
  op: '>=' | '<=' | '=';
  numValue?: number;
  realValue?: number;
  strValue?: string;
}

export interface IngestItem {
  site: string;
  id: string;
  text: string;
  author: string;
  timestamp: string;
  url: string;
  rawJson: string;
  metrics?: MetricEntry[];
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
  mention?: string;
  metricFilters?: MetricFilter[];
  fields?: SearchField[];
}

export const SEARCH_FIELDS = ['author', 'text', 'url', 'timestamp', 'links', 'mentions', 'media'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

export interface SearchResultItem {
  id: string;
  site: string;
  text?: string;
  author?: string;
  timestamp?: string;
  url?: string;
  links?: string[];
  mentions?: string[];
  media?: Array<{ type: string; url: string; width: number; height: number; duration?: number }>;
  siteMeta?: Record<string, unknown>;
}

export interface SearchResult {
  items: SearchResultItem[];
}

export interface SiteStats {
  totalPosts: number;
  uniqueAuthors: number;
  oldestPost: string;
  newestPost: string;
}

export interface RebuildResult {
  processed: number;
  elapsed: number;
}

export interface CountItemsParams {
  site: string;
  metricFilters?: MetricFilter[];
}

export interface DeleteParams {
  site: string;
  before?: string;
  after?: string;
  ingestedBefore?: string;
  ingestedAfter?: string;
  author?: string;
}

export interface DeletePreview {
  totalCount: number;
  authors: Array<{ handle: string; count: number }>;
  timeRange: { from: string; to: string } | null;
}

export interface DeleteProgress {
  deletedSoFar: number;
  totalCount: number;
}

export interface DeleteResult {
  deleted: number;
}

export interface DeleteOptions {
  batchSize?: number;
  onProgress?: (progress: DeleteProgress) => void;
}

export interface KnowledgeStore {
  ingest(items: IngestItem[]): Promise<IngestResult>;
  search(params: SearchParams): Promise<SearchResult>;
  countItems(params: CountItemsParams): Promise<number>;
  statsBySite(site?: string): Promise<Record<string, SiteStats>>;
  rebuild(opts?: { model?: string }): Promise<RebuildResult>;
  deleteItems(params: DeleteParams, opts?: DeleteOptions): Promise<DeleteResult>;
  previewDelete(params: DeleteParams): Promise<DeletePreview>;
  exportItems(params: DeleteParams, onLine: (line: string) => void): void;
  close(): void;
}
