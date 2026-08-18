'use strict';

const { execFile } = require('child_process');
const log = require('./logger');

/**
 * Thin kubectl wrapper. Everything goes through execFile with an argv array —
 * never a shell string — so cluster/namespace/resource names coming from the
 * browser cannot be turned into shell injection.
 */

const DEFAULT_TIMEOUT = 30000;

function run(args, { kubeconfig, context, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const argv = [...args];
  if (context) argv.push('--context', context);
  if (kubeconfig) argv.push('--kubeconfig', kubeconfig);

  log.debug('kubectl', argv.join(' '));

  return new Promise((resolve, reject) => {
    execFile(
      'kubectl',
      argv,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim();
          if (err.killed) {
            return reject(new Error(`kubectl timed out after ${timeoutMs}ms: ${argv.join(' ')}`));
          }
          return reject(new Error(detail || `kubectl failed: ${argv.join(' ')}`));
        }
        resolve(String(stdout));
      }
    );
  });
}

async function runJson(args, opts) {
  const stdout = await run([...args, '-o', 'json'], opts);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('kubectl returned output that is not JSON');
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Compact age string (2d, 5h, 13m) from a creation timestamp. */
function age(timestamp) {
  if (!timestamp) return '-';
  const seconds = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 365) return `${Math.floor(days)}d`;
  return `${Math.floor(days / 365)}y`;
}

/**
 * Pod phase is not the whole story — a Running pod with a crash-looping
 * container should read CrashLoopBackOff, which is what kubectl itself shows.
 */
function podStatus(pod) {
  const statuses = pod.status?.containerStatuses || [];
  for (const container of statuses) {
    const waiting = container.state?.waiting;
    if (waiting?.reason) return waiting.reason;
    const terminated = container.state?.terminated;
    if (terminated?.reason && terminated.reason !== 'Completed') return terminated.reason;
  }
  if (pod.metadata?.deletionTimestamp) return 'Terminating';
  return pod.status?.phase || 'Unknown';
}

const KINDS = {
  pods: { arg: 'pods', namespaced: true },
  deployments: { arg: 'deployments', namespaced: true },
  statefulsets: { arg: 'statefulsets', namespaced: true },
  daemonsets: { arg: 'daemonsets', namespaced: true },
  services: { arg: 'services', namespaced: true },
  jobs: { arg: 'jobs', namespaced: true },
  cronjobs: { arg: 'cronjobs', namespaced: true },
  configmaps: { arg: 'configmaps', namespaced: true },
  secrets: { arg: 'secrets', namespaced: true },
  pvc: { arg: 'persistentvolumeclaims', namespaced: true },
  ingress: { arg: 'ingress', namespaced: true },
  events: { arg: 'events', namespaced: true },
  nodes: { arg: 'nodes', namespaced: false },
  namespaces: { arg: 'namespaces', namespaced: false },
};

/** Flatten one item into the columns the UI table shows for its kind. */
function summarise(kind, item) {
  const meta = item.metadata || {};
  const base = {
    name: meta.name,
    namespace: meta.namespace || '',
    age: age(meta.creationTimestamp),
  };

  switch (kind) {
    case 'pods': {
      const statuses = item.status?.containerStatuses || [];
      const ready = statuses.filter((c) => c.ready).length;
      return {
        ...base,
        status: podStatus(item),
        ready: `${ready}/${statuses.length || item.spec?.containers?.length || 0}`,
        restarts: statuses.reduce((sum, c) => sum + (c.restartCount || 0), 0),
        node: item.spec?.nodeName || '-',
        containers: (item.spec?.containers || []).map((c) => c.name),
      };
    }
    case 'deployments':
    case 'statefulsets':
      return {
        ...base,
        status: `${item.status?.readyReplicas || 0}/${item.spec?.replicas ?? 0}`,
        ready: `${item.status?.readyReplicas || 0}/${item.spec?.replicas ?? 0}`,
      };
    case 'daemonsets':
      return {
        ...base,
        status: `${item.status?.numberReady || 0}/${item.status?.desiredNumberScheduled || 0}`,
      };
    case 'services':
      return {
        ...base,
        status: item.spec?.type || '-',
        clusterIP: item.spec?.clusterIP || '-',
        ports: (item.spec?.ports || []).map((p) => `${p.port}/${p.protocol}`).join(', '),
      };
    case 'jobs':
      return { ...base, status: item.status?.succeeded ? 'Complete' : 'Active' };
    case 'cronjobs':
      return { ...base, status: item.spec?.schedule || '-' };
    case 'nodes': {
      const conditions = item.status?.conditions || [];
      const ready = conditions.find((c) => c.type === 'Ready');
      return {
        ...base,
        status: ready?.status === 'True' ? 'Ready' : 'NotReady',
        version: item.status?.nodeInfo?.kubeletVersion || '-',
      };
    }
    case 'namespaces':
      return { ...base, status: item.status?.phase || '-' };
    case 'events':
      return {
        ...base,
        name: item.involvedObject?.name || meta.name,
        status: item.type || '-',
        reason: item.reason || '-',
        message: item.message || '',
        age: age(item.lastTimestamp || item.eventTime || meta.creationTimestamp),
      };
    case 'pvc':
      return {
        ...base,
        status: item.status?.phase || '-',
        capacity: item.status?.capacity?.storage || '-',
      };
    default:
      return { ...base, status: '-' };
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function contexts(opts = {}) {
  const stdout = await run(['config', 'get-contexts', '-o', 'name'], opts);
  const current = await run(['config', 'current-context'], opts).catch(() => '');
  return {
    contexts: stdout.split('\n').map((s) => s.trim()).filter(Boolean),
    current: current.trim() || null,
  };
}

async function list(kind, { namespace, allNamespaces, ...opts } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unsupported resource kind "${kind}"`);

  const args = ['get', spec.arg];
  if (spec.namespaced) {
    if (allNamespaces || !namespace) args.push('--all-namespaces');
    else args.push('-n', namespace);
  }

  const payload = await runJson(args, opts);
  const items = payload.items || (payload.kind ? [payload] : []);

  const rows = items.map((item) => summarise(kind, item));

  // Events are far more useful newest-first; everything else reads better by name.
  if (kind === 'events') rows.reverse();
  else rows.sort((a, b) => (a.namespace + a.name).localeCompare(b.namespace + b.name));

  return { kind, count: rows.length, rows };
}

async function logs({ namespace, pod, container, tail = 500, previous = false, ...opts }) {
  if (!pod) throw new Error('pod is required');
  const args = ['logs', pod, '-n', namespace, `--tail=${Number(tail) || 500}`];
  if (container) args.push('-c', container);
  if (previous) args.push('--previous');
  return run(args, { ...opts, timeoutMs: 20000 });
}

async function manifest({ namespace, kind, name, ...opts }) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unsupported resource kind "${kind}"`);
  const args = ['get', spec.arg, name];
  if (spec.namespaced && namespace) args.push('-n', namespace);
  return runJson(args, opts);
}

async function describe({ namespace, kind, name, ...opts }) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unsupported resource kind "${kind}"`);
  const args = ['describe', spec.arg, name];
  if (spec.namespaced && namespace) args.push('-n', namespace);
  return run(args, opts);
}

/**
 * One-shot exec. The command runs through the *container's* shell, which is
 * the point of the tool — nothing is evaluated by a local shell.
 */
async function exec({ namespace, pod, container, command, timeoutMs = 30000, ...opts }) {
  if (!pod) throw new Error('pod is required');
  if (!command || !command.trim()) throw new Error('command is required');

  const args = ['exec', pod, '-n', namespace];
  if (container) args.push('-c', container);
  args.push('--', 'sh', '-c', command);

  return run(args, { ...opts, timeoutMs });
}

async function deleteResource({ namespace, kind, name, ...opts }) {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`Unsupported resource kind "${kind}"`);
  const args = ['delete', spec.arg, name];
  if (spec.namespaced && namespace) args.push('-n', namespace);
  return run(args, opts);
}

module.exports = { run, runJson, list, logs, manifest, describe, exec, deleteResource, contexts, KINDS, age, podStatus };
