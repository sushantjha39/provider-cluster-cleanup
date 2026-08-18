'use strict';

const log = require('./logger');

/**
 * Thin client for the provider console API. Header set mirrors what the
 * console itself sends — the API rejects calls that omit the tenant/project
 * headers even when they are already in the URL.
 */
/** Thrown on 401/403 so callers can ask for a fresh token and resume. */
class TokenExpiredError extends Error {
  constructor(url, status) {
    super(
      `Token rejected (HTTP ${status}). These tokens last only 5 minutes — ` +
        'paste a fresh one and continue.'
    );
    this.name = 'TokenExpiredError';
    this.status = status;
    this.url = url;
    this.tokenExpired = true;
  }
}

class ApiClient {
  constructor(env) {
    this.baseUrl = String(env.baseUrl || '').replace(/\/+$/, '');
    this.token = env.token;
    this.cookie = env.cookie;
    this.region = env.region || 'r001';
    this.endpoints = env.endpoints || {};
    this.timeoutMs = env.timeoutMs || 30000;
    this.pageSize = env.pageSize || 100;
  }

  headers(scope = {}) {
    const headers = {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Authorization: `Bearer ${this.token}`,
      'CE-Region': this.region,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/compute/virtual-machines`,
    };
    // Some admin endpoints authenticate on the session cookie, not the bearer.
    if (this.cookie) headers.Cookie = this.cookie;
    if (scope.domain) headers['Organisation-Name'] = scope.domain;
    if (scope.project) {
      headers['External-Project'] = scope.project;
      headers['Project-Name'] = scope.project;
    }
    if (scope.projectId !== undefined && scope.projectId !== null) {
      headers['Project-ID'] = String(scope.projectId);
    }
    return headers;
  }

  url(pathOrUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.baseUrl}/${String(pathOrUrl).replace(/^\/+/, '')}`;
  }

  async request(method, pathOrUrl, { scope = {}, body } = {}) {
    const url = this.url(pathOrUrl);
    const headers = this.headers(scope);
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    log.debug(`${method} ${url}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`${method} ${url} timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`${method} ${url} failed: ${err.message}`);
    }
    clearTimeout(timer);

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    // Surface auth failures as a distinct error — with 5-minute tokens this is
    // the single most likely failure, and it needs a re-paste, not a retry.
    if (response.status === 401 || response.status === 403) {
      throw new TokenExpiredError(url, response.status);
    }

    return { ok: response.ok, status: response.status, data, raw: text, url };
  }

  /**
   * Walk a limit/offset paginated endpoint until it runs dry. The admin API
   * defaults to limit=10, so anything unpaginated silently truncates.
   */
  async getAll(pathOrUrl, { scope = {}, pageSize = this.pageSize, maxPages = 100 } = {}) {
    const collected = [];
    let offset = 0;
    let total = null;

    for (let page = 0; page < maxPages; page++) {
      const url = new URL(this.url(pathOrUrl));
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('offset', String(offset));

      const response = await this.get(url.toString(), { scope });
      if (!response.ok) return { ok: false, response, items: collected };

      const items = toList(response.data);
      collected.push(...items);

      if (total === null) {
        total = pick(response.data || {}, ['total', 'count', 'totalElements', 'total_count'], null);
        total = total === null ? null : Number(total);
      }

      // Stop on a short page, or once we've gathered everything the API claims.
      if (items.length < pageSize) break;
      if (total !== null && collected.length >= total) break;

      offset += pageSize;
    }

    return { ok: true, items: collected, total: total ?? collected.length };
  }

  /**
   * The equivalent curl command, for copying into a ticket or running by hand.
   * The token is masked unless `revealToken` is set.
   */
  toCurl(method, pathOrUrl, { scope = {}, revealToken = false } = {}) {
    const headers = this.headers(scope);
    if (!revealToken) headers.Authorization = 'Bearer $API_TOKEN';

    const parts = [`curl -sS -X ${method} '${this.url(pathOrUrl)}'`];
    for (const [key, value] of Object.entries(headers)) {
      parts.push(`  -H '${key}: ${value}'`);
    }
    return parts.join(' \\\n');
  }

  get(pathOrUrl, opts) {
    return this.request('GET', pathOrUrl, opts);
  }

  delete(pathOrUrl, opts) {
    return this.request('DELETE', pathOrUrl, opts);
  }
}

/**
 * Provider list responses are inconsistent — sometimes a bare array,
 * sometimes wrapped in data/results/items/content. Normalise to an array.
 */
function toList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of ['data', 'results', 'items', 'content', 'list', 'records']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    // One more level: { data: { results: [...] } }
    if (value && typeof value === 'object') {
      const nested = toList(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

/** Pull the first present key from an object, for tolerant field mapping. */
function pick(obj, keys, fallback = undefined) {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

/**
 * The admin API lives on a different host with its own token, so it gets its
 * own client rather than overloading the console one.
 */
function adminClient(env, overrides = {}) {
  const admin = env.admin || {};
  if (!admin.baseUrl) {
    throw new Error('No `admin.baseUrl` configured for this environment.');
  }
  return new ApiClient({
    baseUrl: admin.baseUrl,
    token: overrides.token || admin.token,
    cookie: overrides.cookie || admin.cookie,
    region: env.region,
    endpoints: admin.endpoints || {},
    pageSize: admin.pageSize || 100,
    timeoutMs: admin.timeoutMs,
  });
}

module.exports = { ApiClient, TokenExpiredError, adminClient, toList, pick };
