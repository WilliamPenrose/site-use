import { z, type ZodType } from 'zod';
import type { SiteRuntime } from '../runtime/types.js';
import { SiteUseError, BrowserDisconnected, RateLimited, DailyLimitExceeded } from '../errors.js';
import { resolveHint } from './default-descriptions.js';
import { Trace, type TraceData } from '../trace.js';

const IngestItemSchema = z.object({
  site: z.string(), id: z.string(), text: z.string(), author: z.string(),
  timestamp: z.string(), url: z.string(), rawJson: z.string(),
  metrics: z.array(z.object({
    metric: z.string(), numValue: z.number().optional(),
    realValue: z.number().optional(), strValue: z.string().optional(),
  })).optional(),
  mentions: z.array(z.string()).optional(),
  hashtags: z.array(z.string()).optional(),
  sourceTabs: z.array(z.string()).optional(),
});

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface ActionOpts {
  dailyLimit?: number;
  dailyLimitKey?: string;
}

export interface WrapOptions {
  siteName: string;
  toolName: string;
  handler: (params: Record<string, unknown>, runtime: SiteRuntime, trace: Trace) => Promise<unknown>;
  getRuntime: () => Promise<SiteRuntime>;
  paramsSchema?: ZodType;
  resultSchema?: ZodType;
  onBrowserDisconnected?: () => void;
  autoIngest?: {
    storeAdapter: { toIngestItems: (items: any[], context?: Record<string, unknown>) => any[] };
    siteName: string;
  };
  actionOpts?: ActionOpts;
}

export function wrapToolHandler(opts: WrapOptions): (params: Record<string, unknown>) => Promise<ToolResult> {
  return async (rawParams) => {
    let runtime: SiteRuntime;
    try {
      runtime = await opts.getRuntime();
    } catch (err) {
      return formatError(opts.siteName, err as Error, undefined, opts.onBrowserDisconnected);
    }

    if (runtime.circuitBreaker.isTripped) {
      return formatError(
        opts.siteName,
        new RateLimited(
          `${runtime.circuitBreaker.streak || 5} consecutive operation failures on ${opts.siteName} — circuit breaker triggered. Wait before retrying.`,
        ),
        undefined,
      );
    }

    let parsedParams: Record<string, unknown> = rawParams;
    if (opts.paramsSchema) {
      const parseResult = opts.paramsSchema.safeParse(rawParams);
      if (!parseResult.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            type: 'ValidationError',
            site: opts.siteName,
            message: `Invalid parameters: ${parseResult.error.message}`,
            issues: parseResult.error.issues,
          }) }],
          isError: true,
        };
      }
      parsedParams = parseResult.data as Record<string, unknown>;
    }

    const trace = new Trace(opts.toolName);

    try {
      const result = await runtime.mutex.run(async () => {
        // Action workflows: dailyLimitCheck + execute + logAction all inside mutex
        if (opts.actionOpts) {
          const { getDailyActionCount, logAction } = await import('../storage/action-log.js');
          const { getConfig, getKnowledgeDbPath } = await import('../config.js');
          const { initializeDatabase } = await import('../storage/schema.js');
          const cfg = getConfig();
          const dbPath = getKnowledgeDbPath(cfg.dataDir);
          const db = initializeDatabase(dbPath);
          try {
            // 1. Daily limit check
            if (opts.actionOpts.dailyLimit) {
              const key = opts.actionOpts.dailyLimitKey ?? opts.toolName;
              const actions = key.includes(',') ? key.split(',') : [key];
              const count = getDailyActionCount(db, opts.siteName, actions);
              if (count >= opts.actionOpts.dailyLimit) {
                throw new DailyLimitExceeded(
                  `Daily limit reached: ${count}/${opts.actionOpts.dailyLimit} today`,
                  { diagnostics: { used: count, limit: opts.actionOpts.dailyLimit } },
                );
              }
            }
            // 2. Execute handler
            const actionResult = await trace.span('handler', async () => {
              return await opts.handler(rawParams, runtime, trace);
            });
            // 3. Log action (same DB, same mutex)
            // Skip logging for idempotent no-ops (previousState === resultState)
            // to avoid consuming daily quota on repeated safe calls.
            try {
              const r = actionResult as Record<string, unknown>;
              const isNoop = r.previousState !== undefined && r.previousState === r.resultState;
              if (!isNoop) {
                logAction(db, {
                  site: opts.siteName,
                  action: String(r.action ?? opts.toolName),
                  target: String(r.target ?? r.handle ?? ''),
                  success: true,
                  prevState: r.previousState as string | undefined,
                  resultState: r.resultState as string | undefined,
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (logErr) {
              console.warn(`[site-use] action log failed: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
            }
            return actionResult;
          } finally {
            db.close();
          }
        }
        // Collection workflows: existing behavior unchanged
        return await trace.span('handler', async () => {
          return await opts.handler(rawParams, runtime, trace);
        });
      });

      if (opts.resultSchema) {
        const resultParse = opts.resultSchema.safeParse(result);
        if (!resultParse.success) {
          throw new SiteUseError('PluginError',
            `Plugin "${opts.siteName}" returned invalid result: ${resultParse.error.message}`,
            { retryable: false },
          );
        }
      }

      if (opts.autoIngest) {
        const feedResult = result as { items?: unknown[] };
        if (feedResult.items && feedResult.items.length > 0) {
          try {
            const { createStore } = await import('../storage/index.js');
            const { getConfig, getKnowledgeDbPath } = await import('../config.js');
            const cfg = getConfig();
            const dbPath = getKnowledgeDbPath(cfg.dataDir);
            const store = createStore(dbPath);
            const ingestItems = opts.autoIngest.storeAdapter
              .toIngestItems(feedResult.items, parsedParams)
              .map((item: any) => ({ ...item, site: opts.autoIngest!.siteName }));
            z.array(IngestItemSchema).parse(ingestItems);
            await store.ingest(ingestItems);
          } catch (err) {
            console.warn(
              `[site-use] autoIngest failed for ${opts.siteName}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      runtime.circuitBreaker.recordSuccess();
      if ((rawParams as Record<string, unknown>).debug) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ result, trace: trace.toJSON() }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const errorResult = await formatError(opts.siteName, err as Error, runtime, opts.onBrowserDisconnected, trace.toJSON());

      // Screenshot as MCP image content block
      try {
        if (!(err instanceof BrowserDisconnected) && runtime?.primitives?.screenshot) {
          const screenshot = await runtime.primitives.screenshot();
          errorResult.content.push({ type: 'image' as const, data: screenshot, mimeType: 'image/png' });
        }
      } catch {
        // Screenshot failed — skip, don't cause secondary failure
      }

      return errorResult;
    }
  };
}

async function formatError(
  siteName: string,
  err: Error,
  runtime: SiteRuntime | undefined,
  onBrowserDisconnected?: () => void,
  trace?: TraceData,
): Promise<ToolResult> {
  if (err instanceof SiteUseError) {
    if (err instanceof BrowserDisconnected && onBrowserDisconnected) {
      onBrowserDisconnected();
    }

    const context = { ...err.context, site: siteName };

    const pluginHints = runtime?.plugin.hints;
    const hint = resolveHint(pluginHints as Record<string, string> | undefined, err.type, siteName);
    if (hint) context.hint = hint;

    if (runtime && !(err instanceof BrowserDisconnected) && !(err instanceof RateLimited)) {
      runtime.circuitBreaker.recordError();
    }

    const payload: Record<string, unknown> = {
      type: err.type,
      message: err.message,
      site: siteName,
      context,
    };
    if (trace) payload.trace = trace;

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      isError: true,
    };
  }

  if (runtime) runtime.circuitBreaker.recordError();
  const payload: Record<string, unknown> = {
    type: 'PluginError',
    message: `Plugin "${siteName}" threw an unexpected error: ${err.message}`,
    site: siteName,
    context: { originalError: err.message, retryable: false },
  };
  if (trace) payload.trace = trace;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}
