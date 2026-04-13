import type { ZodType } from 'zod';
import type { Primitives } from '../primitives/types.js';
import type { DetectFn } from '../primitives/rate-limit-detect.js';
import type { Trace } from '../trace.js';

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
  /** Reply target — present when this item is a reply to another post. */
  inReplyTo?: {
    handle: string;
    id: string;
    text?: string;
  };
}

export interface FeedMeta {
  coveredUsers: string[];
  timeRange: { from: string; to: string };
  extra?: Record<string, unknown>;
}

export interface FeedResult {
  items: FeedItem[];
  ancestors?: FeedItem[];
  meta: FeedMeta;
}

// ── Auth types ─────────────────────────────────────────────────

export interface CheckLoginResult {
  loggedIn: boolean;
}

// ── Capabilities ───────────────────────────────────────────────

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

// ── Workflow declaration ───────────────────────────────────────

interface WorkflowBase {
  name: string;
  description: string;
  params: ZodType;
  execute: (primitives: Primitives, params: unknown, trace?: Trace) => Promise<unknown>;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

export interface CollectionWorkflow extends WorkflowBase {
  kind: 'collection';
  dumpRaw?: boolean;
}

export interface ActionWorkflow extends WorkflowBase {
  kind: 'action';
  dailyLimit?: number;
  /** Comma-separated action names for shared daily limit quota (e.g. 'follow,unfollow'). */
  dailyLimitKey?: string;
}

export interface QueryWorkflow extends WorkflowBase {
  kind: 'query';
}

export type WorkflowDeclaration = CollectionWorkflow | ActionWorkflow | QueryWorkflow;

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
  // ── Identity ──
  apiVersion: 1;
  name: string;
  domains: string[];
  detect?: DetectFn;

  // ── Site-wide capabilities ──
  auth?: AuthCapability;
  hints?: SiteErrorHints;

  // ── Per-operation capabilities ──
  workflows?: WorkflowDeclaration[];
}
