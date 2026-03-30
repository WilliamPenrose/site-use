// src/registry/default-descriptions.ts

/** Default MCP tool descriptions for standard capabilities. */
export const DEFAULT_TOOL_DESCRIPTIONS: Record<string, (site: string) => string> = {
  auth: (site) => `Check if user is logged in to ${site}`,
};

/** Default error hints, with {site} placeholder. */
export const DEFAULT_HINTS: Record<string, string> = {
  sessionExpired:
    'User is not logged in to {site}. Ask the user to log in manually in the browser, then retry.',
  rateLimited:
    'Rate limited by {site}. Do not retry immediately. Wait or switch to a different task, then retry later.',
  elementNotFound:
    'Expected UI element not found on {site}. The page may not have loaded fully, or the site\'s UI may have changed. Try taking a screenshot to diagnose.',
  navigationFailed:
    'Failed to navigate on {site}. Check if the site is accessible and the URL is correct. Try taking a screenshot to see the current page state.',
  stateTransitionFailed:
    'Action did not produce the expected result on {site}. Take a screenshot to see current state, then decide whether to retry or try an alternative approach.',
};

/** Resolve a hint for a given site and error type. Plugin hints take priority. */
export function resolveHint(
  pluginHints: Record<string, string> | undefined,
  errorType: string,
  siteName: string,
): string | undefined {
  const key = errorType.charAt(0).toLowerCase() + errorType.slice(1);
  const pluginHint = pluginHints?.[key];
  if (pluginHint) return pluginHint;
  const defaultHint = DEFAULT_HINTS[key];
  if (defaultHint) return defaultHint.replace(/\{site\}/g, siteName);
  return undefined;
}
