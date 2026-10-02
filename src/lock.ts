// One live bot per account. Two live bots each size against limits as if alone and cancel each
// other's quotes; on 2026-10-02 that took positions past every cap overnight.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const FILE = 'data/live.lock';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Returns the pid holding the lock, or null once this process holds it.
export function acquireLiveLock(file = FILE): number | null {
  try {
    const holder = Number(readFileSync(file, 'utf8'));
    if (holder && holder !== process.pid && alive(holder)) return holder;
  } catch {
    // no lock file yet
  }
  writeFileSync(file, String(process.pid));
  process.on('exit', () => {
    try {
      if (Number(readFileSync(file, 'utf8')) === process.pid) rmSync(file);
    } catch {
      // already gone
    }
  });
  return null;
}
