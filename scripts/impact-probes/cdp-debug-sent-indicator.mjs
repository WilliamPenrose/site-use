#!/usr/bin/env node
/**
 * Debug: inspect cards that have been sent vs not sent
 * to identify the visual "sent" indicator in DOM
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { DatabaseSync } from 'node:sqlite';

// Load resume set to know which are truly sent
const db = new DatabaseSync(join(homedir(), '.site-use', 'data', 'knowledge.db'));
const rows = db.prepare('SELECT target FROM action_log WHERE site = ? AND action = ? AND success = 1').all('impact', 'send-proposal-card');
const resumeSet = new Set(rows.map(r => r.target));
db.close();

const { wsEndpoint } = JSON.parse(readFileSync(join(homedir(), '.site-use', 'chrome.json'), 'utf8'));
const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
const page = (await browser.pages()).find(p => p.url().includes('impact.com'));

// Dump full card structure for first 6 cards, comparing sent vs unsent
const cards = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.discovery-card')).slice(0, 8).map((card, i) => {
    const name = card.querySelector('.name .text-ellipsis')?.textContent?.trim() ?? '';
    const img = card.querySelector('img');
    const idMatch = (img?.src ?? '').match(/\/(\d+)$/);
    const partnerId = idMatch ? idMatch[1] : '';

    // Badge
    const badge = card.querySelector('.badge-container');
    const badgeHTML = badge?.innerHTML?.trim() ?? '';
    const badgeText = badge?.textContent?.trim() ?? '';

    // Check for any blue/green/check elements
    const svgs = card.querySelectorAll('svg');
    const svgInfo = Array.from(svgs).map(s => ({
      class: s.getAttribute('class') || '',
      viewBox: s.getAttribute('viewBox') || '',
      parent: s.parentElement?.className?.toString().slice(0, 40) || '',
      parentText: s.parentElement?.textContent?.trim().slice(0, 30) || '',
    }));

    // Check for relationship status indicators
    const allText = card.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? '';

    // Look for specific classes that might indicate sent status
    const statusElements = Array.from(card.querySelectorAll('[class*="status"], [class*="contract"], [class*="relation"], [class*="sent"], [class*="active"], [class*="check"], [class*="complete"]'));
    const statusInfo = statusElements.map(el => ({
      tag: el.tagName,
      class: el.className?.toString().slice(0, 60),
      text: el.textContent?.trim().slice(0, 40),
    }));

    // Check for the "Send Proposal" button existence
    const hasBtn = !!card.querySelector('button[data-testid="uicl-button"]');

    return { i, name, partnerId, badgeText, badgeHTML: badgeHTML.slice(0, 200), svgInfo, statusInfo, hasBtn, allText: allText.slice(0, 200) };
  });
});

for (const c of cards) {
  const isSent = resumeSet.has(c.partnerId);
  console.log(`\n═══ [${c.i}] ${isSent ? '✅ SENT' : '❌ NEW '} "${c.name}" (${c.partnerId}) ═══`);
  console.log(`  hasBtn: ${c.hasBtn}`);
  console.log(`  badge: "${c.badgeText}" (html: ${c.badgeHTML.slice(0, 100)})`);
  if (c.svgInfo.length) {
    console.log(`  SVGs:`);
    for (const s of c.svgInfo) console.log(`    class="${s.class}" parent="${s.parent}" text="${s.parentText}"`);
  }
  if (c.statusInfo.length) {
    console.log(`  Status elements:`);
    for (const s of c.statusInfo) console.log(`    <${s.tag} class="${s.class}"> "${s.text}"`);
  }
  console.log(`  Text: ${c.allText.slice(0, 150)}`);
}

browser.disconnect();
