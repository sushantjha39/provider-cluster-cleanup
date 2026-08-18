# provider-cluster-cleanup

Cleans up a tenant's provider clusters: deletes its VMs through the admin API,
and removes its `infra-cluster` entries from the `ccp-ext-config` database.

Replaces the hand-edited `delete45.sh` — no more pasting UUIDs into a bash
array, and no more running `kubectl port-forward` before touching Mongo.

Ships as a local web UI (`npm start`) and a CLI (`npm run cli`) over the same
core, so both behave identically.

## Setup

```bash
npm install
cp .env.example .env            # API_TOKEN + DB credentials
cp config.example.yaml config.yaml
```

Then run it — web UI or CLI, both driving the same code:

```bash
npm start                       # web UI on http://127.0.0.1:4300
npm run cli                     # interactive menu in the terminal
npm run cli -- vm:delete --dry-run
```

## Web UI

`npm start` serves a dashboard bound to **127.0.0.1 only** — it can delete
infrastructure and holds DB credentials, so it is never exposed to the network.

Three tabs:

- **VM Cleanup** — pick domain → project → filter by regex → tick the VMs →
  delete. Dry run is on by default.
- **Cluster DB Cleanup** — drop a kubeconfig on the page (or paste it, or type
  a cluster name). It shows the matched row and the exact child-row counts
  before anything is removed.
- **Audit Log** — every destructive action from the last 7 days, CLI and web
  alike.

Paste your admin token into the header field. It is held in `sessionStorage`
and sent per-request as `x-api-token`, so it never lands on disk and disappears
when you close the tab. `API_TOKEN` in `.env` works as a fallback if you'd
rather not paste it each time.

## Tasks

### `vm:delete` — delete provider VMs

Walks you through it instead of asking for IDs up front:

1. pick a **domain** (from the API, or the fallback list in config)
2. pick a **project** (name + Project-ID resolved for you)
3. pick **VMs** from the live list — `1,3,5-8`, `all`, or `none`
4. review the table, retype the confirm phrase, watch them go

```bash
qa vm:delete
qa vm:delete --filter "^k8s-.*-xn55t9-" --dry-run
qa vm:delete --filter "^k8s-.*-xn55t9-" --dry-run --curl   # print curl instead
qa vm:delete --domain tn-zikwj3wzwu --project default-project --project-id 148 -y
```

`--filter` takes a regex against the VM name, which is the fast way to grab
every node of one cluster. `--curl` prints the exact equivalent command (token
masked as `$API_TOKEN`) for pasting into a ticket or running by hand.

### `cluster:db-cleanup` — remove an infra cluster row

Point it at a kubeconfig; it pulls every plausible identifier out of the file
(cluster name, context, server hostname, the short cluster id), finds the
matching row, shows you the child rows that go with it, and deletes the lot in
a single transaction.

```bash
qa cluster:db-cleanup --kubeconfig ~/Downloads/xn55t9.yaml
qa cluster:db-cleanup --kubeconfig ./kc.yaml --dry-run
qa cluster:db-cleanup --name xn55t9
```

`--dry-run` runs the real DELETEs and then rolls back, so the row counts it
reports are exact rather than estimated.

### `api:probe` — inspect an API path

For when a list endpoint isn't wired up yet. Sends the request with correct
auth headers and prints the response's field names, which is what you need to
fill in `endpoints:` in config.yaml.

```bash
qa api:probe /api/v2.1/computes/domain/tn-zikwj3wzwu/project/default-project/computes/ \
  --domain tn-zikwj3wzwu --project default-project --project-id 148
```

## Safety

Both destructive tasks follow the same rules:

- **Preview first.** Nothing is sent until you've seen the exact list.
- **Typed confirmation.** You retype a phrase (`delete 7`, or the cluster
  name) — Enter alone never triggers a delete. `-y` skips it for scripted runs.
- **`--dry-run` everywhere.** API deletes print the URL; DB deletes execute
  inside a transaction and roll back.
- **Audit log.** Every live run appends to `logs/audit-YYYY-MM-DD.jsonl`.
- **No SQL interpolation.** Values are bound as parameters and table/column
  names from config are validated against `^[A-Za-z_][A-Za-z0-9_]*$`.

## Adding a task

Drop a module in `src/tasks/` exporting `{ name, summary, destructive, usage, run(ctx) }`
and register it in `src/tasks/index.js`. `ctx` gives you `{ env, args, config }`;
`src/core/` has the API client, DB wrapper, prompts, and audit log.

## Config notes

`config.yaml` holds one block per environment; switch with `-e/--env`.
Secrets are referenced as `${VAR}` and resolved from `.env`, so config.yaml
stays committable.

Only the `vmDelete` endpoint is confirmed from the original script. The list
endpoints (`vms`, `projects`, `domains`) are best guesses — if one returns an
error the tool falls back to the static lists in config or asks you to type the
value, so it keeps working either way. Use `api:probe` to find the real paths
and fill them in once.
