'use strict';

const log = require('../core/logger');
const prompt = require('../core/prompt');
const audit = require('../core/audit');
const kubeconfig = require('../core/kubeconfig');
const backend = require('../core/cluster-backend');

module.exports = {
  name: 'cluster:db-cleanup',
  summary: 'Read a kubeconfig, find its infra cluster entry in the DB and remove it',
  destructive: true,
  usage: [
    'qa cluster:db-cleanup --kubeconfig ~/Downloads/xn55t9.yaml',
    'qa cluster:db-cleanup --kubeconfig ./kc.yaml --dry-run',
    'qa cluster:db-cleanup --name xn55t9        # skip the kubeconfig, match by name',
  ],

  async run(ctx) {
    const { env, args } = ctx;

    // ---- 1. Work out what to look for -------------------------------------
    let candidates;
    let source;

    if (args.name) {
      candidates = [args.name];
      source = `--name ${args.name}`;
    } else {
      const kcPath = args.kubeconfig || (await prompt.ask('Path to kubeconfig'));
      if (!kcPath) throw new Error('A kubeconfig path or --name is required.');

      const parsed = kubeconfig.parse(kcPath);
      candidates = parsed.candidates;
      source = parsed.file;

      log.heading('Kubeconfig');
      log.info(`File    : ${parsed.file}`);
      log.info(`Cluster : ${log.c.bold(parsed.clusterName)}`);
      log.info(`Server  : ${parsed.server || '-'}`);
      log.info(`Context : ${parsed.currentContext || '-'}`);
      log.info(log.c.dim(`Match candidates: ${candidates.join(', ')}`));
    }

    // ---- 2. Look it up ----------------------------------------------------
    // Opens a kubectl port-forward first when the backend is Mongo, and
    // always closes it again afterwards.
    return backend.withCluster(env, async ({ handle, ops, spec, label, forward }) => {
      const container = backend.containerName(spec);
      const fields = spec.matchFields || spec.matchColumns;

      if (forward && !forward.reused) {
        log.ok(`port-forward open on 127.0.0.1:${forward.port}`);
      }

      const found = await ops.findClusters(handle, spec, candidates);

      if (!found.length) {
        log.blank();
        log.warn(`Nothing in ${container} matched any of: ${candidates.join(', ')}`);
        log.info(
          log.c.dim(
            `Fields searched: ${fields.join(', ')}. Re-run with --name <value> if the DB uses a different identifier.`
          )
        );
        return { matched: 0 };
      }

      const display = backend.displayFields(spec, found[0]);
      const view = found.map((row) =>
        Object.fromEntries(display.map((key) => [key, backend.presentable(row[key])]))
      );

      log.heading(`Matched ${found.length} record(s) in ${container}`);
      log.table(view, display.map((key) => ({ key, label: key.toUpperCase() })));

      const index =
        found.length === 1
          ? 0
          : found.indexOf(
              await prompt.select(
                'Which cluster record should be removed?',
                found,
                (row) =>
                  display.map((key) => `${key}=${backend.presentable(row[key])}`).join('  ')
              )
            );
      const target = found[index];

      // ---- 3. Show the blast radius ---------------------------------------
      const pk = spec.primaryKey || (spec.collection ? '_id' : 'id');
      const clusterId = backend.presentable(target[pk]);
      const related = await ops.countRelated(handle, spec, target);

      log.heading('Records that will be deleted');
      log.table(
        [...related.map((r) => ({ table: r.table, rows: r.count })), { table: container, rows: 1 }],
        [
          { key: 'table', label: 'COLLECTION / TABLE' },
          { key: 'rows', label: 'COUNT' },
        ]
      );
      log.blank();
      log.info(`Database : ${log.c.bold(label)}`);
      log.info(`Cluster  : ${log.c.bold(String(backend.presentable(target[fields[0]]) ?? clusterId))}`);
      log.info(
        `Mode     : ${args.dryRun ? log.c.yellow('DRY RUN') : log.c.red('LIVE DELETE')}`
      );
      log.blank();

      // ---- 4. Confirm and execute -----------------------------------------
      if (!args.dryRun && !args.yes) {
        const phrase = String(backend.presentable(target[fields[0]]) ?? clusterId);
        if (!(await prompt.confirmPhrase(phrase))) {
          log.info('Aborted. Nothing was deleted.');
          return { matched: found.length, aborted: true };
        }
      }

      const { removed, committed } = await ops.deleteCluster(handle, spec, target, {
        dryRun: args.dryRun,
      });

      log.blank();
      if (committed) log.ok('Deleted.');
      else log.ok('Dry run complete — counted only, nothing changed.');

      log.table(removed, [
        { key: 'table', label: 'COLLECTION / TABLE' },
        { key: 'rows', label: committed ? 'DELETED' : 'WOULD DELETE' },
      ]);

      if (committed) {
        const file = audit.record({
          task: 'cluster:db-cleanup',
          env: env.name,
          database: label,
          source,
          clusterId,
          clusterRow: Object.fromEntries(
            display.map((key) => [key, backend.presentable(target[key])])
          ),
          removed,
        });
        log.info(log.c.dim(`Audit: ${file}`));
      }

      return { matched: found.length, removed };
    });
  },
};
