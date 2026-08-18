'use strict';

const log = require('./logger');

/**
 * VM discovery via the admin API (/adminapi/v2/compute/computes-list/).
 *
 * The important property of this endpoint is that each record already carries
 * everything a delete needs — the VM id, the project name, the project's
 * numeric id (the value the console sends as the Project-ID header) and the
 * owning organisation's platform_domain. So no second lookup is required:
 * fetch once, delete from the same records.
 *
 * Response shape:
 *   { filter_values: {...}, applied_search: {}, applied_filters: {}, data: [ ... ] }
 * There is no total/count field, so paging stops on a short page.
 */

const DEFAULT_PAGE_SIZE = 200;

/** Epoch-seconds strings → readable UTC timestamp. */
function toIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '-';
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function organisationOf(raw) {
  const org = raw.project?.organisation || {};
  return org.platform_domain || org.name || null;
}

/** Flatten one admin record into a delete-ready target. */
function normalise(raw) {
  const project = raw.project || {};
  return {
    id: raw.id,
    name: raw.instance_name || '(unnamed)',
    status: raw.status || raw.action || '-',
    created: toIso(raw.created),
    domain: organisationOf(raw),
    project: project.name || null,
    // project.id is the per-tenant project row id == the Project-ID header.
    projectId: project.id ?? raw.project_id ?? null,
    instanceType: raw.instance_type || '-',
    host: raw.compute_host_name || '-',
    providerInstanceId: raw.provider_instance_id || null,
  };
}

/**
 * Does a record belong to `domain`? Prefers the structured organisation field
 * and falls back to the domain appearing inside the instance name, since
 * cluster VMs are named k8s-<domain>-<clusterid>-<role>.
 */
function matchesDomain(vm, domain) {
  if (!domain) return true;
  const needle = String(domain).toLowerCase();
  if (vm.domain && String(vm.domain).toLowerCase() === needle) return true;
  return String(vm.name).toLowerCase().includes(needle);
}

function buildQuery({ limit, offset, status, sortBy = 'created', sortAsc = false, filters }) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort_by: sortBy,
    sort_asc: String(Boolean(sortAsc)),
  });

  const combined = { ...(filters || {}) };
  if (status?.length) combined.status = status;
  if (Object.keys(combined).length) params.set('filters', JSON.stringify(combined));

  return params;
}

/**
 * Read the organisation/status/project pick-lists the endpoint returns
 * alongside its data, so the UI can offer a domain dropdown instead of
 * free text. One cheap request.
 */
async function listFilterValues(adminApi) {
  const path = adminApi.endpoints.computes;
  if (!path) throw new Error('No `admin.endpoints.computes` configured.');

  const query = buildQuery({ limit: 1, offset: 0 });
  const response = await adminApi.get(`${path}?${query}`);
  if (!response.ok) {
    throw new Error(`Admin VM list returned HTTP ${response.status}`);
  }

  const values = response.data?.filter_values || {};
  return {
    organisations: (values.organisation || []).map((o) => ({ name: o.name, id: o.id })),
    statuses: (values.status || []).map((s) => s.value),
    projects: (values.project || []).map((p) => ({
      name: p.name, id: p.id, key: p.project_id,
    })),
  };
}

/**
 * Fetch VMs, narrowing by domain server-side when the API honours the filter
 * and client-side when it does not.
 *
 * Server-side narrowing matters: there are thousands of VMs across all
 * tenants, and the token expires in ~5 minutes, so paging the whole estate is
 * not viable. We send an organisation filter, then verify the response is
 * actually narrowed before trusting it.
 */
async function listVms(adminApi, options = {}) {
  const {
    domain,
    status = ['Active'],
    nameFilter,
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = 40,
    organisationId,
  } = options;

  const path = adminApi.endpoints.computes;
  if (!path) throw new Error('No `admin.endpoints.computes` configured.');

  // Try the most specific filter the API is likely to accept.
  const attempts = [];
  if (domain) {
    if (organisationId !== undefined && organisationId !== null) {
      attempts.push({ organisation: [organisationId] });
    }
    attempts.push({ organisation: [domain] });
  }
  attempts.push(undefined); // unfiltered, narrowed client-side

  let serverFiltered = false;
  let collected = [];
  let pages = 0;
  let truncated = false;

  for (const filters of attempts) {
    collected = [];
    pages = 0;
    truncated = false;

    for (let offset = 0; pages < maxPages; offset += pageSize) {
      const query = buildQuery({ limit: pageSize, offset, status, filters });
      const response = await adminApi.get(`${path}?${query}`);
      pages++;

      if (!response.ok) {
        // A rejected filter shape is not fatal — fall through to the next attempt.
        log.debug(`computes-list filter ${JSON.stringify(filters)} -> ${response.status}`);
        collected = null;
        break;
      }

      const rows = (response.data?.data || []).map(normalise);
      collected.push(...rows);

      if (rows.length < pageSize) break;
      if (pages >= maxPages) truncated = true;
    }

    if (collected === null) continue;

    // Trust the filter only if every row really belongs to the domain.
    if (filters && domain && collected.length) {
      const allMatch = collected.every((vm) => matchesDomain(vm, domain));
      if (allMatch) {
        serverFiltered = true;
        break;
      }
      log.debug('server ignored the organisation filter; narrowing locally');
      continue;
    }
    break;
  }

  if (!collected) throw new Error('Admin VM list could not be read with any filter shape.');

  const fetched = collected.length;
  let vms = domain ? collected.filter((vm) => matchesDomain(vm, domain)) : collected;

  if (nameFilter) {
    const pattern = new RegExp(nameFilter, 'i');
    vms = vms.filter((vm) => pattern.test(vm.name));
  }

  vms.sort((a, b) => a.name.localeCompare(b.name));

  if (truncated) {
    log.warn(`Stopped after ${maxPages} pages — results may be incomplete.`);
  }

  return {
    vms,
    fetched,
    matched: vms.length,
    serverFiltered,
    truncated,
    pages,
  };
}

module.exports = { listVms, listFilterValues, normalise, matchesDomain, toIso, buildQuery };
