import { appendFileSync, mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
const FILE = 'data/bot.log';

type Level = 'debug' | 'info' | 'warn' | 'error';
const quiet = process.env.SIG_LOG_LEVEL !== 'debug';

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  appendFileSync(FILE, JSON.stringify({ ts, level, msg, ...fields }) + '\n');
  if (level === 'debug' && quiet) return;
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  const line = `${ts.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => write('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => write('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => write('error', m, f),
};
