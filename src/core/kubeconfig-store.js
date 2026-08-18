'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT } = require('./config');
const kubeconfig = require('./kubeconfig');

/**
 * Holds kubeconfigs uploaded through the UI so kubectl can be pointed at them.
 * These files carry cluster credentials, so the directory is gitignored and
 * every file is written 0600. Nothing here is uploaded anywhere — it stays on
 * this machine for the lifetime of the tool.
 */
const STORE_DIR = path.join(ROOT, '.kubeconfigs');

function ensureDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
}

function pathFor(id) {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error(`Bad kubeconfig id: ${id}`);
  const file = path.join(STORE_DIR, `${id}.yaml`);
  if (!fs.existsSync(file)) throw new Error('That kubeconfig is no longer stored — re-upload it.');
  return file;
}

function save(text, label) {
  ensureDir();

  // Validate before storing so a bad paste fails loudly and early.
  const parsed = kubeconfig.parseText(text, label || '(uploaded)');

  // Same content, same id — re-uploading does not pile up duplicates.
  const id = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const file = path.join(STORE_DIR, `${id}.yaml`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.writeFileSync(
    path.join(STORE_DIR, `${id}.json`),
    JSON.stringify({
      id,
      label: label || parsed.clusterName,
      clusterName: parsed.clusterName,
      server: parsed.server,
      currentContext: parsed.currentContext,
      contexts: parsed.contextNames,
      savedAt: new Date().toISOString(),
    }),
    { mode: 0o600 }
  );

  return { id, file, ...parsed };
}

function list() {
  if (!fs.existsSync(STORE_DIR)) return [];
  return fs
    .readdirSync(STORE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

function remove(id) {
  const file = pathFor(id);
  fs.rmSync(file, { force: true });
  fs.rmSync(file.replace(/\.yaml$/, '.json'), { force: true });
}

/**
 * Turn whatever the client sent into a kubectl --kubeconfig path.
 * An empty id means "use the ambient default context".
 */
function resolve(id) {
  if (!id || id === 'default') return undefined;
  return pathFor(id);
}

module.exports = { save, list, remove, resolve, pathFor, STORE_DIR };
