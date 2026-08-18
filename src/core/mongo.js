'use strict';

const log = require('./logger');

/**
 * Mongo access for the infra config DB. The connection normally runs through a
 * kubectl port-forward, so the URI carries a {port} placeholder filled in with
 * whatever local port the tunnel actually got.
 */

function loadDriver() {
  try {
    return require('mongodb');
  } catch {
    throw new Error('The mongodb driver is not installed. Run: npm install mongodb');
  }
}

/**
 * Credentials must be percent-encoded — Mongo passwords routinely contain
 * `@`, `/` and `:`, any of which silently corrupt the URI if pasted in raw.
 * Keep `user`/`password` as separate config fields and let this build the
 * userinfo section, rather than interpolating them into a `uri` string.
 */
function credentials(dbConfig) {
  if (!dbConfig.user) return '';
  const user = encodeURIComponent(dbConfig.user);
  const password = dbConfig.password ? `:${encodeURIComponent(dbConfig.password)}` : '';
  return `${user}${password}@`;
}

function buildUri(dbConfig, port) {
  if (dbConfig.uri) {
    const uri = String(dbConfig.uri).replace(/\{port\}/g, String(port));
    const auth = credentials(dbConfig);
    // Only inject when the URI has no userinfo of its own.
    if (!auth || /^mongodb(\+srv)?:\/\/[^@/]*@/.test(uri)) return uri;
    return uri.replace(/^(mongodb(?:\+srv)?:\/\/)/, `$1${auth}`);
  }

  const host = dbConfig.host || '127.0.0.1';
  const auth = credentials(dbConfig);

  const params = new URLSearchParams({ directConnection: 'true' });
  if (dbConfig.authSource) params.set('authSource', dbConfig.authSource);
  if (dbConfig.replicaSet) params.set('replicaSet', dbConfig.replicaSet);
  if (dbConfig.tls) params.set('tls', 'true');

  return `mongodb://${auth}${host}:${port}/?${params}`;
}

/** Mask credentials so a URI can be shown in the UI or a log line. */
function safeUri(uri) {
  return String(uri).replace(/\/\/[^@/]*@/, '//***:***@');
}

async function connect(dbConfig, port) {
  const { MongoClient } = loadDriver();
  const uri = buildUri(dbConfig, port);

  log.debug('mongo connect', safeUri(uri));

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: dbConfig.timeoutMs || 10000,
    connectTimeoutMS: dbConfig.timeoutMs || 10000,
  });

  await client.connect();

  if (!dbConfig.database) {
    await client.close();
    throw new Error('db.database is required for mongodb (the config DB name).');
  }

  return {
    client,
    db: client.db(dbConfig.database),
    uri: safeUri(uri),
    close: () => client.close(),
  };
}

/**
 * Which replica-set member did we land on? Deletes only work on the PRIMARY,
 * so this is checked up front to fail with a useful message instead of a raw
 * "not primary" error partway through.
 */
async function memberRole(handle) {
  try {
    const info = await handle.client.db('admin').command({ hello: 1 });
    return {
      isPrimary: Boolean(info.isWritablePrimary ?? info.ismaster),
      setName: info.setName || null,
      primary: info.primary || null,
      me: info.me || null,
    };
  } catch (err) {
    // Older servers, or a user without the privilege — don't block on it.
    return { isPrimary: null, error: err.message };
  }
}

/** Human-readable explanation for a "not primary" write failure. */
function notPrimaryHint(role, podIndex) {
  const target = role?.primary ? ` The primary reports itself as ${role.primary}.` : '';
  const other = [0, 1, 2].filter((i) => i !== Number(podIndex)).join(' or ');
  return (
    'This replica-set member is a SECONDARY, which cannot accept deletes.' +
    target +
    ` Switch the pod index to ${other} and retry.`
  );
}

/** List database and collection names, to help fill in config. */
async function inventory(handle) {
  const admin = handle.client.db().admin();
  const { databases } = await admin.listDatabases();
  const collections = await handle.db.listCollections().toArray();
  return {
    databases: databases.map((d) => d.name),
    collections: collections.map((c) => c.name),
  };
}

module.exports = {
  connect, inventory, buildUri, safeUri, loadDriver, memberRole, notPrimaryHint,
};
