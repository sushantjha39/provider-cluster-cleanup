'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const LOG_DIR = path.join(ROOT, 'logs');

/**
 * Append-only record of every destructive action. Deletes here are not
 * recoverable from the tool, so the audit trail is the only way to answer
 * "what did I remove last Tuesday".
 */
function record(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `audit-${day}.jsonl`);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(file, line + '\n', 'utf8');
  return file;
}

module.exports = { record, LOG_DIR };
