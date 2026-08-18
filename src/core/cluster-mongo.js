'use strict';

/**
 * Infra-cluster operations against MongoDB. Mirrors the shape of
 * cluster-service.js (the SQL path) so callers can stay backend-agnostic.
 *
 * One deliberate difference: Mongo dry-runs COUNT rather than
 * delete-then-rollback. A rollback needs a multi-document transaction, and
 * counting is both cheaper and impossible to get wrong.
 */

function requireSpec(env) {
  const spec = env.db?.infraCluster;
  if (!spec?.collection) {
    throw new Error('Missing `db.infraCluster.collection` in config.yaml for this environment.');
  }
  if (!spec.matchFields?.length) {
    throw new Error('Missing `db.infraCluster.matchFields` in config.yaml.');
  }
  return spec;
}

/**
 * Candidate strings may correspond to an _id, so try to coerce each into an
 * ObjectId as well as matching it literally.
 */
function idVariants(value) {
  const out = [value];
  try {
    const { ObjectId } = require('mongodb');
    if (ObjectId.isValid(value) && String(new ObjectId(value)) === String(value)) {
      out.push(new ObjectId(value));
    }
  } catch {
    /* driver missing or not a valid id — literal match is enough */
  }
  return out;
}

function matchQuery(spec, candidates) {
  const clauses = [];
  for (const field of spec.matchFields) {
    const values = candidates.flatMap((c) => (field === '_id' ? idVariants(c) : [c]));
    clauses.push({ [field]: { $in: values } });
  }
  return { $or: clauses };
}

async function findClusters(handle, spec, candidates) {
  if (!candidates.length) return [];
  return handle.db
    .collection(spec.collection)
    .find(matchQuery(spec, candidates))
    .limit(spec.maxMatches || 25)
    .toArray();
}

async function findById(handle, spec, clusterId) {
  const collection = handle.db.collection(spec.collection);
  for (const variant of idVariants(clusterId)) {
    const found = await collection.findOne({ _id: variant });
    if (found) return found;
  }
  return null;
}

/** Value used to link child documents back to the cluster. */
function linkValue(spec, cluster, rel) {
  const sourceField = rel.parentField || spec.primaryKey || '_id';
  return cluster[sourceField];
}

async function countRelated(handle, spec, cluster) {
  const counts = [];
  for (const rel of spec.related || []) {
    const value = linkValue(spec, cluster, rel);
    const count =
      value === undefined
        ? 0
        : await handle.db
            .collection(rel.collection)
            .countDocuments({ [rel.field]: { $in: idVariants(value) } });
    counts.push({ table: rel.collection, fk: rel.field, count });
  }
  return counts;
}

async function deleteCluster(handle, spec, cluster, { dryRun = false } = {}) {
  const pk = spec.primaryKey || '_id';
  const clusterId = cluster[pk];
  if (clusterId === undefined) {
    throw new Error(`Field "${pk}" is not present on the matched document.`);
  }

  const removed = [];

  // Children first, so a failure part-way never orphans them.
  for (const rel of spec.related || []) {
    const value = linkValue(spec, cluster, rel);
    const collection = handle.db.collection(rel.collection);
    const filter = { [rel.field]: { $in: idVariants(value) } };

    if (value === undefined) {
      removed.push({ table: rel.collection, rows: 0 });
      continue;
    }

    const rows = dryRun
      ? await collection.countDocuments(filter)
      : (await collection.deleteMany(filter)).deletedCount;
    removed.push({ table: rel.collection, rows });
  }

  const collection = handle.db.collection(spec.collection);
  const filter = { _id: cluster._id };
  const rows = dryRun
    ? await collection.countDocuments(filter)
    : (await collection.deleteOne(filter)).deletedCount;
  removed.push({ table: spec.collection, rows });

  return { removed, committed: !dryRun };
}

module.exports = { requireSpec, findClusters, findById, countRelated, deleteCluster };
