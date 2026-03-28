import type { ZodType } from 'zod';
import type { Primitives } from '../primitives/types.js';
import type { DetectFn } from '../primitives/rate-limit-detect.js';
import type { IngestItem } from '../storage/types.js';
import type { KnowledgeStore } from '../storage/index.js';

// ── Expose target ──────────────────────────────────────────────

export type ExposeTarget = 'mcp' | 'cli';

// ── CLI config ─────────────────────────────────────────────────

export interface CliArgDeclaration {
  name: string;
  description: string;
  required?: boolean;
}

export interface CliFlagDeclaration {
  name: string;
  alias?: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  default?: unknown;
}

export interface CliConfig {
  description: string;
  help: string;
  examples?: string[];
  args?: CliArgDeclaration[];
  flags?: CliFlagDeclaration[];
}

// ── Feed types (framework-level) ───────────────────────────────

export interface MediaItem {
  type: string;
  url: string;
  width: number;
  height: number;
  duration?: number;
  thumbnailUrl?: string;
}

export interface FeedItem {
  id: string;
  author: { handle: string; name: string };
  text: string;
  timestamp: string;
  url: string;
  media: MediaItem[];
  links: string[];
  /** Site-specific fields (metrics, categories, etc.) */
  siteMeta: Record<string, unknown>;
}

export interface FeedMeta {
  coveredUsers: string[];
  timeRange: { from: string; to: string };
}

export interface FeedResult {
  items: FeedItem[];
  meta: FeedMeta;
  debug?: Record<string, unknown>;
}

// ── Auth types ─────────────────────────────────────────────────

export interface CheckLoginResult {
  loggedIn: boolean;
}

// ── Capabilities ───────────────────────────────────────────────

export interface CacheConfig {
  defaultMaxAge: number;
  variantKey?: string;
  defaultVariant?: string;
}

export interface AuthCapability {
  /** Full login check (navigates + checks). Used by check_login tool. */
  check: (primitives: Primitives) => Promise<CheckLoginResult>;
  /** Auth guard check (does NOT navigate — page already loaded). Used by auth guard layer. */
  guard?: (primitives: Primitives) => Promise<{ loggedIn: boolean; diagnostics?: unknown }>;
  /** Whether to intercept navigate() calls with auth guard. Default: true.
   *  Set to false for sites where read-only operations don't require login. */
  guardNavigate?: boolean;
  description?: string;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

export interface FeedCapability {
  collect: (primitives: Primitives, params: unknown) => Promise<FeedResult>;
  params: ZodType;
  localQuery?: (store: KnowledgeStore, params: unknown) => Promise<FeedResult>;
  cache?: CacheConfig;
  description?: string;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

// ── Workflow declaration ───────────────────────────────────────

export interface WorkflowDeclaration {
  name: string;
  description: string;
  params: ZodType;
  execute: (primitives: Primitives, params: unknown) => Promise<unknown>;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

// ── Store adapter ──────────────────────────────────────────────

export interface StoreAdapter {
  toIngestItems: (items: FeedItem[]) => IngestItem[];
}

// ── Error hints ────────────────────────────────────────────────

export interface SiteErrorHints {
  sessionExpired?: string;
  rateLimited?: string;
  elementNotFound?: string;
  navigationFailed?: string;
  stateTransitionFailed?: string;
}

// ── SitePlugin (the contract) ──────────────────────────────────

export interface SitePlugin {
  apiVersion: 1;
  name: string;
  domains: string[];
  detect?: DetectFn;
  capabilities?: {
    auth?: AuthCapability;
    feed?: FeedCapability;
  };
  customWorkflows?: WorkflowDeclaration[];
  storeAdapter?: StoreAdapter;
  hints?: SiteErrorHints;
}
