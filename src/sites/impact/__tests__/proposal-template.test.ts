import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProposalTemplate, substituteVariables } from '../proposal-template.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('parseProposalTemplate', () => {
  it('parses valid YAML template', () => {
    const raw = readFileSync(join(FIXTURES, 'valid-proposal.yaml'), 'utf8');
    const template = parseProposalTemplate(raw);
    expect(template.templateTerm).toBe('public terms');
    expect(template.partnerGroup).toBe('Auto');
    expect(template.message).toContain('{partnerName}');
  });

  it('throws on missing required templateTerm', () => {
    const raw = readFileSync(join(FIXTURES, 'invalid-proposal.yaml'), 'utf8');
    expect(() => parseProposalTemplate(raw)).toThrow(/templateTerm/);
  });

  it('accepts template without optional partnerGroup', () => {
    const raw = 'templateTerm: "public terms"\nmessage: "Hello"';
    const template = parseProposalTemplate(raw);
    expect(template.partnerGroup).toBeUndefined();
  });
});

describe('substituteVariables', () => {
  it('replaces {partnerName}, {partnerId}, {keyword}', () => {
    const result = substituteVariables(
      'Hi {partnerName} ({partnerId}), found via {keyword}',
      { partnerName: 'Acme Corp', partnerId: '12345', keyword: 'fitness' },
    );
    expect(result).toBe('Hi Acme Corp (12345), found via fitness');
  });

  it('leaves unknown placeholders untouched', () => {
    const result = substituteVariables('{partnerName} {unknown}', {
      partnerName: 'Test',
      partnerId: '1',
      keyword: 'kw',
    });
    expect(result).toBe('Test {unknown}');
  });
});
