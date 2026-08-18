'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Pull the identifiers out of a kubeconfig that could plausibly match an
 * infra-cluster row in the DB. We return every candidate rather than guessing
 * one, because naming differs between the console, the provider and the DB.
 */
function parse(kubeconfigPath) {
  const file = path.resolve(kubeconfigPath);
  if (!fs.existsSync(file)) throw new Error(`Kubeconfig not found: ${file}`);
  return parseText(fs.readFileSync(file, 'utf8'), file);
}

/** Same as `parse` but for kubeconfig contents already in memory (web upload). */
function parseText(text, label = '(uploaded)') {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (err) {
    throw new Error(`Kubeconfig ${label} is not valid YAML: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error(`Kubeconfig ${label} is not valid YAML`);
  }

  const file = label;
  const clusters = doc.clusters || [];
  const contexts = doc.contexts || [];
  const users = doc.users || [];

  if (!clusters.length) {
    throw new Error(`Kubeconfig at ${file} has no clusters block`);
  }

  const currentContext = doc['current-context'] || null;
  const activeContext =
    contexts.find((ctx) => ctx.name === currentContext) || contexts[0] || null;

  const primary = activeContext
    ? clusters.find((cl) => cl.name === activeContext.context?.cluster) || clusters[0]
    : clusters[0];

  const server = primary.cluster?.server || null;

  // Candidates, most specific first. Duplicates and empties stripped, then
  // weak values dropped — these feed a delete query, so a bare number or an
  // IP octet must never become a match key.
  const candidates = [
    primary.name,
    activeContext?.context?.cluster,
    activeContext?.name,
    currentContext,
    users[0]?.name,
    ...deriveFromName(primary.name),
    ...(server ? deriveFromServer(server) : []),
  ]
    .filter((value, i, all) => value && all.indexOf(value) === i)
    .filter(isUsableCandidate);

  return {
    file,
    clusterName: primary.name,
    server,
    currentContext,
    contextNames: contexts.map((ctx) => ctx.name),
    candidates,
  };
}

/**
 * Cluster names follow `k8s-<tenant>-<clusterid>` — e.g.
 * "k8s-tn-zikwj3wzwu-dilr6g" is tenant `tn-zikwj3wzwu`, cluster `dilr6g`.
 * The tenant sits in the middle, so it has to be carved out explicitly: it is
 * what the infra-cluster `domain` field holds, and therefore the value the DB
 * lookup actually matches on.
 */
function deriveFromName(name) {
  if (!name) return [];
  const out = [];

  if (name.includes('@')) out.push(name.split('@').pop(), name.split('@')[0]);
  if (name.includes('/')) out.push(name.split('/').pop());

  // <service>-<tenant>-<6-char id> -> tenant, then the bare cluster id.
  // The service prefix varies: k8s- for kubernetes, dbaas- for database
  // clusters, and a tenant can own one of each.
  const parts = name.match(/^(?:k8s|dbaas|svc)-(.+)-([a-z0-9]{6})$/i);
  if (parts) {
    out.push(parts[1]); // tenant / domain — the primary match key
    out.push(parts[2]); // short cluster id
  } else {
    const shortId = name.match(/([a-z0-9]{6})$/i);
    if (shortId) out.push(shortId[1]);
  }

  // A tenant prefixed `tn-` is worth offering with and without the prefix.
  const tenant = parts?.[1];
  if (tenant && /^tn-/i.test(tenant)) out.push(tenant.replace(/^tn-/i, ''));

  return out;
}

/**
 * Reject identifiers too generic to match on: anything very short, purely
 * numeric, or an IP address. These would otherwise widen a delete query.
 */
function isUsableCandidate(value) {
  const text = String(value);
  if (text.length < 4) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^\d{1,3}(\.\d{1,3}){1,3}$/.test(text)) return false;
  return true;
}

/** A server URL like https://xn55t9.k8s.example.com:6443 leaks the cluster id. */
function deriveFromServer(server) {
  try {
    const host = new URL(server).hostname;
    const first = host.split('.')[0];
    return host === first ? [host] : [host, first];
  } catch {
    return [];
  }
}

module.exports = { parse, parseText };
