import type { Primitives } from '../../primitives/types.js';
import { SiteUseError, UserNotFound } from '../../errors.js';
import { NOOP_SPAN, type SpanHandle } from '../../trace.js';

const TWITTER_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const RESERVED_PATHS = new Set([
  'home', 'search', 'explore', 'i', 'settings', 'messages',
  'notifications', 'compose', 'hashtag', 'lists', 'bookmarks',
  'communities', 'premium', 'jobs', 'tos', 'privacy',
]);

export function normalizeHandle(handle: string): string {
  const h = handle.startsWith('@') ? handle.slice(1) : handle;
  if (!TWITTER_HANDLE_RE.test(h)) {
    throw new SiteUseError('InvalidParams', `Invalid Twitter handle: ${handle}`, { retryable: false });
  }
  return h;
}

export function handleFromUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/(?:x\.com|twitter\.com)\/([^/?#]+)/);
  if (!match) return null;
  const segment = match[1];
  if (RESERVED_PATHS.has(segment.toLowerCase())) return null;
  if (!TWITTER_HANDLE_RE.test(segment)) return null;
  return segment;
}

export function resolveHandle(params: { handle?: string; url?: string }): string {
  if (params.handle) return normalizeHandle(params.handle);
  if (params.url) {
    const h = handleFromUrl(params.url);
    if (h) return h;
    throw new SiteUseError('InvalidParams', `Cannot extract handle from URL: ${params.url}`, { retryable: false });
  }
  throw new SiteUseError('InvalidParams', 'Either handle or url is required', { retryable: false });
}

/**
 * Check if browser was redirected to Twitter login page.
 */
export async function checkLoginRedirect(
  primitives: Primitives,
  span: SpanHandle = NOOP_SPAN,
): Promise<void> {
  await span.span('checkLogin', async (s) => {
    const url = await primitives.evaluate<string>('window.location.href');
    s.set('currentUrl', url);
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page', {
        retryable: false,
      });
    }
  });
}

/**
 * Check for error pages via data-testid (locale-agnostic).
 * @param context — caller context for error step field (e.g. 'profile', 'follow')
 */
export async function checkProfileError(primitives: Primitives, handle: string, context: string = 'navigate'): Promise<void> {
  const errorType = await primitives.evaluate<string | null>(`(() => {
    if (document.querySelector('[data-testid="error-detail"]')) return 'errorDetail';
    if (document.querySelector('[data-testid="emptyState"]')) {
      const allBtns = document.querySelectorAll(
        'button[data-testid$="-follow"], button[data-testid$="-unfollow"], button[data-testid$="-cancel"]'
      );
      for (const btn of allBtns) {
        const ariaLabel = btn.getAttribute('aria-label') || '';
        const testid = btn.getAttribute('data-testid') || '';
        if (testid.endsWith('-cancel')) return null;
        if (ariaLabel.includes('@' + ${JSON.stringify(handle)})) return null;
      }
      if (document.querySelector('[data-testid="UserName"]')) return 'blocked';
      return 'emptyState';
    }
    return null;
  })()`);
  if (errorType === 'blocked') {
    throw new SiteUseError('Blocked', `You are blocked by @${handle}`, {
      retryable: false,
      step: `${context}: checking blocked status`,
    });
  }
  if (errorType === 'emptyState') {
    throw new UserNotFound(`User @${handle} does not exist or is suspended`, { step: `${context}: checking user exists` });
  }
  if (errorType === 'errorDetail') {
    throw new UserNotFound(`Profile page for @${handle} not found`, { step: `${context}: checking page exists` });
  }
}
