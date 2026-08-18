'use strict';

const sqlDb = require('./db');
const sqlOps = require('./cluster-service');
const mongo = require('./mongo');
const mongoOps = require('./cluster-mongo');
const portForward = require('./port-forward');

/**
 * Picks the infra-cluster backend from config and hands the caller an open
 * connection plus a matching operations module. Mongo runs inside a kubectl
 * port-forward that is opened and torn down around the callback, so nothing
 * has to be tunnelled by hand beforehand.
 *
 * `fn` receives { handle, ops, spec, label } and its return value is passed
 * straight through.
 */
async function withCluster(env, fn) {
  const dbConfig = env.db;
  if (!dbConfig) throw new Error('No `db` block configured for this environment.');

  const driver = String(dbConfig.driver || 'postgres').toLowerCase();

  if (driver === 'mongodb' || driver === 'mongo') {
    const spec = mongoOps.requireSpec(env);

    return portForward.withForward(dbConfig.portForward, async (forward) => {
      const port = forward.port || dbConfig.port || 27017;
      const handle = await mongo.connect(dbConfig, port);
      try {
        // Surface secondary-vs-primary before any write is attempted.
        const role = await mongo.memberRole(handle);
        const podIndex = dbConfig.portForward?.podIndex;

        return await fn({
          handle,
          ops: mongoOps,
          spec,
          driver: 'mongodb',
          label: `${dbConfig.database} @ ${handle.uri}`,
          forward,
          role,
          podIndex,
          notPrimaryHint: () => mongo.notPrimaryHint(role, podIndex),
        });
      } finally {
        await handle.close();
      }
    });
  }

  const spec = sqlOps.requireSpec(env);
  const handle = await sqlDb.connect(dbConfig);
  try {
    return await fn({
      handle,
      ops: sqlOps,
      spec,
      driver,
      label: `${dbConfig.host}/${dbConfig.database}`,
    });
  } finally {
    await handle.close();
  }
}

/** Field/column list used to render a matched record. */
function displayFields(spec, sample) {
  const configured = spec.displayFields || spec.displayColumns;
  if (configured?.length) return configured;
  return sample ? Object.keys(sample).slice(0, 6) : [];
}

/** Collection or table name, whichever this backend uses. */
function containerName(spec) {
  return spec.collection || spec.table;
}

/** Mongo values (ObjectId, Date, nested docs) must be flattened for JSON. */
function presentable(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return value.toHexString();
    return JSON.stringify(value);
  }
  return value;
}

module.exports = { withCluster, displayFields, containerName, presentable };
