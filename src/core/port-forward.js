'use strict';

const { spawn, execFile } = require('child_process');
const net = require('net');
const log = require('./logger');

/**
 * Manages `kubectl port-forward` as a child process so the app can reach a
 * cluster-internal service (the Mongo replica-set pod) without the user
 * running the command by hand. The tunnel is always torn down in a finally
 * block — a leaked forward holds the local port and breaks the next run.
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

async function open(options = {}) {
  const {
    namespace,
    remotePort = 27017,
    localPort,
    kubeconfig,
    context,
    timeoutMs = 20000,
  } = options;

  const pod = resolvePodName(options);

  if (!pod) {
    throw new Error('portForward needs `pod`, or `podPattern` + `podIndex`.');
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
  const args = ['port-forward', `pods/${pod}`, `${port}:${remotePort}`, '-n', namespace];
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
      `kubectl port-forward pods/${pod} ${port}:${remotePort} -n ${namespace}`;
    const hint =
      `\n\nOpen the tunnel yourself and retry — the app reuses an existing one:\n  ${manual}` +
      `\n\nOr set db.portForward.kubeconfig in config.yaml (or KUBECONFIG in .env)` +
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
    const timer = setTimeout(() => {
      handle.close();
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

  log.debug(`port-forward ready on 127.0.0.1:${port} -> ${pod}:${remotePort}`);
  return handle;
}

/**
 * Run `fn` with a port-forward open, closing it afterwards no matter what.
 * When `enabled` is false the forward is skipped and the configured port is
 * used as-is, for when the tunnel is already open in another terminal.
 */
async function withForward(config, fn) {
  if (!config || config.enabled === false) {
    return fn({ port: config?.localPort, reused: true, close: async () => {} });
  }
  const handle = await open(config);
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

module.exports = { open, withForward, freePort, portInUse, which, resolvePodName };
