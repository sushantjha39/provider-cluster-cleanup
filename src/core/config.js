'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Expand ${VAR} and ${VAR:-default} against process.env, so hosts and realms
 * can be overridden per environment without editing config.yaml, and
 * credentials stay in .env. Unset vars with no default resolve to '' rather
 * than throwing, because most tasks only need a subset of the config.
 */
function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g,
      (_, name, fallback) => {
        const found = process.env[name];
        if (found !== undefined && found !== '') return found;
        return fallback !== undefined ? fallback : '';
      }
    );
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

function load(configPath) {
  const file = path.isAbsolute(configPath || '')
    ? configPath
    : path.resolve(ROOT, configPath || 'config.yaml');

  if (!fs.existsSync(file)) {
    throw new Error(
      `No config found at ${file}\n  Run: cp config.example.yaml config.yaml`
    );
  }
  return expandEnv(yaml.load(fs.readFileSync(file, 'utf8')) || {});
}

/** Pick one environment block out of the config (dev / staging / ...). */
function resolveEnv(config, name) {
  const envName = name || config.defaultEnv;
  const environments = config.environments || {};

  if (!envName) throw new Error('No environment given and no `defaultEnv` in config.');

  const env = environments[envName];
  if (!env) {
    const known = Object.keys(environments).join(', ') || '(none configured)';
    throw new Error(`Unknown environment "${envName}". Available: ${known}`);
  }
  return { name: envName, ...env };
}

/** Fill {placeholders} in an endpoint template. */
function template(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (match, key) => {
    if (vars[key] === undefined || vars[key] === null) {
      throw new Error(`Endpoint template "${str}" needs {${key}} but it was not provided`);
    }
    return encodeURIComponent(vars[key]);
  });
}

module.exports = { load, resolveEnv, template, ROOT };
