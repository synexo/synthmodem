'use strict';

const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const COLORS = {
  error: '\x1b[31m',  // red
  warn:  '\x1b[33m',  // yellow
  info:  '\x1b[36m',  // cyan
  debug: '\x1b[37m',  // white
  trace: '\x1b[90m',  // grey
  reset: '\x1b[0m',
};

const configuredLevel = LEVELS[config.logging.level] ?? LEVELS.info;

function timestamp() {
  switch (config.logging.timestampFormat) {
    case 'unix':     return Date.now().toString();
    case 'relative': return (process.uptime() * 1000 | 0) + 'ms';
    default:         return new Date().toISOString();
  }
}

function log(level, component, message, extra) {
  if (LEVELS[level] > configuredLevel) return;
  const ts  = timestamp();
  const col = config.logging.colorize ? (COLORS[level] || '') : '';
  const rst = config.logging.colorize ? COLORS.reset : '';
  const tag = `[${ts}] [${level.toUpperCase().padEnd(5)}] [${component}]`;
  const line = extra !== undefined
    ? `${col}${tag} ${message}${rst} ${JSON.stringify(extra)}`
    : `${col}${tag} ${message}${rst}`;
  process.stdout.write(line + '\n');
}

function makeLogger(component) {
  return {
    error: (msg, extra) => log('error', component, msg, extra),
    warn:  (msg, extra) => log('warn',  component, msg, extra),
    info:  (msg, extra) => log('info',  component, msg, extra),
    debug: (msg, extra) => log('debug', component, msg, extra),
    trace: (msg, extra) => log('trace', component, msg, extra),
  };
}

module.exports = { makeLogger };
