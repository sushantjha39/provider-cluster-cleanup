'use strict';

const log = require('../core/logger');
const { ApiClient, toList } = require('../core/http');

function describe(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value !== 'object') return typeof value;
  if (depth > 0) return `object{${Object.keys(value).slice(0, 8).join(', ')}}`;
  return 'object';
}

module.exports = {
  name: 'api:probe',
  summary: 'GET any console API path with the right auth headers and show its shape',
  destructive: false,
  usage: [
    'qa api:probe /api/v2.1/computes/domain/tn-zikwj3wzwu/project/default-project/computes/ --domain tn-zikwj3wzwu --project default-project --project-id 148',
    'qa api:probe /api/v2.1/domains/',
  ],

  async run(ctx) {
    const { env, args } = ctx;
    const path = args._[0];

    if (!path) throw new Error('Usage: qa api:probe <path> [--domain … --project … --project-id …]');
    if (!env.token) throw new Error('No API token. Export API_TOKEN or set it in .env');

    const api = new ApiClient(env);
    const scope = {
      domain: args.domain,
      project: args.project,
      projectId: args.projectId,
    };

    const response = await api.get(path, { scope });

    log.heading(`${response.status} ${response.url}`);

    if (!response.ok) {
      log.error('Request failed.');
      log.info(String(response.raw || '').slice(0, 1000));
      process.exitCode = 1;
      return response;
    }

    const list = toList(response.data);
    if (list.length) {
      log.ok(`Looks like a list of ${list.length} item(s). First item's fields:`);
      const sample = list[0];
      if (sample && typeof sample === 'object') {
        const rows = Object.entries(sample).map(([key, value]) => ({
          field: key,
          type: describe(value, 1),
          sample: String(
            value && typeof value === 'object' ? '' : value
          ).slice(0, 48),
        }));
        log.table(rows, [
          { key: 'field', label: 'FIELD' },
          { key: 'type', label: 'TYPE' },
          { key: 'sample', label: 'SAMPLE' },
        ]);
      } else {
        log.info(JSON.stringify(list.slice(0, 5), null, 2));
      }
    } else {
      log.info('Top-level keys: ' + Object.keys(response.data || {}).join(', '));
      log.blank();
      log.info(JSON.stringify(response.data, null, 2).slice(0, 2000));
    }

    return response;
  },
};
