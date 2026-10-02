import { config } from './config.js';
import { Engine } from './engine.js';
import { acquireLiveLock } from './lock.js';
import { log } from './log.js';

if (config.live) {
  const holder = acquireLiveLock();
  if (holder !== null) {
    log.error('another live bot is already running; refusing to start', { pid: holder });
    process.exit(1);
  }
  log.warn('LIVE mode: orders will be placed');
} else log.info('dry-run: no orders will be placed (pass --live to trade)');

const engine = new Engine();
await engine.init();
await engine.run();
