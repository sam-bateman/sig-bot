import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLiveLock } from '../src/lock.js';

const lockFile = () => join(mkdtempSync(join(tmpdir(), 'sig-lock-')), 'live.lock');

describe('acquireLiveLock', () => {
  it('takes a free lock and records our pid', () => {
    const f = lockFile();
    assert.equal(acquireLiveLock(f), null);
    assert.equal(Number(readFileSync(f, 'utf8')), process.pid);
  });

  it('refuses while another live process holds it', () => {
    const f = lockFile();
    writeFileSync(f, String(process.ppid)); // the test runner: certainly alive
    assert.equal(acquireLiveLock(f), process.ppid);
  });

  it('takes over a lock left by a dead process', () => {
    const f = lockFile();
    writeFileSync(f, '999999');
    assert.equal(acquireLiveLock(f), null);
    assert.equal(Number(readFileSync(f, 'utf8')), process.pid);
  });

  it('re-acquiring our own lock succeeds', () => {
    const f = lockFile();
    writeFileSync(f, String(process.pid));
    assert.equal(acquireLiveLock(f), null);
  });
});
