'use strict';

const log = require('./logger');

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

  const base = String(auth.baseUrl || admin.baseUrl || '').replace(/\/+$/, '');
  if (!base) return null;

  const path = String(auth.tokenPath || DEFAULT_TOKEN_PATH)
    .replace(/\{realm\}/g, auth.realm || 'cloud');

  return base + (path.startsWith('/') ? path : `/${path}`);
}

/** Flatten the admin block into a ready-to-use auth config. */
function resolve(admin = {}) {
  const auth = admin.auth || {};
  return { ...auth, tokenUrl: resolveTokenUrl(admin) };
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

async function requestToken(auth) {
  const body = new URLSearchParams({
    username: auth.username,
    password: auth.password,
    client_id: auth.clientId,
    grant_type: auth.grantType || 'password',
  });
  if (auth.clientSecret) body.set('client_secret', auth.clientSecret);
  if (auth.scope) body.set('scope', auth.scope);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), auth.timeoutMs || 20000);

  let response;
  try {
    response = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Token request timed out.');
    throw new Error(`Token request failed: ${err.message}`);
  }
  clearTimeout(timer);

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep raw for the error path */
  }

  if (!response.ok) {
    const detail = data?.error_description || data?.error || text.slice(0, 200);
    throw new Error(`Could not get a token (HTTP ${response.status}): ${detail}`);
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
};
