import { z, type ZodType } from 'zod';
import type { SiteRuntime } from '../runtime/types.js';
import { SiteUseError, BrowserDisconnected, RateLimited } from '../errors.js';
import { resolveHint } from './default-descriptions.js';

const IngestItemSchema = z.object({
  site: z.string(), id: z.string(), text: z.string(), author: z.string(),
  timestamp: z.string(), url: z.string(), rawJson: z.string(),
  metrics: z.array(z.object({
    metric: z.string(), numValue: z.number().optional(),
    realValue: z.number().optional(), strValue: z.string().optional(),
  })).optional(),
  mentions: z.array(z.string()).optional(),
  hashtags: z.array(z.string()).optional(),
});

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

export interface WrapOptions {
  siteName: string;
  handler: (params: Record<string, unknown>, runtime: SiteRuntime) => Promise<unknown>;
  getRuntime: () => Promise<SiteRuntime>;
  paramsSchema?: ZodType;
  resultSchema?: ZodType;
  onBrowserDisconnected?: () => void;
  autoIngest?: {
    storeAdapter: { toIngestItems: (items: unknown[]) => unknown[] };
    siteName: string;
  };
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
    }

    try {
      const result = await runtime.mutex.run(async () => {
        return await opts.handler(rawParams, runtime);
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
          const { getStore } = await import('../storage/index.js');
          const store = getStore();
          const ingestItems = opts.autoIngest.storeAdapter
            .toIngestItems(feedResult.items)
            .map((item: Record<string, unknown>) => ({ ...item, site: opts.autoIngest!.siteName }));
          z.array(IngestItemSchema).parse(ingestItems);
          await store.ingest(ingestItems);
        }
      }

      runtime.circuitBreaker.recordSuccess();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      return formatError(opts.siteName, err as Error, runtime, opts.onBrowserDisconnected);
    }
  };
}

async function formatError(
  siteName: string,
  err: Error,
  runtime: SiteRuntime | undefined,
  onBrowserDisconnected?: () => void,
): Promise<ToolResult> {
  if (err instanceof SiteUseError) {
    if (err instanceof BrowserDisconnected && onBrowserDisconnected) {
      onBrowserDisconnected();
    }

    const context = { ...err.context, site: siteName };

    const pluginHints = runtime?.plugin.hints;
    const hint = resolveHint(pluginHints as Record<string, string> | undefined, err.type, siteName);
    if (hint) context.hint = hint;

    if (!(err instanceof BrowserDisconnected) && runtime) {
      try {
        context.screenshotBase64 = await runtime.primitives.screenshot();
      } catch {
        // screenshot failed, skip
      }
    }

    if (runtime && !(err instanceof BrowserDisconnected) && !(err instanceof RateLimited)) {
      runtime.circuitBreaker.recordError();
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        type: err.type,
        message: err.message,
        site: siteName,
        context,
      }) }],
      isError: true,
    };
  }

  if (runtime) runtime.circuitBreaker.recordError();
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({
      type: 'PluginError',
      message: `Plugin "${siteName}" threw an unexpected error: ${err.message}`,
      site: siteName,
      context: { originalError: err.message, retryable: false },
    }) }],
    isError: true,
  };
}
