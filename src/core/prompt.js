'use strict';

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const log = require('./logger');

/**
 * One reader for the whole process, driven by 'line' events rather than
 * rl.question(). question() stops resolving once a piped stdin reaches EOF,
 * which hangs the CLI mid-prompt; buffering lines ourselves behaves the same
 * whether input is a terminal or a pipe, so runs stay scriptable.
 */
let rl = null;
let ended = false;
const pending = []; // lines read but not yet consumed
const waiters = []; // resolvers waiting for a line

function reader() {
  if (rl) return rl;

  rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else pending.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiters.length) waiters.shift()(null);
  });
  return rl;
}

/** Resolves to the next line, or null once input is exhausted. */
function nextLine() {
  reader();
  if (pending.length) return Promise.resolve(pending.shift());
  if (ended) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

/** Release stdin so the process can exit. */
function close() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

async function ask(question, fallback = '') {
  const suffix = fallback ? log.c.dim(` [${fallback}]`) : '';
  stdout.write(`${question}${suffix}: `);

  const line = await nextLine();
  if (line === null) {
    stdout.write('\n');
    throw new Error('Input ended before the prompt was answered — aborting without changes.');
  }

  const answer = line.trim();
  if (!stdin.isTTY) stdout.write(answer + '\n'); // echo piped input so logs read correctly
  return answer || fallback;
}

async function secret(question) {
  const input = reader();
  // Suppress echo while the token is typed.
  const onKeypress = () => {
    if (input.line.length === 0) return;
    stdout.write('\x1b[2K\x1b[G' + question + ': ' + '*'.repeat(input.line.length));
  };
  stdout.write(`${question}: `);
  stdin.on('keypress', onKeypress);
  const line = await nextLine();
  stdin.off('keypress', onKeypress);
  stdout.write('\n');
  if (line === null) throw new Error('Input ended before the prompt was answered.');
  return line.trim();
}

async function confirm(question, defaultYes = false) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} (${hint})`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/**
 * Require the user to retype an exact phrase. Used as the last gate before
 * anything destructive runs, so a stray Enter can never trigger a delete.
 */
async function confirmPhrase(phrase) {
  const answer = await ask(`Type ${log.c.bold(phrase)} to proceed`);
  return answer === phrase;
}

function renderChoices(choices, labelFn) {
  const pad = String(choices.length).length;
  choices.forEach((choice, i) => {
    const num = String(i + 1).padStart(pad);
    console.log(`  ${log.c.cyan(num)}) ${labelFn(choice)}`);
  });
}

/** Single-choice picker. Auto-selects when there is exactly one option. */
async function select(question, choices, labelFn = String) {
  if (!choices.length) throw new Error(`Nothing to choose from for: ${question}`);
  if (choices.length === 1) {
    log.info(`${question}: ${log.c.bold(labelFn(choices[0]))} ${log.c.dim('(only option)')}`);
    return choices[0];
  }

  log.heading(question);
  renderChoices(choices, labelFn);

  for (;;) {
    const answer = await ask('Select');
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1];
    }
    log.warn(`Enter a number between 1 and ${choices.length}.`);
  }
}

/**
 * Parse "1,3,5-8" / "all" / "none" into zero-based indices.
 * Returns null when the input is unparseable so the caller can re-prompt.
 */
function parseSelection(input, max) {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'none' || trimmed === '') return [];
  if (trimmed === 'all' || trimmed === '*') {
    return Array.from({ length: max }, (_, i) => i);
  }

  const picked = new Set();
  for (const part of trimmed.split(',')) {
    const chunk = part.trim();
    if (!chunk) continue;

    const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      if (start < 1 || end > max || start > end) return null;
      for (let i = start; i <= end; i++) picked.add(i - 1);
      continue;
    }

    const single = Number(chunk);
    if (!Number.isInteger(single) || single < 1 || single > max) return null;
    picked.add(single - 1);
  }
  return [...picked].sort((a, b) => a - b);
}

/** Multi-choice picker accepting "1,3,5-8", "all", or "none". */
async function multiSelect(question, choices, labelFn = String) {
  if (!choices.length) return [];

  log.heading(question);
  renderChoices(choices, labelFn);
  log.info(log.c.dim('  Enter numbers (1,3,5-8), "all", or "none"'));

  for (;;) {
    const answer = await ask('Select');
    const indices = parseSelection(answer, choices.length);
    if (indices) return indices.map((i) => choices[i]);
    log.warn(`Could not parse that. Use numbers between 1 and ${choices.length}.`);
  }
}

module.exports = {
  ask, secret, confirm, confirmPhrase, select, multiSelect, parseSelection, close,
};
