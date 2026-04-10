import { parse as parseYaml } from 'yaml';
import { ProposalTemplateSchema, type ProposalTemplate, type SubstitutionContext } from './types.js';

/**
 * Parse and validate a YAML proposal template string.
 * Throws ZodError on invalid input (fail-fast at workflow startup).
 */
export function parseProposalTemplate(yamlString: string): ProposalTemplate {
  const raw = parseYaml(yamlString);
  return ProposalTemplateSchema.parse(raw);
}

/**
 * Replace {partnerName}, {partnerId}, {keyword} in a string.
 * Unknown placeholders are left untouched.
 */
export function substituteVariables(text: string, ctx: SubstitutionContext): string {
  return text
    .replace(/\{partnerName\}/g, ctx.partnerName)
    .replace(/\{partnerId\}/g, ctx.partnerId)
    .replace(/\{keyword\}/g, ctx.keyword);
}
