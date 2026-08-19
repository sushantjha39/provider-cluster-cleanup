'use strict';

const { spawn, execFile } = require('child_process');
const net = require('net');
const log = require('./logger');

/**
 * Manages `kubectl port-forward` as a child process so the app can reach a
 * cluster-internal service (the Mongo replica-set pod, the Keycloak service)
 * without the user running the command by hand. The tunnel is always torn down
 * in a finally block — a leaked forward holds the local port and breaks the
 * next run.
 */

function which(cmd) {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

/** Ask the OS for a free port by binding to 0 and reading back the assignment. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 500 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Open a port-forward and resolve once kubectl reports it is listening.
 * Returns a handle with the chosen local port and a close().
 */
/**
 * Resolve the pod name. A replica set is addressed as
 * `compass-configdb-rs0-{index}`, so the index can be swapped without
 * restating the whole name.
 */
function resolvePodName(config = {}) {
  if (config.pod) return config.pod;
  if (config.podPattern) {
    const index = config.podIndex ?? 0;
    return String(config.podPattern).replace(/\{index\}/g, String(index));
  }
  return null;
}

/**
 * Resolve what to forward to. Pods stay addressable exactly as before;
 * services are how a cluster-internal hostname like `http://keycloak` is
 * reached, since that DNS name resolves inside the cluster and nowhere else.
 *
 *   service: keycloak       ->  svc/keycloak
 *   resource: svc/keycloak  ->  used verbatim (any target kubectl accepts)
 *   pod / podPattern        ->  pods/<name>
 */
function resolveTarget(config = {}) {
  if (config.resource) return String(config.resource);
  if (config.service) return `svc/${config.service}`;
  const pod = resolvePodName(config);
  return pod ? `pods/${pod}` : null;
}

/**
 * `enabled` usually arrives as a string, because it comes from a ${VAR}
 * expansion in config.yaml — and the string 'false' is truthy. Compare
 * textually so `enabled: ${AUTH_PORT_FORWARD:-true}` behaves as written.
 */
function isEnabled(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

/**
 * A silent timeout is usually not the forward's fault: kubectl prints nothing
 * while it dials an API server it cannot reach, so a dropped VPN looks exactly
 * like a bad port. Probe the server and return its complaint, so the message
 * names the real cause. `get --raw=/version` has to reach the server, unlike
 * `kubectl version`, which happily reports the client alone.
 */
function probeCluster({ kubeconfig, context } = {}) {
  const argv = ['get', '--raw=/version', '--request-timeout=5s'];
  if (context) argv.push('--context', context);
  if (kubeconfig) argv.push('--kubeconfig', kubeconfig);

  return new Promise((resolve) => {
    execFile('kubectl', argv, { timeout: 8000 }, (err, stdout, stderr) => {
      if (!err) return resolve(null);
      const detail = String(stderr || err.message)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^E\d{4}|memcache|Unhandled Error/.test(line))[0];
      resolve(detail || 'kubectl could not reach the cluster');
    });
  });
}

async function open(options = {}) {
  const {
    namespace,
    kubeconfig,
    context,
    timeoutMs = 20000,
  } = options;

  // Ports come out of config as strings after ${VAR} expansion.
  const remotePort = Number(options.remotePort) || 27017;
  const localPort = Number(options.localPort) || undefined;

  const target = resolveTarget(options);

  if (!target) {
    throw new Error(
      'portForward needs `service`, `resource`, `pod`, or `podPattern` + `podIndex`.'
    );
  }
  if (!namespace) throw new Error('portForward.namespace is required (e.g. uhc-dev)');

  // Reuse an existing tunnel rather than fighting it for the port. Checked
  // first so a manually-opened forward works even with no kubeconfig here.
  if (localPort && (await portInUse(localPort))) {
    log.debug(`port ${localPort} already open — reusing whatever is listening`);
    return { port: localPort, reused: true, close: async () => {} };
  }

  if (!(await which('kubectl'))) {
    throw new Error('kubectl is not on PATH — the port-forward cannot be opened.');
  }

  const port = localPort || (await freePort());
  const args = ['port-forward', target, `${port}:${remotePort}`, '-n', namespace];
  if (context) args.push('--context', context);
  if (kubeconfig) args.push('--kubeconfig', kubeconfig);

  log.debug('kubectl', args.join(' '));

  const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';

  const handle = {
    port,
    reused: false,
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        // Don't hang shutdown if kubectl ignores the signal.
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000).unref();
      }),
  };

  /**
   * kubectl's failure output is long and buries the cause. Translate the two
   * that actually happen into something actionable, and always include the
   * command to run by hand as a way out.
   */
  const explain = (raw) => {
    const manual =
      `kubectl port-forward ${target} ${port}:${remotePort} -n ${namespace}`;
    const hint =
      `\n\nOpen the tunnel yourself and retry — the app reuses an existing one:\n  ${manual}` +
      `\n\nOr set the block's portForward.kubeconfig in config.yaml (or KUBECONFIG in .env)` +
      ` to a kubeconfig for the cluster hosting namespace "${namespace}".`;

    // No kubeconfig at all: kubectl falls back to localhost:8080.
    if (/localhost:8080|:8080.*(refused|connection)/i.test(raw)) {
      return `kubectl has no kubeconfig for namespace "${namespace}", so it fell back to localhost:8080.${hint}`;
    }
    if (/asked for the client to provide credentials|Unauthorized|x509|expired/i.test(raw)) {
      return `kubectl reached the cluster but the credentials were rejected (expired kubeconfig?).${hint}`;
    }
    const first = String(raw).split('\n').map((l) => l.trim())
      .filter((l) => l && !/^E\d{4}|memcache|Unhandled Error/.test(l))[0];
    return `kubectl port-forward failed: ${first || 'unknown error'}${hint}`;
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      handle.close();

      // kubectl said nothing at all: ask the API server whether it is even
      // reachable before blaming the forward.
      const unreachable = stderr ? null : await probeCluster({ kubeconfig, context });
      if (unreachable) {
        return reject(
          new Error(
            `Cannot reach the cluster API server, so the tunnel never opened: ${unreachable}` +
              `\n\nCheck the VPN and that this kubeconfig points at a live cluster, then retry.`
          )
        );
      }

      reject(new Error(explain(stderr || `timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    const settleOk = () => {
      clearTimeout(timer);
      resolve();
    };
    const settleErr = (message) => {
      clearTimeout(timer);
      handle.close();
      reject(new Error(message));
    };

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      log.debug('kubectl:', text.trim());
      if (text.includes('Forwarding from')) settleOk();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const text = String(chunk);
      // kubectl reports some routine noise on stderr; only fail on real errors.
      if (/unable to listen|error:|Error from server|not found|refused|credentials/i.test(text)) {
        settleErr(explain(stderr));
      }
    });

    child.on('error', (err) => settleErr(`Could not run kubectl: ${err.message}`));
    child.on('exit', (code) => {
      if (code !== 0) settleErr(explain(stderr || `kubectl exited with code ${code}`));
    });
  });

  log.debug(`port-forward ready on 127.0.0.1:${port} -> ${target}:${remotePort}`);
  return handle;
}

/**
 * Run `fn` with a port-forward open, closing it afterwards no matter what.
 * When `enabled` is false the forward is skipped and the configured port is
 * used as-is, for when the tunnel is already open in another terminal.
 */
async function withForward(config, fn) {
  if (!config || !isEnabled(config.enabled)) {
    return fn({ port: config?.localPort, reused: true, close: async () => {} });
  }
  const handle = await open(config);
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

module.exports = {
  open, withForward, freePort, portInUse, which, resolvePodName, resolveTarget, isEnabled,
  probeCluster,
};
