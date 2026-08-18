'use strict';

/**
 * DB-side operations for infra cluster rows. No prompting or printing here so
 * the CLI task and the web server can share exactly the same behaviour.
 */

function requireSpec(env) {
  const spec = env.db?.infraCluster;
  if (!spec?.table) {
    throw new Error('Missing `db.infraCluster.table` in config.yaml for this environment.');
  }
  if (!spec.matchColumns?.length) {
    throw new Error('Missing `db.infraCluster.matchColumns` in config.yaml.');
  }
  return spec;
}

/**
 * Build `WHERE (col IN (…)) OR (col2 IN (…))` with one bound placeholder per
 * value, so identifiers taken from a kubeconfig never reach the SQL string.
 */
function buildMatchClause(handle, columns, values) {
  const params = [];
  const clauses = columns.map((column) => {
    const slots = values.map((value) => {
      params.push(value);
      return handle.ph(params.length);
    });
    return `${handle.id(column)} IN (${slots.join(', ')})`;
  });
  return { where: clauses.join(' OR '), params };
}

async function findClusters(handle, spec, candidates) {
  if (!candidates.length) return [];
  const { where, params } = buildMatchClause(handle, spec.matchColumns, candidates);
  const { rows } = await handle.query(
    `SELECT * FROM ${handle.id(spec.table)} WHERE ${where}`,
    params
  );
  return rows;
}

/** Re-read one cluster row by primary key. The web UI deletes by id, not by row. */
async function findById(handle, spec, clusterId) {
  const pk = spec.primaryKey || 'id';
  const { rows } = await handle.query(
    `SELECT * FROM ${handle.id(spec.table)} WHERE ${handle.id(pk)} = ${handle.ph(1)}`,
    [clusterId]
  );
  return rows[0] || null;
}

async function countRelated(handle, spec, cluster) {
  const clusterId = cluster[spec.primaryKey || 'id'];
  const counts = [];
  for (const rel of spec.related || []) {
    const { rows } = await handle.query(
      `SELECT COUNT(*) AS n FROM ${handle.id(rel.table)} WHERE ${handle.id(rel.fk)} = ${handle.ph(1)}`,
      [clusterId]
    );
    counts.push({
      table: rel.table,
      fk: rel.fk,
      count: Number(rows[0]?.n ?? rows[0]?.count ?? 0),
    });
  }
  return counts;
}

/**
 * Delete the cluster and its children inside one transaction. When `dryRun` is
 * set the deletes still run and are then rolled back, so reported row counts
 * are exact rather than estimated.
 */
async function deleteCluster(handle, spec, cluster, { dryRun = false } = {}) {
  const pk = spec.primaryKey || 'id';
  const clusterId = cluster[pk];

  if (clusterId === undefined) {
    throw new Error(
      `Primary key "${pk}" is not present on the matched row. Set db.infraCluster.primaryKey.`
    );
  }

  await handle.begin();
  try {
    const removed = [];

    // Children first — their FKs point at the cluster row.
    for (const rel of spec.related || []) {
      const { rowCount } = await handle.query(
        `DELETE FROM ${handle.id(rel.table)} WHERE ${handle.id(rel.fk)} = ${handle.ph(1)}`,
        [clusterId]
      );
      removed.push({ table: rel.table, rows: rowCount });
    }

    const { rowCount } = await handle.query(
      `DELETE FROM ${handle.id(spec.table)} WHERE ${handle.id(pk)} = ${handle.ph(1)}`,
      [clusterId]
    );
    removed.push({ table: spec.table, rows: rowCount });

    if (dryRun) await handle.rollback();
    else await handle.commit();

    return { removed, committed: !dryRun };
  } catch (err) {
    await handle.rollback();
    throw new Error(`Delete failed, transaction rolled back: ${err.message}`);
  }
}

module.exports = { requireSpec, findClusters, findById, countRelated, deleteCluster };
