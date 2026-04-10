import type { Primitives } from '../../primitives/types.js';

export const IMPACT_DISCOVERY_URL =
  'https://app.impact.com/secure/advertiser/discover/radius/fr/partner_discover.ihtml?page=marketplace&slideout_id_type=partner#businessModels=all&partnerStatuses=1&relationshipInclusions=prospecting&sortBy=reachRating&sortOrder=DESC';

export const impactSite = {
  name: 'impact',
  domains: ['app.impact.com'],
} as const;

/**
 * Full login check — navigates to discovery page, checks if redirected to login.
 */
export async function checkLogin(
  primitives: Primitives,
): Promise<{ loggedIn: boolean }> {
  await primitives.navigate(IMPACT_DISCOVERY_URL);
  const { loggedIn } = await isLoggedIn(primitives);
  return { loggedIn };
}

/**
 * Lightweight in-page auth guard. Does NOT navigate.
 * Polls for .accountSelectTrigger element (up to 5s).
 */
export async function isLoggedIn(
  primitives: Primitives,
): Promise<{ loggedIn: boolean; diagnostics?: unknown }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const title = await primitives.evaluate<string>('document.title');
    if (title.includes('Login')) {
      return { loggedIn: false, diagnostics: { reason: 'login_page', title } };
    }
    const hasAccount = await primitives.evaluate<boolean>(
      `!!document.querySelector('.accountSelectTrigger')`,
    );
    if (hasAccount) {
      return { loggedIn: true };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { loggedIn: false, diagnostics: { reason: 'timeout' } };
}
