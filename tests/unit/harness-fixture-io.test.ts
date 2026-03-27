import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadGoldenVariants,
  loadFixtureDir,
  saveCaptured,
  promoteFixture,
  goldenDir,
  harnessDataDir,
} from '../../src/harness/fixture-io.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadGoldenVariants', () => {
  it('reads golden file and returns array of entries with _variant field', () => {
    const dir = path.join(tmpDir, 'golden');
    fs.mkdirSync(dir, { recursive: true });
    const data = [
      { _variant: 'direct|original', tweet_results: {} },
      { _variant: 'direct|retweet', tweet_results: {} },
    ];
    fs.writeFileSync(path.join(dir, 'timeline-variants.json'), JSON.stringify(data));
    const result = loadGoldenVariants(dir, 'timeline');
    expect(result).toHaveLength(2);
    expect(result[0]._variant).toBe('direct|original');
  });

  it('returns empty array when golden file does not exist', () => {
    const result = loadGoldenVariants(path.join(tmpDir, 'nonexistent'), 'timeline');
    expect(result).toEqual([]);
  });
});

describe('saveCaptured', () => {
  it('writes a single entry to captured directory with domain prefix', () => {
    const capturedDir = path.join(tmpDir, 'captured');
    const entry = { _variant: 'direct|original', data: 'test' };
    const filePath = saveCaptured(capturedDir, 'timeline', entry);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(path.basename(filePath)).toMatch(/^timeline-/);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content._variant).toBe('direct|original');
  });
});

describe('loadFixtureDir', () => {
  it('loads all JSON files from a directory as { filePath, entry } pairs', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a.json'), JSON.stringify({ _variant: 'a' }));
    fs.writeFileSync(path.join(tmpDir, 'b.json'), JSON.stringify({ _variant: 'b' }));
    const result = loadFixtureDir(tmpDir);
    expect(result).toHaveLength(2);
    // Verify shape: each element has filePath (string) and entry (with _variant)
    for (const item of result) {
      expect(item).toHaveProperty('filePath');
      expect(item).toHaveProperty('entry');
      expect(typeof item.filePath).toBe('string');
      expect(item.filePath).toMatch(/\.json$/);
      expect(typeof item.entry._variant).toBe('string');
    }
  });

  it('returns empty array for nonexistent directory', () => {
    expect(loadFixtureDir(path.join(tmpDir, 'nope'))).toEqual([]);
  });
});

describe('promoteFixture', () => {
  it('appends new variant to golden when no matching variant exists', () => {
    const goldenDirPath = path.join(tmpDir, 'golden');
    fs.mkdirSync(goldenDirPath, { recursive: true });
    const goldenFile = path.join(goldenDirPath, 'timeline-variants.json');
    fs.writeFileSync(goldenFile, JSON.stringify([
      { _variant: 'direct|original', data: 'old' },
    ]));

    const sourceFile = path.join(tmpDir, 'timeline-2026-03-27-abc.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ _variant: 'direct|retweet', data: 'new' }));

    promoteFixture(goldenDirPath, sourceFile);

    const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf-8'));
    expect(golden).toHaveLength(2);
    expect(golden[1]._variant).toBe('direct|retweet');
    expect(fs.existsSync(sourceFile)).toBe(false);
  });

  it('replaces existing variant in golden when matching variant found', () => {
    const goldenDirPath = path.join(tmpDir, 'golden');
    fs.mkdirSync(goldenDirPath, { recursive: true });
    const goldenFile = path.join(goldenDirPath, 'timeline-variants.json');
    fs.writeFileSync(goldenFile, JSON.stringify([
      { _variant: 'direct|original', data: 'old' },
    ]));

    const sourceFile = path.join(tmpDir, 'timeline-2026-03-27-abc.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ _variant: 'direct|original', data: 'updated' }));

    promoteFixture(goldenDirPath, sourceFile);

    const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf-8'));
    expect(golden).toHaveLength(1);
    expect(golden[0].data).toBe('updated');
    expect(fs.existsSync(sourceFile)).toBe(false);
  });
});

describe('path helpers', () => {
  it('goldenDir returns correct path', () => {
    const p = goldenDir('twitter');
    expect(p).toContain('twitter');
    expect(p).toContain('golden');
  });

  it('harnessDataDir returns path under ~/.site-use/harness', () => {
    const p = harnessDataDir('twitter', 'captured');
    expect(p).toContain('harness');
    expect(p).toContain('twitter');
    expect(p).toContain('captured');
  });
});
