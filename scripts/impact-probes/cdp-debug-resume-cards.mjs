#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { DatabaseSync } from 'node:sqlite';

// Load resume set
const db = new DatabaseSync(join(homedir(), '.site-use', 'data', 'knowledge.db'));
const rows = db.prepare('SELECT target FROM action_log WHERE site = ? AND action = ? AND success = 1').all('impact', 'send-proposal-card');
const resumeSet = new Set(rows.map(r => r.target));
db.close();
console.log('Resume set:', [...resumeSet]);

// Connect
const { wsEndpoint } = JSON.parse(readFileSync(join(homedir(), '.site-use', 'chrome.json'), 'utf8'));
const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
const page = (await browser.pages()).find(p => p.url().includes('impact.com'));

const cards = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.discovery-card')).map((c, i) => {
    const name = c.querySelector('.name .text-ellipsis')?.textContent?.trim() ?? '';
    const img = c.querySelector('img');
    const idMatch = (img?.src ?? '').match(/\/(\d+)$/);
    const partnerId = idMatch ? idMatch[1] : '';
    const hasBtn = !!c.querySelector('button[data-testid="uicl-button"]');
    return { i, name, partnerId, hasBtn };
  }).filter(c => c.partnerId);
});

console.log(`\nVisible cards: ${cards.length}`);
let skipCount = 0;
for (const c of cards) {
  const inResume = resumeSet.has(c.partnerId);
  if (inResume) skipCount++;
  const marker = inResume ? '⏭ SKIP' : '  NEW ';
  console.log(`  [${c.i}] ${marker} ${c.name} (${c.partnerId}) btn=${c.hasBtn}`);
}
console.log(`\nSkippable: ${skipCount} / ${cards.length}`);

browser.disconnect();
