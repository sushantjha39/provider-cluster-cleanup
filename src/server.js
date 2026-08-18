#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const log = require('./core/logger');
const config = require('./core/config');
const audit = require('./core/audit');
const kubeconfig = require('./core/kubeconfig');
const { ApiClient, adminClient } = require('./core/http');
const vmService = require('./core/vm-service');
const adminVms = require('./core/admin-vms');
const backend = require('./core/cluster-backend');
const mongo = require('./core/mongo');
const portForward = require('./core/port-forward');
const kubectl = require('./core/kubectl');
const auth = require('./core/auth');
const kcStore = require('./core/kubeconfig-store');
const { parseVmList } = require('./core/vm-list');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4300);

// Loopback only. This process can delete infrastructure and holds DB
// credentials — it must never be reachable from the network.
const HOST = '127.0.0.1';

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Kubeconfigs are small; anything larger is a mistake or an attack.
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Resolve the environment block. One pasted admin token drives both the admin
 * API (project/ccpid lookup) and the console API (the deletes), so the UI only
 * ever asks for a single token.
 */
function envFor(name, tokenOverride, hosts = {}) {
  const loaded = config.load(process.env.QA_CONFIG);
  const env = config.resolveEnv(loaded, name);

  const token = tokenOverride || env.token || process.env.API_TOKEN || process.env.ADMIN_TOKEN;
  env.token = token;
  env.admin = {
    ...(env.admin || {}),
    token: tokenOverride || env.admin?.token || process.env.ADMIN_TOKEN || token,
  };

  // Hosts typed into the UI win over config, so moving between dev and prod
  // needs no file edit. Trailing slashes are trimmed to keep path joins clean.
  const clean = (url) => String(url).trim().replace(/\/+$/, '');

  if (hosts.console) env.baseUrl = clean(hosts.console);
  if (hosts.admin) {
    env.admin.baseUrl = clean(hosts.admin);
    // auth.baseUrl falls back to admin.baseUrl, so clear any stale value
    // unless the identity provider was pinned to its own host.
    if (env.admin.auth && !env.admin.auth.tokenUrl) {
      env.admin.auth = { ...env.admin.auth, baseUrl: hosts.auth ? clean(hosts.auth) : '' };
    }
  } else if (hosts.auth && env.admin.auth) {
    env.admin.auth = { ...env.admin.auth, baseUrl: clean(hosts.auth) };
  }

  return env;
}

/** Read host overrides sent by the browser. */
function hostsFrom(req) {
  return {
    console: req.headers['x-console-base-url'] || undefined,
    admin: req.headers['x-admin-base-url'] || undefined,
    auth: req.headers['x-auth-base-url'] || undefined,
  };
}

/**
 * Ensure a usable token: a pasted one wins, otherwise mint one from the
 * password grant and let the cache renew it as it ages out.
 */
async function ensureToken(env) {
  if (env.token) return { token: env.token, source: 'pasted' };

  if (auth.canMint(env.admin)) {
    const token = await auth.getToken(env.admin);
    env.token = token;
    env.admin.token = token;
    return { token, source: 'minted', secondsLeft: auth.secondsLeft(env.admin) };
  }

  throw new Error(
    'No admin token, and none can be minted. Paste one in the UI, or set ' +
      'ADMIN_USERNAME / ADMIN_PASSWORD in .env to have them generated.'
  );
}

/**
 * Same as envFor, but points the DB port-forward at an uploaded kubeconfig.
 * This is what lets the flow be: upload kubeconfig -> pick tenant -> delete,
 * with the tunnel opened against the cluster that kubeconfig describes.
 */
function envForDb(name, kubeconfigId, podIndex, hosts) {
  const env = envFor(name, undefined, hosts);
  const kubeconfigPath = kcStore.resolve(kubeconfigId);
  const forward = { ...(env.db?.portForward || {}) };

  if (kubeconfigPath) forward.kubeconfig = kubeconfigPath;
  if (podIndex !== undefined && podIndex !== null && podIndex !== '') {
    forward.podIndex = Number(podIndex);
    // An explicit index must win over a hardcoded pod name.
    delete forward.pod;
  }

  env.db = { ...env.db, portForward: forward };
  return env;
}

/**
 * Fill in the ccpid for a domain/project pair by asking the admin API, so the
 * caller never has to know or type a Project-ID. An explicit projectId is
 * honoured as an override.
 */
async function resolveScope(env, { domain, project, projectId }) {
  if (!domain || !project) throw new Error('domain and project are required');
  if (projectId) return { domain, project, projectId, ccpidSource: 'provided' };

  const resolved = await vmService.resolveProjectId(
    new ApiClient(env),
    env,
    domain,
    project,
    adminClient(env)
  );
  return {
    domain,
    project,
    projectId: resolved.id,
    ccpidSource: resolved.source,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = {
  /** Mint a token from the configured credentials, for the UI's button. */
  'POST /api/token': async ({ body, hosts }) => {
    const env = envFor(body.env, undefined, hosts);
    if (!auth.canMint(env.admin)) {
      throw new Error(
        `Cannot mint tokens — missing admin.auth: ${auth.describe(env.admin).join(', ')}. ` +
          'Set ADMIN_USERNAME / ADMIN_PASSWORD in .env'
      );
    }
    const token = await auth.getToken(env.admin, { force: Boolean(body.force) });
    return {
      token,
      secondsLeft: auth.secondsLeft(env.admin),
      username: env.admin.auth.username,
    };
  },

  'GET /api/config': async () => {
    const loaded = config.load(process.env.QA_CONFIG);
    const names = Object.keys(loaded.environments || {});
    return {
      environments: names.map((name) => {
        const env = config.resolveEnv(loaded, name);
        return {
          name,
          baseUrl: env.baseUrl || '',
          adminBaseUrl: env.admin?.baseUrl || '',
          authBaseUrl: env.admin?.auth?.baseUrl || '',
          hasDb: Boolean(env.db),
          canMint: auth.canMint(env.admin),
        };
      }),
      defaultEnv: loaded.defaultEnv || names[0],
      tokenFromEnv: Boolean(process.env.API_TOKEN),
      canMintToken: names.some((name) =>
        auth.canMint(config.resolveEnv(loaded, name).admin)
      ),
    };
  },

  'GET /api/projects': async ({ query, token, hosts }) => {
    const env = envFor(query.get('env'), token, hosts);
    await ensureToken(env);
    return vmService.listProjects(
      new ApiClient(env),
      env,
      query.get('domain') || undefined,
      adminClient(env)
    );
  },

  /** Domains + statuses for the pickers, straight off the admin endpoint. */
  'GET /api/domains': async ({ query, token, hosts }) => {
    const env = envFor(query.get('env'), token, hosts);
    await ensureToken(env);
    try {
      const values = await adminVms.listFilterValues(adminClient(env));
      return { source: 'admin', domains: values.organisations, statuses: values.statuses };
    } catch (err) {
      if (err.tokenExpired) throw err;
      // Fall back to the static list so the picker still works.
      return {
        source: 'config',
        domains: (env.domains || []).map((name) => ({ name, id: null })),
        statuses: ['Active'],
        note: err.message,
      };
    }
  },

  'GET /api/vms': async ({ query, token, hosts }) => {
    const env = envFor(query.get('env'), token, hosts);
    await ensureToken(env);

    const statusParam = query.get('status');
    return adminVms.listVms(adminClient(env), {
      domain: query.get('domain') || undefined,
      organisationId: query.get('organisationId') || undefined,
      status: statusParam ? statusParam.split(',').filter(Boolean) : ['Active'],
      nameFilter: query.get('filter') || undefined,
    });
  },

  /** Parse a pasted list without deleting anything, for the preview table. */
  'POST /api/vms/parse': async ({ body, hosts }) => {
    const defaults = {
      domain: body.domain || undefined,
      project: body.project || undefined,
      projectId: body.projectId || undefined,
    };
    return parseVmList(body.text, defaults);
  },

  'POST /api/vms/delete': async ({ body, token, hosts }) => {
    const env = envFor(body.env, token, hosts);
    await ensureToken(env);

    const { domain, project, projectId, vms, dryRun } = body;
    if (!Array.isArray(vms) || !vms.length) throw new Error('No VMs selected');

    // Resolve a ccpid for any VM that arrived without one, keyed by
    // domain/project so a mixed-tenant list only costs one lookup per pair.
    const cache = new Map();
    for (const vm of vms) {
      if (vm.projectId) continue;
      const key = `${vm.domain || domain}/${vm.project || project}`;
      if (!cache.has(key)) {
        cache.set(
          key,
          await resolveScope(env, {
            domain: vm.domain || domain,
            project: vm.project || project,
            projectId: undefined,
          })
        );
      }
      vm.projectId = cache.get(key).projectId;
    }

    // Each VM may carry its own tenant; these are only the fallbacks.
    const defaultScope = { domain, project, projectId };
    const results = await vmService.deleteVms(new ApiClient(env), defaultScope, vms, {
      dryRun: Boolean(dryRun),
      delayMs: env.deleteDelayMs ?? 1000,
    });

    if (!dryRun) {
      audit.record({
        task: 'vm:delete',
        via: 'web',
        env: env.name,
        domain,
        project,
        projectId,
        deleted: results.success.map((vm) => ({
          id: vm.id, name: vm.name, domain: vm.domain, project: vm.project,
        })),
        failed: results.failed.map((vm) => ({
          id: vm.id, name: vm.name, status: vm.httpStatus,
        })),
      });
    }

    return results;
  },

  'POST /api/cluster/find': async ({ body, hosts }) => {
    const env = envForDb(body.env, body.kc, body.podIndex, hosts);

    let candidates;
    let source;
    let parsed = null;

    if (body.name) {
      candidates = [String(body.name)];
      source = `name: ${body.name}`;
    } else if (body.kubeconfig) {
      parsed = kubeconfig.parseText(body.kubeconfig, body.filename || '(uploaded)');
      candidates = parsed.candidates;
      source = parsed.file;
    } else {
      throw new Error('Provide a kubeconfig or a cluster name');
    }

    return backend.withCluster(env, async ({ handle, ops, spec, label, role, podIndex, forward }) => {
      const rows = await ops.findClusters(handle, spec, candidates);
      const display = backend.displayFields(spec, rows[0]);
      const pk = spec.primaryKey || (spec.collection ? '_id' : 'id');

      const matches = [];
      for (const row of rows) {
        matches.push({
          id: backend.presentable(row[pk]),
          row: Object.fromEntries(
            display.map((key) => [key, backend.presentable(row[key])])
          ),
          related: await ops.countRelated(handle, spec, row),
        });
      }

      return {
        source,
        candidates,
        kubeconfig: parsed && {
          clusterName: parsed.clusterName,
          server: parsed.server,
          currentContext: parsed.currentContext,
        },
        table: backend.containerName(spec),
        display,
        database: label,
        matches,
        // Writes need the primary; tell the UI which member we are on.
        replica: {
          isPrimary: role?.isPrimary ?? null,
          setName: role?.setName ?? null,
          primary: role?.primary ?? null,
          me: role?.me ?? null,
          podIndex: podIndex ?? null,
          pod: portForward.resolvePodName(env.db.portForward),
          reusedTunnel: Boolean(forward?.reused),
        },
      };
    });
  },

  'POST /api/cluster/delete': async ({ body, hosts }) => {
    const env = envForDb(body.env, body.kc, body.podIndex, hosts);
    if (body.clusterId === undefined || body.clusterId === null) {
      throw new Error('clusterId is required');
    }

    return backend.withCluster(env, async ({ handle, ops, spec, label, role, notPrimaryHint }) => {
      const target = await ops.findById(handle, spec, body.clusterId);
      if (!target) {
        throw new Error(`No record in ${backend.containerName(spec)} with id ${body.clusterId}`);
      }

      // Refuse a live delete against a secondary rather than letting the
      // driver fail mid-way with a bare "not primary".
      if (!body.dryRun && role?.isPrimary === false) {
        throw new Error(notPrimaryHint());
      }

      let removed;
      let committed;
      try {
        ({ removed, committed } = await ops.deleteCluster(handle, spec, target, {
          dryRun: Boolean(body.dryRun),
        }));
      } catch (err) {
        if (/not primary|NotWritablePrimary|not master/i.test(err.message)) {
          throw new Error(notPrimaryHint());
        }
        throw err;
      }

      if (committed) {
        const display = backend.displayFields(spec, target);
        audit.record({
          task: 'cluster:db-cleanup',
          via: 'web',
          env: env.name,
          database: label,
          source: body.source || 'web',
          clusterId: body.clusterId,
          clusterRow: Object.fromEntries(
            display.map((key) => [key, backend.presentable(target[key])])
          ),
          removed,
        });
      }

      return { removed, committed };
    });
  },

  /** Inspect the config DB to help fill in database/collection names. */
  'POST /api/cluster/inventory': async ({ body, hosts }) => {
    const env = envFor(body.env, undefined, hosts);
    const dbConfig = env.db || {};
    const driver = String(dbConfig.driver || '').toLowerCase();

    if (driver !== 'mongodb' && driver !== 'mongo') {
      throw new Error('Inventory is only available for the mongodb driver.');
    }

    return portForward.withForward(dbConfig.portForward, async (forward) => {
      const port = forward.port || dbConfig.port || 27017;
      const handle = await mongo.connect(dbConfig, port);
      try {
        const found = await mongo.inventory(handle);
        return { ...found, uri: handle.uri, port, reused: forward.reused };
      } finally {
        await handle.close();
      }
    });
  },

  // ---- Cluster explorer (Lens-like) ------------------------------------

  'GET /api/k8s/kubeconfigs': async () => ({ kubeconfigs: kcStore.list() }),

  'POST /api/k8s/kubeconfigs': async ({ body, hosts }) => {
    if (!body.text?.trim()) throw new Error('No kubeconfig content received');
    const saved = kcStore.save(body.text, body.filename);
    return {
      id: saved.id,
      label: saved.clusterName,
      clusterName: saved.clusterName,
      server: saved.server,
      currentContext: saved.currentContext,
      contexts: saved.contextNames,
    };
  },

  'POST /api/k8s/kubeconfigs/delete': async ({ body, hosts }) => {
    kcStore.remove(body.id);
    return { removed: body.id };
  },

  'GET /api/k8s/contexts': async ({ query }) => {
    return kubectl.contexts({ kubeconfig: kcStore.resolve(query.get('kc')) });
  },

  'GET /api/k8s/resources': async ({ query }) => {
    const namespace = query.get('namespace');
    return kubectl.list(query.get('kind') || 'pods', {
      namespace: namespace === '*' ? undefined : namespace,
      allNamespaces: namespace === '*',
      kubeconfig: kcStore.resolve(query.get('kc')),
      context: query.get('context') || undefined,
    });
  },

  'GET /api/k8s/logs': async ({ query }) => {
    const text = await kubectl.logs({
      namespace: query.get('namespace'),
      pod: query.get('pod'),
      container: query.get('container') || undefined,
      tail: query.get('tail') || 500,
      previous: query.get('previous') === 'true',
      kubeconfig: kcStore.resolve(query.get('kc')),
      context: query.get('context') || undefined,
    });
    return { text };
  },

  'GET /api/k8s/describe': async ({ query }) => {
    const text = await kubectl.describe({
      namespace: query.get('namespace') || undefined,
      kind: query.get('kind'),
      name: query.get('name'),
      kubeconfig: kcStore.resolve(query.get('kc')),
      context: query.get('context') || undefined,
    });
    return { text };
  },

  'POST /api/k8s/exec': async ({ body, hosts }) => {
    const started = Date.now();
    const text = await kubectl.exec({
      namespace: body.namespace,
      pod: body.pod,
      container: body.container || undefined,
      command: body.command,
      kubeconfig: kcStore.resolve(body.kc),
      context: body.context || undefined,
    });
    audit.record({
      task: 'k8s:exec',
      via: 'web',
      namespace: body.namespace,
      pod: body.pod,
      container: body.container,
      command: body.command,
    });
    return { text, ms: Date.now() - started };
  },

  'POST /api/k8s/delete': async ({ body, hosts }) => {
    const text = await kubectl.deleteResource({
      namespace: body.namespace || undefined,
      kind: body.kind,
      name: body.name,
      kubeconfig: kcStore.resolve(body.kc),
      context: body.context || undefined,
    });
    audit.record({
      task: 'k8s:delete',
      via: 'web',
      kind: body.kind,
      namespace: body.namespace,
      name: body.name,
    });
    return { text };
  },

  'GET /api/audit': async () => {
    if (!fs.existsSync(audit.LOG_DIR)) return { entries: [] };

    const files = fs
      .readdirSync(audit.LOG_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, 7);

    const entries = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(audit.LOG_DIR, file), 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* skip malformed line */
        }
      }
    }
    entries.reverse();
    return { entries: entries.slice(0, 100) };
  },
};

// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);

  // Refuse anything that escapes the public directory.
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];

  if (!handler) return serveStatic(req, res);

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const token = req.headers['x-api-token'] || undefined;
    const result = await handler({
      query: url.searchParams, body, token, req, hosts: hostsFrom(req),
    });
    json(res, 200, result);
  } catch (err) {
    log.error(`${key} — ${err.message}`);
    json(res, 400, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log.heading('qa dashboard');
  log.ok(`http://${HOST}:${PORT}`);
  log.info(log.c.dim('Loopback only. Ctrl-C to stop.'));
});
