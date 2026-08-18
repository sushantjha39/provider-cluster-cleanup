#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const log = require('./core/logger');
const prompt = require('./core/prompt');
const config = require('./core/config');
const { tasks, byName } = require('./tasks');

const FLAG_ALIASES = {
  'project-id': 'projectId',
  'dry-run': 'dryRun',
  kubeconfig: 'kubeconfig',
  k: 'kubeconfig',
  e: 'env',
  v: 'verbose',
  y: 'yes',
  h: 'help',
};

const BOOLEAN_FLAGS = new Set(['dryRun', 'yes', 'verbose', 'help', 'curl']);

function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith('-')) {
      args._.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.replace(/^--?/, '').split(/=(.+)/);
    const key = FLAG_ALIASES[rawKey] || rawKey;

    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }

  return args;
}

function printHelp() {
  log.heading('qa — one stop QA ops agent');
  log.info('\nUsage:  qa <task> [options]        (run with no task for a menu)\n');

  log.info(log.c.bold('Tasks'));
  const width = Math.max(...tasks.map((t) => t.name.length));
  for (const task of tasks) {
    const marker = task.destructive ? log.c.red('*') : ' ';
    log.info(`  ${marker} ${task.name.padEnd(width)}  ${log.c.dim(task.summary)}`);
  }
  log.info(log.c.dim(`\n  ${log.c.red('*')} destructive — always previews and asks before writing`));

  log.info('\n' + log.c.bold('Global options'));
  log.info('  -e, --env <name>    environment from config.yaml (default: defaultEnv)');
  log.info('      --config <path> alternate config file');
  log.info('      --dry-run       show what would happen, change nothing');
  log.info('      --curl          with --dry-run, print the equivalent curl command');
  log.info('  -y, --yes           skip the confirmation prompt');
  log.info('  -v, --verbose       log requests and SQL');
  log.info('  -h, --help          this text');

  log.info('\n' + log.c.bold('Examples'));
  for (const task of tasks) {
    for (const line of task.usage || []) log.info(log.c.dim(`  ${line}`));
  }
  log.blank();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log.setVerbose(args.verbose);

  if (args.help) return printHelp();

  let taskName = args._.shift();

  if (taskName === 'list' || taskName === 'help') return printHelp();

  // No task named — offer the menu.
  if (!taskName) {
    log.heading('What do you want to do?');
    const choice = await prompt.select(
      'Task',
      tasks,
      (task) =>
        `${task.name}${task.destructive ? log.c.red(' *') : '  '}  ${log.c.dim(task.summary)}`
    );
    taskName = choice.name;
  }

  const task = byName.get(taskName);
  if (!task) {
    log.error(`Unknown task "${taskName}"`);
    log.info(log.c.dim(`Known tasks: ${[...byName.keys()].join(', ')}`));
    process.exitCode = 1;
    return;
  }

  const loaded = config.load(args.config);
  const env = config.resolveEnv(loaded, args.env);

  // One token drives both the admin API (ccpid lookup) and the console API.
  const token = args.token || env.token || process.env.API_TOKEN || process.env.ADMIN_TOKEN;
  env.token = token;
  env.admin = {
    ...(env.admin || {}),
    token: args.token || env.admin?.token || process.env.ADMIN_TOKEN || token,
  };

  await task.run({ env, args, config: loaded });
}

main()
  .catch((err) => {
    log.blank();
    log.error(err.message);
    if (process.argv.includes('-v') || process.argv.includes('--verbose')) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  })
  .finally(() => prompt.close());
