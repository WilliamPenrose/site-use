import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getPluginsConfig } from '../../src/config.js';

describe('getPluginsConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-use-cfg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty plugins array when config.json does not exist', () => {
    const result = getPluginsConfig(tmpDir);
    expect(result.plugins).toEqual([]);
  });

  it('reads plugins array from config.json', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: ['@site-use/plugin-reddit', './my-local-plugin'],
    }));
    const result = getPluginsConfig(tmpDir);
    expect(result.plugins).toEqual(['@site-use/plugin-reddit', './my-local-plugin']);
  });

  it('returns empty plugins array when config.json has no plugins field', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ someOther: true }));
    const result = getPluginsConfig(tmpDir);
    expect(result.plugins).toEqual([]);
  });

  it('throws on malformed JSON', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{ not valid json');
    expect(() => getPluginsConfig(tmpDir)).toThrow(/config\.json/i);
  });

  it('resolves relative plugin paths relative to config dir', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      plugins: ['./my-plugin', '@scope/pkg'],
    }));
    const result = getPluginsConfig(tmpDir);
    expect(result.resolvedPluginPaths).toEqual([
      path.join(tmpDir, 'my-plugin'),
      '@scope/pkg',
    ]);
  });
});
