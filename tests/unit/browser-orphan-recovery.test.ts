import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  profileLockPid,
  snapshotDevToolsPort,
  listeningPortsForPid,
} from '../../packages/runtime/src/browser-lifecycle.js';

describe('profileLockPid', () => {
  const tmpDir = path.join(os.tmpdir(), 'site-use-profile-lock-test-' + process.pid);

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when the profile holds no lock', () => {
    expect(profileLockPid(tmpDir)).toBeUndefined();
  });

  // macOS/Linux Chrome writes SingletonLock as a symlink named `<hostname>-<pid>`.
  // Looking only for `lockfile` (the Windows name) made orphan recovery impossible here.
  it('reads the pid out of a macOS SingletonLock symlink', () => {
    fs.symlinkSync(`bogon-${process.pid}`, path.join(tmpDir, 'SingletonLock'));
    expect(profileLockPid(tmpDir)).toBe(process.pid);
  });

  it('handles hostnames containing dashes', () => {
    fs.symlinkSync(`my-host-name-${process.pid}`, path.join(tmpDir, 'SingletonLock'));
    expect(profileLockPid(tmpDir)).toBe(process.pid);
  });

  it('ignores a SingletonLock whose owner is gone', () => {
    fs.symlinkSync('bogon-99999999', path.join(tmpDir, 'SingletonLock'));
    expect(profileLockPid(tmpDir)).toBeUndefined();
  });

  it('still recognizes a plain lockfile', () => {
    fs.writeFileSync(path.join(tmpDir, 'lockfile'), '');
    expect(profileLockPid(tmpDir)).toBe(0);
  });
});

describe('snapshotDevToolsPort', () => {
  const tmpDir = path.join(os.tmpdir(), 'site-use-dtap-test-' + process.pid);
  const dtap = () => path.join(tmpDir, 'DevToolsActivePort');

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // A launch attempt that dies against the profile's singleton lock used to leave the
  // running Chrome's DevToolsActivePort deleted, so orphan recovery could never find it again.
  it('restores the previous file when the launch attempt fails', () => {
    fs.writeFileSync(dtap(), '61526\n/devtools/browser/abc\n');

    const snapshot = snapshotDevToolsPort(tmpDir);
    expect(fs.existsSync(dtap())).toBe(false);

    snapshot.restore();
    expect(fs.readFileSync(dtap(), 'utf-8')).toBe('61526\n/devtools/browser/abc\n');
  });

  it('does not resurrect the old file once the new Chrome wrote its own', () => {
    fs.writeFileSync(dtap(), '61526\n/devtools/browser/old\n');

    const snapshot = snapshotDevToolsPort(tmpDir);
    fs.writeFileSync(dtap(), '9333\n/devtools/browser/new\n');

    snapshot.restore();
    expect(fs.readFileSync(dtap(), 'utf-8')).toBe('9333\n/devtools/browser/new\n');
  });

  it('is a no-op when there was nothing to preserve', () => {
    const snapshot = snapshotDevToolsPort(tmpDir);
    snapshot.restore();
    expect(fs.existsSync(dtap())).toBe(false);
  });
});

describe('listeningPortsForPid', () => {
  let server: net.Server;
  let port: number;

  beforeEach(async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Last-resort discovery when DevToolsActivePort is gone: ask the OS which ports the
  // process holding the profile is listening on, then probe them for a CDP endpoint.
  it('finds a port the given process is listening on', async () => {
    const ports = await listeningPortsForPid(process.pid);
    expect(ports).toContain(port);
  });

  it('returns nothing for a process that does not exist', async () => {
    expect(await listeningPortsForPid(99999999)).toEqual([]);
  });
});
