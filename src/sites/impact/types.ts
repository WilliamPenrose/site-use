import { z } from 'zod';

// ── Proposal template (YAML file) ────────────────────────────

export const ProposalTemplateSchema = z.object({
  templateTerm: z.string().min(1).describe('Dropdown option name for Template Term'),
  partnerGroup: z.string().optional().describe('Tag input value for Partner Groups'),
  message: z.string().min(1).describe('Message body (supports {partnerName} {partnerId} {keyword})'),
});

export type ProposalTemplate = z.infer<typeof ProposalTemplateSchema>;

// ── Workflow params (CLI args) ───────────────────────────────

export const SendProposalParamsSchema = z.object({
  keyword: z.string().min(1).optional()
    .describe('Single search keyword'),
  keywordsFile: z.string().optional()
    .describe('Path to keywords file (one keyword per line)'),
  proposalFile: z.string().min(1)
    .describe('Path to proposal template YAML file'),
  maxPerKeyword: z.number().min(1).max(500).default(50)
    .describe('Max proposals to send per keyword'),
  delay: z.number().min(0).default(0)
    .describe('Extra wait between cards (seconds)'),
  dryRun: z.boolean().default(false)
    .describe('Preview mode: fill form but do not submit'),
  debug: z.boolean().default(false)
    .describe('Include diagnostic info'),
}).refine(
  d => d.keyword || d.keywordsFile,
  { message: 'Either --keyword or --keywords-file is required' },
).refine(
  d => !(d.keyword && d.keywordsFile),
  { message: '--keyword and --keywords-file are mutually exclusive' },
);

export type SendProposalParams = z.infer<typeof SendProposalParamsSchema>;

// ── Result types ─────────────────────────────────────────────

export interface ProposalResult {
  partnerName: string;
  partnerId: string;
  keyword: string;
  success: boolean;
  error?: string;
  skipped?: boolean;
  skipReason?: 'already-sent' | 'dry-run' | 'ui-indicator';
  timestamp: string;
}

export interface BatchProposalResult {
  action: 'send-proposal-batch';
  target: string;
  summary: {
    totalKeywords: number;
    totalCards: number;
    sent: number;
    skipped: number;
    failed: number;
  };
  results: ProposalResult[];
  previousState: 'pending';
  resultState: 'completed' | 'partial' | 'failed';
}

// ── Variable substitution context ────────────────────────────

export interface SubstitutionContext {
  partnerName: string;
  partnerId: string;
  keyword: string;
}
