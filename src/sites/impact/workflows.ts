import { readFileSync } from 'node:fs';
import type { Primitives } from '../../primitives/types.js';
import type { Trace } from '../../trace.js';
import { NOOP_TRACE } from '../../trace.js';
import { parseProposalTemplate } from './proposal-template.js';
import { searchKeyword, countCards, scrollForMore } from './navigate.js';
import { extractVisibleCards, resolveCardIndex, hoverCard, clickSendProposal, isAlreadySent } from './card-iterator.js';
import {
  waitForIframeForm, fillTemplateTerm, ensureStartDate,
  fillPartnerGroup, fillMessage, clickSubmit, clickConfirm,
  waitForSuccess, closeDialog,
} from './form-filler.js';
import type {
  SendProposalParams, ProposalResult, BatchProposalResult,
  ProposalTemplate, SubstitutionContext,
} from './types.js';

const CIRCUIT_BREAKER_LIMIT = 5;

/**
 * Parse keywords from file (one per line, # comments, blank lines ignored).
 */
function parseKeywordsFile(filePath: string): string[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

/**
 * Load the resume set: partner IDs already successfully sent.
 */
async function loadResumeSet(): Promise<Set<string>> {
  try {
    const { getConfig, getKnowledgeDbPath } = await import('../../config.js');
    const { initializeDatabase } = await import('../../storage/schema.js');
    const cfg = getConfig();
    const dbPath = getKnowledgeDbPath(cfg.dataDir);
    const db = initializeDatabase(dbPath);
    try {
      const stmt = db.prepare(`
        SELECT target FROM action_log
        WHERE site = 'impact' AND action = 'send-proposal-card' AND success = 1
      `);
      const rows = stmt.all() as { target: string }[];
      return new Set(rows.map(r => r.target));
    } finally {
      db.close();
    }
  } catch {
    return new Set();
  }
}

/**
 * Write a per-card action_log entry.
 */
async function logCardAction(
  partnerId: string,
  success: boolean,
  resultState: string,
): Promise<void> {
  try {
    const { logAction } = await import('../../storage/action-log.js');
    const { getConfig, getKnowledgeDbPath } = await import('../../config.js');
    const { initializeDatabase } = await import('../../storage/schema.js');
    const cfg = getConfig();
    const dbPath = getKnowledgeDbPath(cfg.dataDir);
    const db = initializeDatabase(dbPath);
    try {
      logAction(db, {
        site: 'impact',
        action: 'send-proposal-card',
        target: partnerId,
        success,
        prevState: 'not-sent',
        resultState,
        timestamp: new Date().toISOString(),
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[site-use] impact: action log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Process a single card: hover → open dialog → fill form → submit → confirm.
 */
async function processCard(
  primitives: Primitives,
  card: { partnerName: string; partnerId: string },
  template: ProposalTemplate,
  keyword: string,
  dryRun: boolean,
): Promise<ProposalResult> {
  const ctx: SubstitutionContext = {
    partnerName: card.partnerName,
    partnerId: card.partnerId,
    keyword,
  };

  // Resolve fresh DOM index — cards may shift after previous sends (spec §2.8)
  const cardIndex = await resolveCardIndex(primitives, card.partnerId);
  if (cardIndex < 0) {
    throw new Error(`Card for partner ${card.partnerId} no longer in DOM`);
  }

  // Hover → click Send Proposal
  await hoverCard(primitives, cardIndex);
  await clickSendProposal(primitives, cardIndex);

  // Wait for iframe form
  const formLoaded = await waitForIframeForm(primitives);
  if (!formLoaded) {
    throw new Error('Iframe form did not load within timeout');
  }

  // Fill fields
  await fillTemplateTerm(primitives, template.templateTerm);
  await ensureStartDate(primitives);
  await fillPartnerGroup(primitives, template.partnerGroup);
  await fillMessage(primitives, template.message, ctx);

  // Dry run: record and close
  if (dryRun) {
    await closeDialog(primitives);
    return {
      partnerName: card.partnerName,
      partnerId: card.partnerId,
      keyword,
      success: true,
      skipped: true,
      skipReason: 'dry-run',
      timestamp: new Date().toISOString(),
    };
  }

  // Submit → confirm → wait for success
  await clickSubmit(primitives);
  await clickConfirm(primitives);
  const success = await waitForSuccess(primitives);

  if (!success) {
    throw new Error('Iframe still present after submit — proposal may not have been sent');
  }

  return {
    partnerName: card.partnerName,
    partnerId: card.partnerId,
    keyword,
    success: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Main send-proposal workflow.
 */
export async function sendProposal(
  primitives: Primitives,
  params: SendProposalParams,
  trace: Trace = NOOP_TRACE,
): Promise<BatchProposalResult> {
  // 1. Parse inputs
  const keywords = params.keywordsFile
    ? parseKeywordsFile(params.keywordsFile)
    : [params.keyword!];

  const templateYaml = readFileSync(params.proposalFile, 'utf8');
  const template = parseProposalTemplate(templateYaml);

  // 2. Load resume set
  const resumeSet = await loadResumeSet();

  const results: ProposalResult[] = [];
  let totalCards = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let anyCircuitBreaker = false;
  let allCircuitBreaker = true;

  for (let ki = 0; ki < keywords.length; ki++) {
    const keyword = keywords[ki];
    console.error(`[site-use] impact: [keyword ${ki + 1}/${keywords.length}] "${keyword}" — searching...`);

    // 3. Search
    await searchKeyword(primitives, keyword);
    const initialCardCount = await countCards(primitives);
    console.error(`[site-use] impact: [keyword ${ki + 1}/${keywords.length}] ${initialCardCount} cards found`);

    let consecutiveFailures = 0;
    let cardCount = 0;
    const processedIds = new Set<string>();
    let keywordBroken = false;

    // Card iteration loop
    while (cardCount < params.maxPerKeyword) {
      const cards = await extractVisibleCards(primitives);
      let processedAny = false;

      for (const card of cards) {
        if (cardCount >= params.maxPerKeyword) break;
        if (processedIds.has(card.partnerId)) continue;
        processedIds.add(card.partnerId);
        totalCards++;

        // Skip checks
        if (resumeSet.has(card.partnerId)) {
          console.error(`[site-use] impact: [${cardCount + 1}] ${card.partnerName} — already sent, skipping`);
          results.push({
            partnerName: card.partnerName,
            partnerId: card.partnerId,
            keyword,
            success: true,
            skipped: true,
            skipReason: 'already-sent',
            timestamp: new Date().toISOString(),
          });
          skipped++;
          cardCount++;
          processedAny = true;
          continue;
        }

        // Resolve fresh DOM index — cards may shift after sends (spec §2.8)
        const freshIdx = await resolveCardIndex(primitives, card.partnerId);
        if (freshIdx < 0) {
          // Card disappeared from DOM (likely already processed), skip
          cardCount++;
          processedAny = true;
          continue;
        }
        const uiSent = await isAlreadySent(primitives, freshIdx);
        if (uiSent) {
          console.error(`[site-use] impact: [${cardCount + 1}] ${card.partnerName} — UI indicator, skipping`);
          results.push({
            partnerName: card.partnerName,
            partnerId: card.partnerId,
            keyword,
            success: true,
            skipped: true,
            skipReason: 'ui-indicator',
            timestamp: new Date().toISOString(),
          });
          skipped++;
          cardCount++;
          processedAny = true;
          continue;
        }

        // Process card
        console.error(`[site-use] impact: [${cardCount + 1}] ${card.partnerName} — sending...`);
        try {
          const result = await processCard(primitives, card, template, keyword, params.dryRun);
          results.push(result);
          if (result.skipped) {
            skipped++;
          } else {
            sent++;
            await logCardAction(card.partnerId, true, 'sent');
            resumeSet.add(card.partnerId);
          }
          consecutiveFailures = 0;
          console.error(`[site-use] impact: [${cardCount + 1}] ${card.partnerName} — ${result.skipped ? 'dry-run' : 'sent'}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[site-use] impact: [${cardCount + 1}] ${card.partnerName} — failed: ${errMsg}`);
          results.push({
            partnerName: card.partnerName,
            partnerId: card.partnerId,
            keyword,
            success: false,
            error: errMsg,
            timestamp: new Date().toISOString(),
          });
          failed++;
          await logCardAction(card.partnerId, false, 'failed');
          consecutiveFailures++;

          // Try to close dialog on error
          try { await closeDialog(primitives); } catch {}

          // Circuit breaker: per-keyword counter
          if (consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
            console.error(`[site-use] impact: circuit breaker tripped for "${keyword}" (${CIRCUIT_BREAKER_LIMIT} consecutive failures)`);
            anyCircuitBreaker = true;
            keywordBroken = true;
            break;
          }
        }

        cardCount++;
        processedAny = true;

        // Extra delay between cards
        if (params.delay > 0) {
          await new Promise(r => setTimeout(r, params.delay * 1000));
        }
      }

      if (keywordBroken) break;

      // Scroll for more cards
      if (!processedAny || cardCount >= params.maxPerKeyword) break;
      const hasMore = await scrollForMore(primitives);
      if (!hasMore) break;
    }

    if (!keywordBroken) allCircuitBreaker = false;

    console.error(
      `[site-use] impact: [keyword ${ki + 1}/${keywords.length}] "${keyword}" done: ` +
      `${sent} sent, ${skipped} skipped, ${failed} failed`,
    );
  }

  // Determine result state
  let resultState: 'completed' | 'partial' | 'failed';
  if (allCircuitBreaker && keywords.length > 0) {
    resultState = 'failed';
  } else if (anyCircuitBreaker) {
    resultState = 'partial';
  } else {
    resultState = 'completed';
  }

  return {
    action: 'send-proposal-batch',
    target: `${keywords.length} keywords, ${totalCards} cards`,
    summary: { totalKeywords: keywords.length, totalCards, sent, skipped, failed },
    results,
    previousState: 'pending',
    resultState,
  };
}
