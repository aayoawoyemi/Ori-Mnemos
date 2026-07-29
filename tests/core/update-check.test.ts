import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getUpdateCachePath,
  readCache,
  writeCache,
  compareVersions,
} from '../../src/core/update-check.js';

let tempDir: string;

beforeEach(async () => {
  // Create a temporary directory for the cache tests
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ori-test-'));
  process.env.ORI_UPDATE_CACHE_DIR = tempDir;
});

afterEach(async () => {
  delete process.env.ORI_UPDATE_CACHE_DIR;
  // Clean up temporary directory
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('getUpdateCachePath', () => {
  it('honors ORI_UPDATE_CACHE_DIR override', () => {
    const cachePath = getUpdateCachePath();
    expect(cachePath.startsWith(tempDir)).toBeTruthy();
    expect(path.basename(cachePath)).toBe('update-cache.json');
  });

  it('never contains the old ~/.ori/ collision path', () => {
    const cachePath = getUpdateCachePath();
    const collision = path.join(os.homedir(), '.ori', 'update-cache.json');
    expect(cachePath.includes('.ori')).toBeFalsy();
    expect(cachePath).not.toEqual(collision);
  });
});

describe('compareVersions', () => {
  it('returns true when latest is newer', () => {
    expect(compareVersions('1.2.3', '2.0.0')).toBe(true);
  });

  it('returns false when latest is equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns false when latest is older', () => {
    expect(compareVersions('2.0.0', '1.2.3')).toBe(false);
  });

  it('is conservative with prerelease strings (never nags on unparseable versions)', () => {
    // compareVersions only understands plain x.y.z; NaN comparisons are false,
    // so prerelease strings never trigger an update banner in either direction.
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(false);
    expect(compareVersions('1.2.3', '1.2.3-beta')).toBe(false);
  });
});

describe('cache read/write roundtrip', () => {
  it('writes and reads back the same data', async () => {
    const latest = '9.9.9';
    await writeCache(latest);

    const cached = await readCache();
    expect(cached).not.toBeNull();
    expect(cached?.latest).toBe(latest);
    expect(Date.now() - cached!.checkedAt).toBeLessThan(1000);
  });
});