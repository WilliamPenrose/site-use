import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface ActionLogEntry {
  site: string;
  action: string;
  target: string;
  success: boolean;
  prevState?: string;
  resultState?: string;
  timestamp: string;
}

export function openActionLogDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      site         TEXT NOT NULL,
      action       TEXT NOT NULL,
      target       TEXT NOT NULL,
      success      INTEGER NOT NULL DEFAULT 1,
      prev_state   TEXT,
      result_state TEXT,
      timestamp    TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_action_log_daily ON action_log(site, action, timestamp)');
  return db;
}

export function logAction(db: DatabaseSync, entry: ActionLogEntry): void {
  const stmt = db.prepare(`
    INSERT INTO action_log (site, action, target, success, prev_state, result_state, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.site,
    entry.action,
    entry.target,
    entry.success ? 1 : 0,
    entry.prevState ?? null,
    entry.resultState ?? null,
    entry.timestamp,
  );
}

export function getDailyActionCount(
  db: DatabaseSync,
  site: string,
  actions: string[],
): number {
  const placeholders = actions.map(() => '?').join(', ');
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM action_log
    WHERE site = ?
      AND action IN (${placeholders})
      AND success = 1
      AND date(timestamp, 'localtime') = date('now', 'localtime')
  `);
  const row = stmt.get(site, ...actions) as { count: number };
  return row.count;
}
