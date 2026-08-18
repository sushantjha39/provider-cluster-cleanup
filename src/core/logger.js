'use strict';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const c = {
  dim: (s) => paint('2', s),
  red: (s) => paint('31', s),
  green: (s) => paint('32', s),
  yellow: (s) => paint('33', s),
  cyan: (s) => paint('36', s),
  bold: (s) => paint('1', s),
};

let verbose = false;

const log = {
  setVerbose: (v) => { verbose = !!v; },
  info: (...a) => console.log(...a),
  step: (...a) => console.log(c.cyan('›'), ...a),
  ok: (...a) => console.log(c.green('✓'), ...a),
  warn: (...a) => console.log(c.yellow('!'), ...a),
  error: (...a) => console.error(c.red('✗'), ...a),
  debug: (...a) => { if (verbose) console.log(c.dim('  ·'), ...a.map(String)); },
  blank: () => console.log(''),
  heading: (s) => console.log('\n' + c.bold(s)),
  rule: () => console.log(c.dim('─'.repeat(58))),
  c,
};

/** Render rows as an aligned table. columns: [{ key, label }] */
log.table = function table(rows, columns) {
  if (!rows.length) return;
  const widths = columns.map((col) =>
    Math.max(col.label.length, ...rows.map((r) => String(r[col.key] ?? '').length))
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

  console.log(c.dim(line(columns.map((col) => col.label))));
  for (const row of rows) console.log(line(columns.map((col) => row[col.key])));
};

module.exports = log;
