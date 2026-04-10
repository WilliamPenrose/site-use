import type { SitePlugin } from '../../registry/types.js';
import type { Primitives } from '../../primitives/types.js';
import type { Trace } from '../../trace.js';
import { checkLogin, isLoggedIn } from './site.js';
import { sendProposal } from './workflows.js';
import { SendProposalParamsSchema } from './types.js';
import type { SendProposalParams } from './types.js';

export const plugin: SitePlugin = {
  apiVersion: 1,
  name: 'impact',
  domains: ['app.impact.com'],

  auth: {
    check: checkLogin,
    guard: isLoggedIn,
    guardNavigate: true,
    description: 'Check if user is logged in to Impact.com. Returns { loggedIn: boolean }.',
  },

  workflows: [
    {
      kind: 'action' as const,
      name: 'send-proposal',
      description:
        'Batch send partnership proposals on impact.com. Searches keywords, ' +
        'iterates partner cards, fills proposal form from YAML template, and submits. ' +
        'Supports breakpoint resume — already-sent partners are automatically skipped.',
      params: SendProposalParamsSchema,
      execute: (primitives: Primitives, params: unknown, trace?: Trace) =>
        sendProposal(primitives, params as SendProposalParams, trace),
      dailyLimit: 10,
      dailyLimitKey: 'send-proposal-batch',
      expose: ['cli'],
      cli: {
        description: 'Batch send partnership proposals',
        help: `Options:
  --keyword <text>         Single search keyword
  --keywords-file <path>   Path to keywords file (one per line, # comments)
  --proposal-file <path>   Path to proposal template YAML (required)
  --max-per-keyword <n>    Max cards per keyword (1-500, default: 50)
  --delay <seconds>        Extra wait between cards (default: 0)
  --dry-run                Fill form but don't submit
  --debug                  Include diagnostic info`,
      },
    },
  ],

  hints: {
    sessionExpired:
      'Not logged in to Impact.com. Please log in manually in the Chrome window, then re-run.',
    elementNotFound:
      'Expected UI element not found on Impact.com. The page may not have loaded, or Impact may have updated their UI.',
  },
};
