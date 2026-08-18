'use strict';

const log = require('./logger');
const { toList, pick } = require('./http');
const { template } = require('./config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Field names differ across console API versions, so every lookup goes through
 * `pick` with a list of aliases rather than a hardcoded key.
 */
const FIELDS = {
  id: ['id', 'uuid', 'compute_id', '_id'],
  name: ['name', 'instance_name', 'display_name', 'hostname'],
  status: ['status', 'state', 'power_state', 'vm_state'],
  created: ['created_at', 'createdAt', 'created', 'creation_date'],
  // ccpid is the value the console sends as the Project-ID header — it is not
  // the same as the project's own `id`, so it must be checked first.
  projectId: ['ccpid', 'ccp_id', 'ccpId', 'project_id', 'projectId', 'id', 'pk'],
  projectName: ['name', 'project_name', 'projectName', 'display_name'],
  domainName: ['name', 'domain', 'organisation_name', 'domain_name', 'slug'],
  // Which domain/tenant a project belongs to, for filtering the admin list.
  projectDomain: [
    'domain', 'domain_name', 'domainName', 'organisation_name',
    'organisationName', 'tenant', 'tenant_name', 'account_name',
  ],
};

const DEFAULT_DELETE_PATH =
  '/api/v2.1/computes/domain/{domain}/project/{project}/computes/{vmId}/';

/**
 * Fetch and normalise a list endpoint. Returns null when the endpoint is not
 * configured or errors, so callers can fall back to config lists or manual
 * entry instead of dead-ending.
 */
async function fetchList(api, endpointKey, vars, scope) {
  const templateStr = api.endpoints[endpointKey];
  if (!templateStr) return null;

  const response = await api.get(template(templateStr, vars), { scope });
  if (!response.ok) {
    log.debug(`GET ${endpointKey} -> ${response.status}`, String(response.raw).slice(0, 200));
    return null;
  }
  return toList(response.data);
}

async function listDomains(api, env) {
  const fetched = await fetchList(api, 'domains', {}, {});
  if (fetched) {
    const names = fetched
      .map((d) => (typeof d === 'string' ? d : pick(d, FIELDS.domainName)))
      .filter(Boolean);
    if (names.length) return { source: 'api', domains: names };
  }
  return { source: 'config', domains: env.domains || [] };
}

function normaliseProject(raw) {
  return {
    name: pick(raw, FIELDS.projectName),
    id: pick(raw, FIELDS.projectId),
    domain: pick(raw, FIELDS.projectDomain, null),
  };
}

/**
 * Projects come from the admin API, which is a different host with its own
 * token and limit/offset pagination. Falls back to the console endpoint and
 * then to the static config list, so a missing admin token is not fatal.
 */
async function listProjects(api, env, domain, adminApi) {
  if (adminApi?.endpoints?.projects && adminApi.token) {
    const { ok, items, total } = await adminApi.getAll(adminApi.endpoints.projects);
    if (ok) {
      const all = items.map(normaliseProject).filter((p) => p.name);

      // The admin list spans every tenant; narrow it when we know the domain.
      const scoped = domain
        ? all.filter((p) => !p.domain || String(p.domain) === String(domain))
        : all;

      if (scoped.length) {
        return { source: 'admin', projects: scoped, total, unscoped: all.length };
      }
      // A domain field we failed to recognise shouldn't hide every project.
      if (all.length) return { source: 'admin', projects: all, total, unscoped: all.length };
    }
  }

  const fetched = await fetchList(api, 'projects', { domain }, { domain });
  if (fetched) {
    const projects = fetched.map(normaliseProject).filter((p) => p.name);
    if (projects.length) return { source: 'console', projects };
  }

  return { source: 'config', projects: env.projects || [] };
}

/** Resolve the ccpid for one domain/project pair. */
async function resolveProjectId(api, env, domain, projectName, adminApi) {
  const { projects, source } = await listProjects(api, env, domain, adminApi);
  const match = projects.find((p) => String(p.name) === String(projectName));
  if (!match) {
    throw new Error(
      `Project "${projectName}" not found in ${domain} (looked in: ${source}). ` +
        `Known: ${projects.map((p) => p.name).join(', ') || 'none'}`
    );
  }
  if (match.id === undefined || match.id === null || match.id === '') {
    throw new Error(
      `Project "${projectName}" has no ccpid in the ${source} response — cannot set the Project-ID header.`
    );
  }
  return { ...match, source };
}

async function listVms(api, scope, filter) {
  const templateStr = api.endpoints.vms;
  if (!templateStr) {
    throw new Error(
      'No `endpoints.vms` configured. Set it in config.yaml, or use the paste-a-list mode.'
    );
  }

  const path = template(templateStr, { domain: scope.domain, project: scope.project });

  // Paginate — these endpoints default to a small page size, which is the
  // usual reason a listing looks like it is missing VMs.
  const paged = await api.getAll(path, { scope });
  if (!paged.ok) {
    throw new Error(
      `Could not list VMs (HTTP ${paged.response.status}). ` +
        String(paged.response.raw || '').slice(0, 200)
    );
  }

  let vms = paged.items
    .map((vm) => ({
      id: pick(vm, FIELDS.id),
      name: pick(vm, FIELDS.name, '(unnamed)'),
      status: pick(vm, FIELDS.status, '-'),
      created: String(pick(vm, FIELDS.created, '-')).slice(0, 19).replace('T', ' '),
    }))
    .filter((vm) => vm.id);

  const total = vms.length;
  if (filter) {
    const pattern = new RegExp(filter, 'i');
    vms = vms.filter((vm) => pattern.test(vm.name));
  }

  vms.sort((a, b) => a.name.localeCompare(b.name));
  return { vms, total, filtered: vms.length };
}

/**
 * Delete VMs one at a time. Each VM may carry its own domain/project/projectId
 * — a pasted list can span tenants — and falls back to `defaultScope` when it
 * doesn't. `onProgress` fires after each so the CLI can print a line and the
 * web UI can report per-VM outcomes.
 */
async function deleteVms(api, defaultScope, vms, { dryRun = false, delayMs = 1000, onProgress } = {}) {
  const results = { success: [], failed: [] };
  const deleteTemplate = api.endpoints.vmDelete || DEFAULT_DELETE_PATH;

  for (const [index, vm] of vms.entries()) {
    const scope = {
      domain: vm.domain || defaultScope.domain,
      project: vm.project || defaultScope.project,
      projectId: vm.projectId ?? defaultScope.projectId,
    };

    if (!scope.domain || !scope.project) {
      const entry = {
        ...vm,
        outcome: 'failed',
        httpStatus: 0,
        detail: 'missing domain or project for this VM',
      };
      results.failed.push(entry);
      if (onProgress) onProgress({ index, total: vms.length, ...entry });
      continue;
    }

    const url = template(deleteTemplate, {
      domain: scope.domain,
      project: scope.project,
      vmId: vm.id,
    });

    if (dryRun) {
      const entry = {
        ...vm,
        ...scope,
        outcome: 'dry-run',
        url: api.url(url),
        curl: api.toCurl('DELETE', url, { scope }),
      };
      results.success.push(entry);
      if (onProgress) onProgress({ index, total: vms.length, ...entry });
      continue;
    }

    const response = await api.delete(url, { scope });
    const entry = {
      ...vm,
      ...scope,
      httpStatus: response.status,
      outcome: response.ok ? 'deleted' : 'failed',
      detail: response.ok ? undefined : String(response.raw || '').slice(0, 300),
    };

    if (response.ok) results.success.push(entry);
    else results.failed.push(entry);

    if (onProgress) onProgress({ index, total: vms.length, ...entry });
    if (index < vms.length - 1 && delayMs) await sleep(delayMs);
  }

  return results;
}

module.exports = {
  FIELDS, fetchList, listDomains, listProjects, resolveProjectId,
  normaliseProject, listVms, deleteVms,
};
