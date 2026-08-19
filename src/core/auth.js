'use strict';

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const path = require('path');
const log = require('./logger');
const portForward = require('./port-forward');
const { ROOT } = require('./config');
const kubeconfigStore = require('./kubeconfig-store');

/**
 * Fetches admin tokens from Keycloak with the password grant.
 *
 * These tokens live ~5 minutes, which makes pasting them by hand painful and
 * makes any longer operation fail midway. Minting them on demand and caching
 * until just before expiry removes that entirely — a long delete run simply
 * picks up a fresh token when the old one ages out.
 */

// key -> { token, expiresAt }
const cache = new Map();

// Renew this far before actual expiry so an in-flight request cannot age out.
const SAFETY_MARGIN_MS = 45000;

const DEFAULT_TOKEN_PATH = '/auth/realms/{realm}/protocol/openid-connect/token';

/** Join a host with the realm-substituted token path. */
function assemble(baseUrl, auth = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return null;

  const path = String(auth.tokenPath || DEFAULT_TOKEN_PATH)
    .replace(/\{realm\}/g, auth.realm || 'cloud');

  return base + (path.startsWith('/') ? path : `/${path}`);
}

/**
 * Work out the token endpoint. The host is configurable independently of the
 * admin API host, since some deployments front Keycloak separately:
 *
 *   auth.tokenUrl                  full URL, wins outright
 *   auth.baseUrl + realm/tokenPath assembled
 *   admin.baseUrl + realm/tokenPath assembled (default)
 */
function resolveTokenUrl(admin = {}) {
  const auth = admin.auth || {};
  if (auth.tokenUrl) return auth.tokenUrl;
  return assemble(auth.baseUrl || admin.baseUrl, auth);
}

/**
 * Second endpoint to try when the first one cannot be reached. The in-cluster
 * Keycloak needs a tunnel and a working kubeconfig; when neither is available
 * (off VPN, no kubectl) a publicly-routable host keeps minting working instead
 * of failing the whole run.
 */
function resolveFallbackUrl(admin = {}) {
  const auth = admin.auth || {};
  if (auth.fallbackTokenUrl) return auth.fallbackTokenUrl;
  return assemble(auth.fallbackBaseUrl, auth);
}

/** Flatten the admin block into a ready-to-use auth config. */
function resolve(admin = {}) {
  const auth = admin.auth || {};
  return {
    ...auth,
    tokenUrl: resolveTokenUrl(admin),
    fallbackUrl: resolveFallbackUrl(admin),
  };
}

function cacheKey(auth) {
  return `${auth.tokenUrl}|${auth.clientId}|${auth.username}`;
}

/** Names of the settings still missing before a token can be minted. */
function describe(admin) {
  const auth = resolve(admin);
  const missing = [];
  if (!auth.tokenUrl) missing.push('tokenUrl (or baseUrl)');
  if (!auth.clientId) missing.push('clientId');
  if (!auth.username) missing.push('username');
  if (!auth.password) missing.push('password');
  return missing;
}

/** True when this environment can mint its own tokens. */
function canMint(admin) {
  return describe(admin).length === 0;
}

/**
 * Rewrite the endpoint to point at the local end of a tunnel, keeping the path
 * (and therefore the realm) intact.
 *
 * The original hostname has to travel along as the Host header: this Keycloak
 * derives the issuer from it, so posting to 127.0.0.1 without it mints tokens
 * stamped `iss: http://127.0.0.1:9099/...`, which any API that validates the
 * issuer will reject. With it, `iss` reads http://keycloak/... exactly as it
 * does for the same request run inside a pod.
 */
function tunnelledUrl(tokenUrl, port, scheme) {
  const url = new URL(tokenUrl);
  const hostHeader = url.host;
  url.protocol = `${scheme || 'http'}:`;
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return { url: url.toString(), hostHeader };
}

/**
 * Which kubeconfig kubectl should use for the tunnel.
 *
 * The ambient default is often unusable here — a laptop's ~/.kube/config can
 * hold no contexts at all — while the kubeconfig uploaded through the UI for
 * the DB cleanup points at exactly the right cluster. So fall back to the most
 * recently stored one rather than failing with kubectl's "NotFound".
 */
function resolveKubeconfig(pf = {}) {
  if (pf.kubeconfig) return path.resolve(ROOT, String(pf.kubeconfig));
  if (pf.kubeconfigId) return kubeconfigStore.pathFor(pf.kubeconfigId);

  const [newest] = kubeconfigStore.list();
  if (!newest) return undefined;

  log.debug(`no auth kubeconfig set — using stored "${newest.label}" (${newest.id})`);
  return kubeconfigStore.pathFor(newest.id);
}

/**
 * POST the form with node:http instead of fetch. fetch cannot do this job:
 * `Host` is a forbidden request header there, so it is silently dropped — and
 * the tunnelled request depends on that header to get the issuer right.
 */
function postForm(url, body, { hostHeader, timeoutMs = 20000 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  };
  if (hostHeader) headers.Host = hostHeader;

  return new Promise((resolve, reject) => {
    const request = transport.request(target, { method: 'POST', headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Token request timed out.'));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function postToken(url, auth, hostHeader) {
  const body = new URLSearchParams({
    username: auth.username,
    password: auth.password,
    client_id: auth.clientId,
    grant_type: auth.grantType || 'password',
  });
  if (auth.clientSecret) body.set('client_secret', auth.clientSecret);
  if (auth.scope) body.set('scope', auth.scope);

  let response;
  try {
    response = await postForm(url, body.toString(), {
      hostHeader,
      timeoutMs: auth.timeoutMs || 20000,
    });
  } catch (err) {
    if (/timed out/i.test(err.message)) throw new Error('Token request timed out.');
    throw new Error(`Token request failed: ${err.message}`);
  }

  const { status, text } = response;
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep raw for the error path */
  }

  if (status < 200 || status >= 300) {
    const detail = data?.error_description || data?.error || text.slice(0, 200);
    throw new Error(`Could not get a token (HTTP ${status}): ${detail}`);
  }
  if (!data?.access_token) {
    throw new Error('Token response had no access_token.');
  }

  return {
    token: data.access_token,
    expiresIn: Number(data.expires_in) || 300,
  };
}

/**
 * Mint a token, opening a kubectl port-forward first when the Keycloak host is
 * only reachable from inside the cluster.
 *
 * `http://keycloak` is a Service DNS name — it resolves in a pod and nowhere
 * else, which is why the equivalent wget works from a pod and fails from a
 * laptop. So forward to svc/keycloak the same way the Mongo cleanup forwards
 * to the config-DB pod, post through it, and tear it down afterwards.
 */
/**
 * True when the hostname resolves here — which is the case for the Service
 * name once this tool runs *inside* the cluster (Helm chart, k8s Job). There
 * the tunnel is both unnecessary and impossible, since kubectl is not in the
 * image, so the same config has to work either way.
 */
async function hostResolves(hostname) {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

async function requestToken(auth) {
  const pf = auth.portForward;
  const viaTunnel = pf && portForward.isEnabled(pf.enabled, false);

  if (!viaTunnel) return postToken(auth.tokenUrl, auth);

  const hostname = new URL(auth.tokenUrl).hostname;
  if (await hostResolves(hostname)) {
    log.debug(`${hostname} resolves here — posting directly, no tunnel needed`);
    return postToken(auth.tokenUrl, auth);
  }

  // Keycloak's service port, not Mongo's — open() defaults to 27017.
  const forward = { remotePort: 80, ...pf, kubeconfig: resolveKubeconfig(pf) };

  try {
    return await portForward.withForward(forward, ({ port }) => {
      const { url, hostHeader } = tunnelledUrl(auth.tokenUrl, port, pf.scheme);
      log.debug(`minting via tunnel ${url} (Host: ${hostHeader})`);
      return postToken(url, auth, hostHeader);
    });
  } catch (err) {
    if (!auth.fallbackUrl) throw err;
    log.debug(`tunnelled mint failed (${err.message}); trying ${auth.fallbackUrl}`);
    try {
      return await postToken(auth.fallbackUrl, auth);
    } catch (fallbackErr) {
      // Report both, since the tunnel error is usually the actionable one.
      throw new Error(`${err.message}\n  Fallback host also failed: ${fallbackErr.message}`);
    }
  }
}

/**
 * Return a valid access token, minting a new one only when the cached one is
 * missing or close to expiry. `force` bypasses the cache.
 */
async function getToken(admin, { force = false } = {}) {
  const missing = describe(admin);
  if (missing.length) {
    throw new Error(`Cannot mint a token — missing admin.auth: ${missing.join(', ')}`);
  }

  const auth = resolve(admin);
  const key = cacheKey(auth);
  const cached = cache.get(key);

  if (!force && cached && cached.expiresAt - SAFETY_MARGIN_MS > Date.now()) {
    log.debug(`reusing cached token (${Math.round((cached.expiresAt - Date.now()) / 1000)}s left)`);
    return cached.token;
  }

  const { token, expiresIn } = await requestToken(auth);
  cache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  log.debug(`minted a fresh token, valid ${expiresIn}s`);
  return token;
}

/** Seconds until the cached token expires, or null when nothing is cached. */
function secondsLeft(admin) {
  const cached = cache.get(cacheKey(resolve(admin)));
  if (!cached) return null;
  return Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000));
}

function clear() {
  cache.clear();
}

module.exports = {
  getToken, canMint, secondsLeft, clear, describe, resolve, resolveTokenUrl,
  resolveFallbackUrl,
};
