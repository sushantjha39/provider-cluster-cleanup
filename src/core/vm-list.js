'use strict';

/**
 * Parse a pasted VM list into delete targets.
 *
 * Accepts the same pipe format as the old delete45.sh array so the block can
 * be pasted verbatim — surrounding quotes, trailing commas, `#` comments and
 * blank lines are all tolerated:
 *
 *   "tn-zikwj3wzwu|default-project|148|68d87387-…|k8s-…-master1"
 *
 * Shorter forms fall back to the defaults supplied by the form/CLI flags:
 *
 *   <vmId>
 *   <vmId>|<name>
 *   <domain>|<project>|<projectId>|<vmId>
 *   <domain>|<project>|<projectId>|<vmId>|<name>
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanLine(raw) {
  let line = raw.trim();

  // Drop bash array scaffolding if the whole block was pasted.
  if (/^(VMS=\(|\)|declare\s)/.test(line)) return '';

  line = line.replace(/^[-*]\s+/, ''); // markdown bullets
  line = line.replace(/,\s*$/, ''); // trailing comma
  line = line.replace(/^["']|["']$/g, ''); // wrapping quotes
  line = line.trim();

  if (!line || line.startsWith('#') || line.startsWith('//')) return '';
  return line;
}

function parseVmList(text, defaults = {}) {
  const entries = [];
  const errors = [];

  const lines = String(text || '').split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = cleanLine(raw);
    if (!line) return;

    const parts = line.split('|').map((p) => p.trim());
    let entry;

    if (parts.length >= 4) {
      const [domain, project, projectId, id, name] = parts;
      entry = { domain, project, projectId, id, name: name || id };
    } else if (parts.length === 2) {
      entry = { ...defaults, id: parts[0], name: parts[1] || parts[0] };
    } else {
      // Bare id, possibly with the name after whitespace or a comma.
      const [id, ...rest] = line.split(/[\s,]+/);
      entry = { ...defaults, id, name: rest.join(' ') || id };
    }

    if (!entry.id) {
      errors.push({ line: index + 1, text: raw.trim(), reason: 'no VM id found' });
      return;
    }
    if (!UUID_RE.test(entry.id)) {
      errors.push({ line: index + 1, text: raw.trim(), reason: `"${entry.id}" is not a UUID` });
      return;
    }
    if (!entry.domain || !entry.project) {
      errors.push({
        line: index + 1,
        text: raw.trim(),
        reason: 'no domain/project on this line and none set above',
      });
      return;
    }

    entries.push(entry);
  });

  // Same VM listed twice would double-delete; keep the first.
  const seen = new Set();
  const unique = entries.filter((entry) => {
    const key = `${entry.domain}/${entry.project}/${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { entries: unique, errors, duplicates: entries.length - unique.length };
}

module.exports = { parseVmList, UUID_RE };
