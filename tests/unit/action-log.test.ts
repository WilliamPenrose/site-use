import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openActionLogDb, logAction, getDailyActionCount } from '../../src/action-log/index.js';
import type { DatabaseSync } from 'node:sqlite';

describe('action-log (standalone)', () => {
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `site-use-action-log-test-${Date.now()}.db`);
    db = openActionLogDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it('logs an action and retrieves daily count', () => {
    logAction(db, {
      site: 'twitter',
      action: 'follow',
      target: 'elonmusk',
      success: true,
      prevState: 'not_following',
      resultState: 'following',
      timestamp: new Date().toISOString(),
    });

    const count = getDailyActionCount(db, 'twitter', ['follow', 'unfollow']);
    expect(count).toBe(1);
  });

  it('counts only successful actions', () => {
    const now = new Date().toISOString();
    logAction(db, {
      site: 'twitter', action: 'follow', target: 'user1',
      success: true, timestamp: now,
    });
    logAction(db, {
      site: 'twitter', action: 'follow', target: 'user2',
      success: false, timestamp: now,
    });

    const count = getDailyActionCount(db, 'twitter', ['follow', 'unfollow']);
    expect(count).toBe(1);
  });

  it('does not count actions from other days', () => {
    logAction(db, {
      site: 'twitter', action: 'follow', target: 'user1',
      success: true, timestamp: '2020-01-01T00:00:00.000Z',
    });

    const count = getDailyActionCount(db, 'twitter', ['follow', 'unfollow']);
    expect(count).toBe(0);
  });

  it('does not count actions from other sites', () => {
    logAction(db, {
      site: 'reddit', action: 'follow', target: 'user1',
      success: true, timestamp: new Date().toISOString(),
    });

    const count = getDailyActionCount(db, 'twitter', ['follow', 'unfollow']);
    expect(count).toBe(0);
  });

  it('counts multiple action types when specified', () => {
    const now = new Date().toISOString();
    logAction(db, {
      site: 'twitter', action: 'follow', target: 'user1',
      success: true, timestamp: now,
    });
    logAction(db, {
      site: 'twitter', action: 'unfollow', target: 'user2',
      success: true, timestamp: now,
    });

    const count = getDailyActionCount(db, 'twitter', ['follow', 'unfollow']);
    expect(count).toBe(2);
  });

  it('counts actions near midnight boundary correctly', () => {
    const now = new Date();
    const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1);
    logAction(db, {
      site: 'twitter', action: 'follow', target: 'user1',
      success: true, timestamp: todayLocal.toISOString(),
    });

    const count = getDailyActionCount(db, 'twitter', ['follow']);
    expect(count).toBe(1);
  });

  it('allows multiple logs for the same target', () => {
    const now = new Date().toISOString();
    logAction(db, {
      site: 'twitter', action: 'follow', target: 'user1',
      success: true, timestamp: now,
    });
    logAction(db, {
      site: 'twitter', action: 'unfollow', target: 'user1',
      success: true, timestamp: now,
    });

    const count = getDailyActionCount(db, 'twitter', ['follow', 'unfollow']);
    expect(count).toBe(2);
  });

  it('openActionLogDb is idempotent (can be called twice on same path)', () => {
    db.close();
    const db2 = openActionLogDb(dbPath);
    logAction(db2, {
      site: 'twitter', action: 'follow', target: 'user1',
      success: true, timestamp: new Date().toISOString(),
    });
    expect(getDailyActionCount(db2, 'twitter', ['follow'])).toBe(1);
    db = db2; // so afterEach closes it
  });
});
