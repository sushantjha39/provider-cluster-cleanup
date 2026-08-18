'use strict';

const log = require('../core/logger');
const prompt = require('../core/prompt');
const audit = require('../core/audit');
const fs = require('fs');
const { ApiClient, adminClient } = require('../core/http');
const vmService = require('../core/vm-service');
const { parseVmList } = require('../core/vm-list');

/**
 * Read targets from a pasted/exported list instead of the API. Accepts the
 * delete45.sh pipe format; `-` reads stdin.
 */
function vmsFromList(file, defaults) {
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const { entries, errors, duplicates } = parseVmList(text, defaults);

  if (duplicates) log.warn(`${duplicates} duplicate line(s) ignored`);
  for (const bad of errors) {
    log.warn(`line ${bad.line}: ${bad.reason} — ${bad.text}`);
  }
  if (!entries.length) throw new Error('No usable VM entries in that list.');

  log.ok(`${entries.length} VM(s) parsed from ${file === '-' ? 'stdin' : file}`);
  return entries;
}

async function chooseDomain(api, env, args) {
  if (args.domain) return args.domain;

  const { domains, source } = await vmService.listDomains(api, env);
  if (!domains.length) return prompt.ask('Domain / organisation name');

  log.debug(`domains from ${source}`);
  return prompt.select('Select domain', domains);
}

async function chooseProject(api, env, args, domain, adminApi) {
  // An explicit --project still gets its ccpid resolved automatically.
  if (args.project) {
    if (args.projectId) return { name: args.project, id: args.projectId };
    const resolved = await vmService.resolveProjectId(api, env, domain, args.project, adminApi);
    log.ok(`ccpid ${resolved.id} for ${args.project} (from ${resolved.source})`);
    return { name: args.project, id: resolved.id };
  }

  const { projects, source } = await vmService.listProjects(api, env, domain, adminApi);
  if (!projects.length) {
    const name = await prompt.ask('Project name', 'default-project');
    const id = await prompt.ask(`ccpid for "${name}"`);
    return { name, id };
  }

  log.debug(`projects from ${source}`);
  return prompt.select(
    `Select project in ${domain}`,
    projects,
    (p) => `${p.name}${p.id ? log.c.dim(`  (ccpid ${p.id})`) : log.c.red('  (no ccpid)')}`
  );
}

async function chooseVms(api, args, scope) {
  const { vms, total, filtered } = await vmService.listVms(api, scope, args.filter);

  if (args.filter) {
    log.info(log.c.dim(`Filter /${args.filter}/i matched ${filtered} of ${total} VMs`));
  }
  if (!vms.length) {
    log.warn('No VMs found in this project.');
    return [];
  }

  const nameWidth = Math.max(...vms.map((vm) => vm.name.length));
  const statusWidth = Math.max(...vms.map((vm) => String(vm.status).length));

  return prompt.multiSelect(
    `VMs in ${scope.domain} / ${scope.project}`,
    vms,
    (vm) =>
      `${vm.name.padEnd(nameWidth)}  ${log.c.dim(String(vm.status).padEnd(statusWidth))}  ${log.c.dim(vm.id)}`
  );
}

module.exports = {
  name: 'vm:delete',
  summary: 'Pick a domain, project and VMs from live lists, then delete them',
  destructive: true,
  usage: [
    'qa vm:delete --list vms.txt              # paste-a-list mode (delete45.sh format)',
    'pbpaste | qa vm:delete --list - --dry-run --curl',
    'qa vm:delete                             # interactive, needs working list endpoints',
    'qa vm:delete --filter "^k8s-.*-xn55t9-" --dry-run',
  ],

  async run(ctx) {
    const { env, args } = ctx;

    if (!env.token) {
      throw new Error(
        'No API token. Export it first:\n  export API_TOKEN="…"\nor put API_TOKEN in .env'
      );
    }

    const api = new ApiClient(env);

    log.heading(`VM delete — ${env.name}`);
    log.info(log.c.dim(`${api.baseUrl}   region ${api.region}`));

    let vms;
    let scope;

    if (args.list) {
      // Pasted-list mode: no API listing involved.
      scope = {
        domain: args.domain,
        project: args.project,
        projectId: args.projectId,
      };
      vms = vmsFromList(args.list, scope);
    } else {
      const adminApi = env.admin?.baseUrl ? adminClient(env) : null;
      const domain = await chooseDomain(api, env, args);
      const project = await chooseProject(api, env, args, domain, adminApi);
      scope = { domain, project: project.name, projectId: project.id };
      vms = await chooseVms(api, args, scope);
    }

    if (!vms.length) {
      log.info('Nothing selected. Exiting without changes.');
      return { selected: 0 };
    }

    log.heading(`About to delete ${vms.length} VM(s)`);
    log.table(
      vms.map((vm) => ({
        name: vm.name,
        domain: vm.domain || scope.domain,
        project: vm.project || scope.project,
        id: vm.id,
      })),
      [
        { key: 'name', label: 'NAME' },
        { key: 'domain', label: 'DOMAIN' },
        { key: 'project', label: 'PROJECT' },
        { key: 'id', label: 'ID' },
      ]
    );
    log.blank();
    log.info(`Mode       : ${args.dryRun ? log.c.yellow('DRY RUN') : log.c.red('LIVE DELETE')}`);
    log.blank();

    if (!args.dryRun && !args.yes) {
      const phrase = `delete ${vms.length}`;
      if (!(await prompt.confirmPhrase(phrase))) {
        log.info('Aborted. Nothing was deleted.');
        return { selected: vms.length, aborted: true };
      }
    }

    const results = await vmService.deleteVms(api, scope, vms, {
      dryRun: args.dryRun,
      delayMs: env.deleteDelayMs ?? 1000,
      onProgress: (p) => {
        const counter = log.c.dim(`[${p.index + 1}/${p.total}]`);
        if (p.outcome === 'dry-run') {
          log.info(`${counter} ${log.c.yellow('DRY RUN')} DELETE ${p.url}`);
          if (args.curl) log.info(log.c.dim(p.curl) + '\n');
        } else if (p.outcome === 'deleted') {
          log.info(`${counter} ${p.name} … ${log.c.green(`ok (${p.httpStatus})`)}`);
        } else {
          log.info(`${counter} ${p.name} … ${log.c.red(`failed (${p.httpStatus})`)}`);
          log.info(log.c.dim(`      ${p.detail}`));
        }
      },
    });

    log.blank();
    log.rule();
    log.info(`Total  : ${vms.length}`);
    log.info(`Success: ${log.c.green(results.success.length)}`);
    log.info(`Failed : ${results.failed.length ? log.c.red(results.failed.length) : '0'}`);
    log.rule();

    if (!args.dryRun) {
      const file = audit.record({
        task: 'vm:delete',
        env: env.name,
        source: args.list ? `list:${args.list}` : 'interactive',
        deleted: results.success.map((vm) => ({
          id: vm.id, name: vm.name, domain: vm.domain, project: vm.project,
        })),
        failed: results.failed.map((vm) => ({ id: vm.id, name: vm.name, status: vm.httpStatus })),
      });
      log.info(log.c.dim(`Audit: ${file}`));
    }

    if (results.failed.length) process.exitCode = 1;
    return results;
  },
};
