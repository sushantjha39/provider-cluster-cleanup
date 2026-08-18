'use strict';

/**
 * Task registry. Adding a chore to the agent means dropping a module here
 * that exports { name, summary, destructive, usage, run(ctx) }.
 */
const tasks = [
  require('./vm-delete'),
  require('./cluster-db-cleanup'),
  require('./api-probe'),
];

const byName = new Map(tasks.map((task) => [task.name, task]));

module.exports = { tasks, byName };
