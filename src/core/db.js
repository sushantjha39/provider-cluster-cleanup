'use strict';

const log = require('./logger');

/**
 * Minimal DB wrapper over pg / mysql2 so tasks can speak one dialect-agnostic
 * API. Drivers are optional deps and loaded lazily — install only the one your
 * infra DB actually uses.
 */

function loadDriver(name) {
  try {
    return require(name);
  } catch {
    throw new Error(
      `Driver "${name}" is not installed. Run: npm install ${name}`
    );
  }
}

class Db {
  constructor(conn, driver) {
    this.conn = conn;
    this.driver = driver;
  }

  /** Positional placeholder for this dialect: $1.. for pg, ? for mysql. */
  ph(index) {
    return this.driver === 'postgres' ? `$${index}` : '?';
  }

  /** Quote an identifier so table/column names from config are safe to inline. */
  id(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Refusing to use unsafe identifier from config: "${name}"`);
    }
    return this.driver === 'postgres' ? `"${name}"` : `\`${name}\``;
  }

  async query(sql, params = []) {
    log.debug('SQL', sql, JSON.stringify(params));
    if (this.driver === 'postgres') {
      const result = await this.conn.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    }
    const [rows] = await this.conn.query(sql, params);
    return Array.isArray(rows)
      ? { rows, rowCount: rows.length }
      : { rows: [], rowCount: rows.affectedRows ?? 0 };
  }

  async begin() {
    await this.query(this.driver === 'postgres' ? 'BEGIN' : 'START TRANSACTION');
  }

  async commit() {
    await this.query('COMMIT');
  }

  async rollback() {
    await this.query('ROLLBACK');
  }

  async close() {
    if (this.driver === 'postgres') await this.conn.end();
    else await this.conn.end();
  }
}

async function connect(dbConfig) {
  if (!dbConfig) throw new Error('No `db` block configured for this environment.');

  const driver = (dbConfig.driver || 'postgres').toLowerCase();
  const common = {
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  };

  if (!common.host || !common.database) {
    throw new Error('db config needs at least `host` and `database`.');
  }

  log.debug(`connecting to ${driver}://${common.host}:${common.port}/${common.database}`);

  if (driver === 'postgres' || driver === 'postgresql' || driver === 'pg') {
    const { Client } = loadDriver('pg');
    const client = new Client({
      ...common,
      port: common.port || 5432,
      ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: dbConfig.timeoutMs || 15000,
    });
    await client.connect();
    return new Db(client, 'postgres');
  }

  if (driver === 'mysql' || driver === 'mariadb' || driver === 'mysql2') {
    const mysql = loadDriver('mysql2/promise');
    const conn = await mysql.createConnection({
      ...common,
      port: common.port || 3306,
      ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: dbConfig.timeoutMs || 15000,
    });
    return new Db(conn, 'mysql');
  }

  throw new Error(`Unsupported db driver "${driver}". Use postgres or mysql.`);
}

module.exports = { connect, Db };
