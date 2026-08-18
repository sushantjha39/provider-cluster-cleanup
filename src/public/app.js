'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, kids = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of [].concat(kids)) {
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const state = {
  envs: [], vms: [], selected: new Set(), matches: [],
  kubeconfig: null, projects: [], domains: [],
};

// --------------------------------------------------------------------------
// plumbing
// --------------------------------------------------------------------------

function toast(message, kind = 'info') {
  const node = $('toast');
  node.textContent = message;
  node.className = `show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.className = kind), 4200);
}

async function api(path, { method = 'GET', body, query } = {}) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  const headers = {};
  const token = $('token').value.trim();
  if (token) headers['x-api-token'] = token;
  if (body) headers['content-type'] = 'application/json';

  // Host overrides typed in the hosts bar; blank means "use config".
  const admin = $('hAdmin').value.trim();
  const consoleUrl = $('hConsole').value.trim();
  const authUrl = $('hAuth').value.trim();
  if (admin) headers['x-admin-base-url'] = admin;
  if (consoleUrl) headers['x-console-base-url'] = consoleUrl;
  if (authUrl) headers['x-auth-base-url'] = authUrl;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Typed-phrase gate, mirroring the CLI. Resolves true only on an exact match. */
function confirmPhrase(title, detail, phrase) {
  return new Promise((resolve) => {
    const dlg = $('confirmDlg');
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = detail;
    $('confirmPhrase').textContent = phrase;
    const input = $('confirmInput');
    const go = $('confirmGo');
    input.value = '';
    go.disabled = true;

    const onInput = () => (go.disabled = input.value !== phrase);
    const finish = (ok) => {
      input.removeEventListener('input', onInput);
      go.onclick = null;
      $('confirmCancel').onclick = null;
      dlg.close();
      resolve(ok);
    };

    input.addEventListener('input', onInput);
    go.onclick = () => finish(true);
    $('confirmCancel').onclick = () => finish(false);
    dlg.addEventListener('cancel', () => finish(false), { once: true });

    dlg.showModal();
    input.focus();
  });
}

function logLines(target, lines) {
  const box = $(target);
  box.replaceChildren(...lines.map(([text, cls]) => el('div', { className: cls || '' }, text)));
  $(target === 'vmResult' ? 'vmResultPanel' : 'clusterResultPanel').hidden = false;
}

function busy(button, on, label) {
  button.disabled = on;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || 'Working…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

// --------------------------------------------------------------------------
// tabs + token
// --------------------------------------------------------------------------

for (const button of document.querySelectorAll('nav button')) {
  button.onclick = () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === button));
    for (const tab of ['vms', 'cluster', 'explorer', 'audit']) {
      $(`tab-${tab}`).hidden = tab !== button.dataset.tab;
    }
    if (button.dataset.tab === 'audit') loadAudit();
    if (button.dataset.tab === 'explorer') initExplorer();
    if (button.dataset.tab === 'cluster') loadDbKubeconfigs($('dbKcSelect').value);
  };
}

function syncTokenState() {
  const has = Boolean($('token').value.trim());
  const pill = $('tokenState');
  pill.textContent = has ? 'token set' : 'no token';
  pill.className = `pill ${has ? 'active' : 'off'}`;
  // sessionStorage, not localStorage — the token dies with the tab.
  if (has) sessionStorage.setItem('qa_token', $('token').value.trim());
  else sessionStorage.removeItem('qa_token');
}

// Pasting a fresh token should repopulate the tenant list without a click.
let tokenTimer = null;
$('token').oninput = () => {
  syncTokenState();
  clearTimeout(tokenTimer);
  if ($('token').value.trim().length > 40) {
    tokenTimer = setTimeout(loadDomains, 400);
  }
};

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------

async function boot() {
  $('token').value = sessionStorage.getItem('qa_token') || '';
  syncTokenState();

  try {
    const cfg = await api('/api/config');
    state.envs = cfg.environments;
    $('env').replaceChildren(
      ...cfg.environments.map((e) => el('option', { value: e.name, textContent: e.name }))
    );
    $('env').value = cfg.defaultEnv;
    // Boot keeps any saved overrides; only switching env resets them.
    applyHosts(state.envs.find((e) => e.name === cfg.defaultEnv));
    loadDomains();
    if (cfg.tokenFromEnv && !$('token').value) {
      $('tokenState').textContent = 'token from .env';
      $('tokenState').className = 'pill active';
    }
  } catch (err) {
    toast(`Config error: ${err.message}`, 'bad');
  }
}

const HOST_KEYS = { hAdmin: 'qa_host_admin', hConsole: 'qa_host_console', hAuth: 'qa_host_auth' };

/** Prefill the host fields from config, unless overridden for this browser. */
function applyHosts(env, { fromConfig = false } = {}) {
  const defaults = {
    hAdmin: env?.adminBaseUrl || '',
    hConsole: env?.baseUrl || '',
    hAuth: env?.authBaseUrl || '',
  };
  for (const [id, key] of Object.entries(HOST_KEYS)) {
    const saved = fromConfig ? null : localStorage.getItem(key);
    $(id).value = saved ?? defaults[id];
  }
  markHostOverrides(env);
}

/** Highlight the button when a host differs from what config says. */
function markHostOverrides(env) {
  const changed =
    $('hAdmin').value.trim() !== (env?.adminBaseUrl || '') ||
    $('hConsole').value.trim() !== (env?.baseUrl || '') ||
    $('hAuth').value.trim() !== (env?.authBaseUrl || '');
  $('toggleHosts').textContent = changed ? 'hosts ·' : 'hosts';
  $('toggleHosts').style.borderColor = changed ? 'var(--warn)' : '';
}

for (const [id, key] of Object.entries(HOST_KEYS)) {
  $(id).oninput = () => {
    const value = $(id).value.trim();
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
    markHostOverrides(state.envs.find((e) => e.name === $('env').value));
  };
}

$('toggleHosts').onclick = () => {
  $('hostBar').hidden = !$('hostBar').hidden;
};

$('resetHosts').onclick = () => {
  Object.values(HOST_KEYS).forEach((k) => localStorage.removeItem(k));
  applyHosts(state.envs.find((e) => e.name === $('env').value), { fromConfig: true });
  toast('Hosts reset to config values', 'ok');
  loadDomains();
};

function onEnvChange() {
  const env = state.envs.find((e) => e.name === $('env').value);
  // A different environment means different hosts — take config's, not the
  // ones left over from the previous environment.
  applyHosts(env, { fromConfig: true });
  loadDomains();
}
$('env').onchange = onEnvChange;

// --------------------------------------------------------------------------
// VM cleanup
// --------------------------------------------------------------------------

function renderVms() {
  const body = $('vmRows');
  if (!state.vms.length) {
    body.replaceChildren(
      el('tr', {}, el('td', { colSpan: 5, className: 'empty' }, 'Nothing parsed yet.'))
    );
    $('delVms').disabled = true;
    $('vmCount').textContent = '';
    return;
  }

  body.replaceChildren(
    ...state.vms.map((vm) => {
      const box = el('input', { type: 'checkbox', checked: state.selected.has(vm.id) });
      box.onchange = () => {
        if (box.checked) state.selected.add(vm.id);
        else state.selected.delete(vm.id);
        updateSelCount();
      };
      return el('tr', {}, [
        el('td', {}, box),
        el('td', {}, vm.name),
        el('td', { className: 'muted' }, vm.domain),
        el('td', { className: 'muted' }, `${vm.project}${vm.projectId ? ` (${vm.projectId})` : ''}`),
        el('td', { className: 'mono muted' }, vm.id),
      ]);
    })
  );
  updateSelCount();
}

function updateSelCount() {
  const n = state.selected.size;
  $('vmCount').textContent = `— ${n} of ${state.vms.length} selected`;
  $('delVms').disabled = n === 0;
}

// Fetch-from-API vs paste-a-list. Both end up in state.vms.
function setMode(mode) {
  $('modeFetch').classList.toggle('active', mode === 'fetch');
  $('modePaste').classList.toggle('active', mode === 'paste');
  $('fetchMode').hidden = mode !== 'fetch';
  $('pasteMode').hidden = mode !== 'paste';
}
$('modeFetch').onclick = () => setMode('fetch');
$('modePaste').onclick = () => setMode('paste');

async function loadDomains() {
  try {
    const { domains, source } = await api('/api/domains', { query: { env: $('env').value } });
    state.domains = domains;
    $('domainList').replaceChildren(
      ...domains.map((d) => el('option', { value: d.name, label: d.id ? `id ${d.id}` : '' }))
    );
    syncDbDomains();
    if (source === 'admin' && domains.length) {
      toast(`${domains.length} tenant(s) available`, 'ok');
    }
  } catch (err) {
    // Optional — the field stays free-text, so a missing token is not fatal here.
    if (err.tokenExpired || /token rejected/i.test(err.message)) return;
  }
}

/** Token expiry is the most common failure; make it obvious and recoverable. */
function handleApiError(err, targetId) {
  const expired = /token rejected|HTTP 401|HTTP 403/i.test(err.message);
  const lines = [el('div', { className: 'bad' }, err.message)];

  if (expired) {
    lines.push(
      el('div', { className: 'warn', style: 'font-size:12px;margin-top:4px' },
        'Paste a fresh token in the header and press the button again — your selection is kept.')
    );
    $('tokenState').textContent = 'token expired';
    $('tokenState').className = 'pill off';
    $('token').focus();
    $('token').select();
  }
  if (targetId) $(targetId).replaceChildren(...lines);
  toast(expired ? 'Token expired — paste a new one' : err.message, 'bad');
}

$('loadVms').onclick = async (event) => {
  const domain = $('fDomain').value.trim();
  if (!domain) return toast('Pick a domain / tenant first', 'bad');

  busy(event.target, true, 'Fetching…');
  try {
    // Every VM comes back with its own project + ccpid, so nothing else to send.
    const match = (state.domains || []).find((d) => d.name === domain);
    const data = await api('/api/vms', {
      query: {
        env: $('env').value,
        domain,
        organisationId: match?.id ?? '',
        status: $('fStatus').value,
        filter: $('filter').value.trim(),
      },
    });

    state.vms = data.vms;
    state.selected = new Set(data.vms.map((vm) => vm.id));
    renderVms();

    const notes = [
      el('div', { className: data.vms.length ? 'ok' : 'bad' },
        `${data.matched} VM(s) in ${domain}` +
        (data.fetched !== data.matched ? ` (from ${data.fetched} fetched)` : '')),
      el('div', { className: 'muted', style: 'font-size:12px' },
        data.serverFiltered
          ? `filtered server-side · ${data.pages} page(s)`
          : `filtered locally · ${data.pages} page(s) scanned`),
    ];

    // Never let a page cap read as "that's all of them".
    if (data.truncated) {
      notes.push(el('div', { className: 'warn', style: 'font-size:12px' },
        'Hit the page limit — this list may be incomplete. Narrow with a name filter.'));
    }
    // Flag anything missing a ccpid: those cannot be deleted.
    const noCcpid = data.vms.filter((vm) => !vm.projectId);
    if (noCcpid.length) {
      notes.push(el('div', { className: 'bad', style: 'font-size:12px' },
        `${noCcpid.length} VM(s) have no project id and cannot be deleted.`));
    }
    $('parseInfo').replaceChildren(...notes);

    toast(`${data.matched} VM(s) found`, data.vms.length ? 'ok' : 'bad');
  } catch (err) {
    handleApiError(err, 'parseInfo');
  } finally {
    busy(event.target, false);
  }
};

$('parseVms').onclick = async (event) => {
  const text = $('vmPaste').value.trim();
  if (!text) return toast('Paste a VM list first', 'bad');

  busy(event.target, true, 'Parsing…');
  try {
    const data = await api('/api/vms/parse', {
      method: 'POST',
      body: {
        text,
        domain: $('domain').value.trim(),
        project: $('project').value.trim(),
        projectId: $('projectId').value.trim(),
      },
    });

    state.vms = data.entries;
    // Everything parsed is pre-selected — the list itself is the selection.
    state.selected = new Set(data.entries.map((vm) => vm.id));
    renderVms();

    const notes = [];
    notes.push(
      el('div', { className: data.entries.length ? 'ok' : 'bad' },
        `${data.entries.length} VM(s) parsed`)
    );
    if (data.duplicates) {
      notes.push(el('div', { className: 'warn' }, `${data.duplicates} duplicate line(s) ignored`));
    }
    for (const bad of data.errors) {
      notes.push(
        el('div', { className: 'bad mono', style: 'font-size:12px' },
          `line ${bad.line}: ${bad.reason} — ${bad.text}`)
      );
    }
    $('parseInfo').replaceChildren(...notes);

    if (data.errors.length) {
      toast(`${data.entries.length} parsed, ${data.errors.length} line(s) rejected`, 'bad');
    } else {
      toast(`${data.entries.length} VM(s) ready`, 'ok');
    }
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    busy(event.target, false);
  }
};

$('selAll').onclick = () => {
  state.vms.forEach((vm) => state.selected.add(vm.id));
  renderVms();
};
$('selNone').onclick = () => {
  state.selected.clear();
  renderVms();
};

$('delVms').onclick = async (event) => {
  const chosen = state.vms.filter((vm) => state.selected.has(vm.id));
  const dryRun = $('vmDry').checked;

  if (!dryRun) {
    const tenants = [...new Set(chosen.map((vm) => `${vm.domain}/${vm.project}`))];
    const ok = await confirmPhrase(
      `Delete ${chosen.length} VM(s)?`,
      `Across ${tenants.length} tenant/project pair(s): ${tenants.join(', ')} — this cannot be undone.`,
      `delete ${chosen.length}`
    );
    if (!ok) return toast('Aborted — nothing deleted', 'info');
  }

  busy(event.target, true, 'Deleting…');
  try {
    const res = await api('/api/vms/delete', {
      method: 'POST',
      body: {
        env: $('env').value,
        domain: $('domain').value,
        project: $('project').value,
        projectId: $('projectId').value.trim(),
        vms: chosen,
        dryRun,
      },
    });

    const lines = [];
    for (const vm of res.success) {
      if (dryRun) {
        lines.push([`DRY RUN  ${vm.name}  →  ${vm.url}`, 'warn']);
        if (vm.curl) lines.push([vm.curl, 'muted']);
      } else {
        lines.push([`ok       ${vm.name}  (${vm.httpStatus})`, 'ok']);
      }
    }
    for (const vm of res.failed) {
      lines.push([`FAILED   ${vm.name}  (${vm.httpStatus})  ${vm.detail || ''}`, 'bad']);
    }
    lines.push(['', '']);
    lines.push([`${res.success.length} succeeded, ${res.failed.length} failed`, res.failed.length ? 'bad' : 'ok']);
    logLines('vmResult', lines);

    toast(
      dryRun ? 'Dry run complete — nothing changed' : `${res.success.length} deleted, ${res.failed.length} failed`,
      res.failed.length ? 'bad' : 'ok'
    );

    if (!dryRun) {
      // Drop the ones that went, so a second click can only retry the failures.
      state.vms = state.vms.filter((vm) => !res.success.some((s) => s.id === vm.id));
      state.selected = new Set(state.vms.map((vm) => vm.id));
      renderVms();
    }
  } catch (err) {
    handleApiError(err);
  } finally {
    busy(event.target, false);
  }
};

// --------------------------------------------------------------------------
// Cluster DB cleanup
// --------------------------------------------------------------------------

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, () => drop.classList.remove('over'))
);
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) readKubeconfig(file);
});
$('kcFile').onchange = (e) => e.target.files[0] && readKubeconfig(e.target.files[0]);

/**
 * Store the kubeconfig server-side so it can drive the port-forward, and keep
 * a copy in the textarea so the tenant can also be read out of it.
 */
function readKubeconfig(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    $('kcText').value = reader.result;
    state.kubeconfig = { name: file.name };

    try {
      const saved = await api('/api/k8s/kubeconfigs', {
        method: 'POST',
        body: { text: reader.result, filename: file.name },
      });
      await loadDbKubeconfigs(saved.id);
      $('kcInfo').textContent =
        `${file.name} → cluster ${saved.clusterName}` +
        (saved.server ? `  server ${saved.server}` : '');

      // The cluster name carries the tenant; offer it so step 2 is prefilled.
      const tenant = (saved.clusterName || '').match(/^(?:k8s|dbaas|svc)-(.+)-[a-z0-9]{6}$/i);
      if (tenant && !$('kcName').value.trim()) $('kcName').value = tenant[1];

      toast(`Uploaded ${saved.clusterName} — now choose the tenant`, 'ok');
    } catch (err) {
      $('kcInfo').textContent = `stored locally only: ${err.message}`;
      toast(err.message, 'bad');
    }
  };
  reader.readAsText(file);
}

/** Populate the kubeconfig picker on the DB tab. */
async function loadDbKubeconfigs(selectId) {
  try {
    const { kubeconfigs } = await api('/api/k8s/kubeconfigs');
    state.dbKubeconfigs = kubeconfigs;
    $('dbKcSelect').replaceChildren(
      el('option', { value: '', textContent: '(reuse an existing tunnel)' }),
      ...kubeconfigs.map((kc) =>
        el('option', { value: kc.id, textContent: kc.clusterName || kc.label })
      )
    );
    if (selectId) $('dbKcSelect').value = selectId;

    const chosen = $('dbKcSelect').value;
    $('dbKcState').textContent = chosen ? 'will open tunnel' : 'reuse existing tunnel';
    $('dbKcState').className = `pill ${chosen ? 'active' : ''}`;
  } catch {
    // Non-fatal: without one, the app falls back to an already-open tunnel.
  }
}

$('dbKcSelect').onchange = () => {
  const chosen = $('dbKcSelect').value;
  $('dbKcState').textContent = chosen ? 'will open tunnel' : 'reuse existing tunnel';
  $('dbKcState').className = `pill ${chosen ? 'active' : ''}`;
};

// Switching replica member invalidates what we know about primary/secondary.
$('dbPodIndex').onchange = () => {
  $('dbRole').textContent = 'role unknown';
  $('dbRole').className = 'pill';
};

/** Mint a fresh token from the configured credentials. */
$('mintToken').onclick = async (event) => {
  busy(event.target, true, '…');
  try {
    const data = await api('/api/token', { method: 'POST', body: { env: $('env').value, force: true } });
    // Keep it out of the field: the server already holds it, and echoing a
    // bearer token into a visible input is needless exposure.
    $('token').value = '';
    syncTokenState();
    $('tokenState').textContent = `auto (${data.secondsLeft}s)`;
    $('tokenState').className = 'pill active';
    toast(`Token minted for ${data.username} — valid ${data.secondsLeft}s`, 'ok');
    await loadDomains();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    busy(event.target, false);
  }
};

/** Reuse the tenant list from the VM tab for the DB tab's datalist. */
function syncDbDomains() {
  $('dbDomainList').replaceChildren(
    ...(state.domains || []).map((d) => el('option', { value: d.name }))
  );
}

$('findCluster').onclick = async (event) => {
  const text = $('kcText').value.trim();
  const name = $('kcName').value.trim();
  // Typed tenant name wins — the kubeconfig is only a convenience.
  if (!name && !text) return toast('Enter a tenant / domain name', 'bad');

  busy(event.target, true, 'Searching…');
  try {
    const data = await api('/api/cluster/find', {
      method: 'POST',
      body: {
        env: $('env').value,
        kc: $('dbKcSelect').value || undefined, // opens the port-forward
        podIndex: $('dbPodIndex').value || undefined,
        kubeconfig: name ? undefined : text,
        filename: state.kubeconfig?.name,
        name: name || undefined,
      },
    });

    state.matches = data.matches;
    $('dbTarget').textContent = `${data.database} · ${data.table}`;

    // Show which replica member we landed on — deletes need the primary.
    const r = data.replica || {};
    const pill = $('dbRole');
    if (r.isPrimary === true) {
      pill.textContent = `PRIMARY${r.pod ? ` · ${r.pod}` : ''}`;
      pill.className = 'pill active';
    } else if (r.isPrimary === false) {
      pill.textContent = `SECONDARY${r.pod ? ` · ${r.pod}` : ''} — cannot delete`;
      pill.className = 'pill off';
      toast('This member is a SECONDARY — switch the replica pod to delete', 'bad');
    } else {
      pill.textContent = 'role unknown';
      pill.className = 'pill';
    }
    if (data.kubeconfig) {
      $('kcInfo').textContent =
        `cluster: ${data.kubeconfig.clusterName}   tenant candidates: ${data.candidates.join(', ')}`;
    }
    renderMatches(data);
    toast(
      data.matches.length ? `${data.matches.length} match(es) in ${data.table}` : 'No matching rows',
      data.matches.length ? 'ok' : 'bad'
    );
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    busy(event.target, false);
  }
};

function renderMatches(data) {
  $('matchCount').textContent = data.matches.length ? `— ${data.database} · ${data.table}` : '';
  const host = $('matches');

  if (!data.matches.length) {
    host.replaceChildren(
      el('div', { className: 'empty' }, `Nothing matched: ${data.candidates.join(', ')}`)
    );
    return;
  }

  host.replaceChildren(
    ...data.matches.map((match) => {
      const fields = el('table', {}, [
        el('tbody', {}, Object.entries(match.row).map(([key, value]) =>
          el('tr', {}, [
            el('td', { className: 'muted', style: 'width:150px' }, key),
            el('td', { className: 'mono' }, String(value ?? '—')),
          ])
        )),
      ]);

      const impact = el('div', { style: 'margin-top:10px' }, [
        el('div', { className: 'muted', style: 'font-size:12px;margin-bottom:4px' }, 'Rows to delete:'),
        ...match.related.map((rel) =>
          el('div', { className: 'mono' }, `${rel.table}  ${rel.count}`)
        ),
        el('div', { className: 'mono' }, `${data.table}  1`),
      ]);

      const dry = el('input', { type: 'checkbox', checked: true });
      const button = el('button', { className: 'danger', textContent: 'Delete cluster row' });
      button.onclick = () => deleteCluster(match, data, dry.checked, button);

      return el('div', { className: 'panel', style: 'background:var(--panel2)' }, [
        fields,
        impact,
        el('div', { className: 'row', style: 'margin-top:12px' }, [
          el('label', { className: 'field' }, [dry, ' dry run (rolls back)']),
          el('div', { className: 'spacer' }),
          button,
        ]),
      ]);
    })
  );
}

async function deleteCluster(match, data, dryRun, button) {
  const label = String(Object.values(match.row)[1] ?? match.id);

  if (!dryRun) {
    const total = match.related.reduce((sum, r) => sum + r.count, 0) + 1;
    const ok = await confirmPhrase(
      `Delete cluster "${label}"?`,
      `${total} row(s) across ${match.related.length + 1} table(s) in ${data.database}. This cannot be undone.`,
      label
    );
    if (!ok) return toast('Aborted — nothing deleted', 'info');
  }

  busy(button, true, 'Deleting…');
  try {
    const res = await api('/api/cluster/delete', {
      method: 'POST',
      body: {
        env: $('env').value,
        kc: $('dbKcSelect').value || undefined,
        podIndex: $('dbPodIndex').value || undefined,
        clusterId: match.id,
        dryRun,
        source: data.source,
      },
    });

    logLines('clusterResult', [
      [res.committed ? 'COMMITTED' : 'DRY RUN — rolled back, nothing changed', res.committed ? 'ok' : 'warn'],
      ['', ''],
      ...res.removed.map((r) => [`${r.table}  ${r.rows} row(s)`, '']),
    ]);
    toast(res.committed ? 'Cluster row deleted' : 'Dry run complete — rolled back', res.committed ? 'ok' : 'info');

    if (res.committed) $('findCluster').click();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    busy(button, false);
  }
}

// --------------------------------------------------------------------------
// Cluster Explorer (Lens-like)
// --------------------------------------------------------------------------

const KINDS = [
  'pods', 'deployments', 'statefulsets', 'daemonsets', 'services',
  'jobs', 'cronjobs', 'pvc', 'configmaps', 'secrets', 'ingress',
  'events', 'nodes', 'namespaces',
];

// Columns per kind. `name` and `age` are always shown.
const COLUMNS = {
  pods: ['status', 'ready', 'restarts', 'node'],
  deployments: ['ready'],
  statefulsets: ['ready'],
  daemonsets: ['status'],
  services: ['status', 'clusterIP', 'ports'],
  nodes: ['status', 'version'],
  events: ['status', 'reason', 'message'],
  pvc: ['status', 'capacity'],
};

const ex = {
  ready: false,
  kind: 'pods',
  rows: [],
  selected: null,
  detailTab: 'logs',
  timer: null,
};

async function initExplorer() {
  if (ex.ready) return;
  ex.ready = true;

  $('kindRow').replaceChildren(
    ...KINDS.map((kind) => {
      const button = el('button', {
        className: `mode${kind === ex.kind ? ' active' : ''}`,
        textContent: kind,
      });
      button.onclick = () => {
        ex.kind = kind;
        document.querySelectorAll('#kindRow button')
          .forEach((b) => b.classList.toggle('active', b === button));
        loadResources();
      };
      return button;
    })
  );

  await loadKubeconfigs();
}

async function loadKubeconfigs() {
  const { kubeconfigs } = await api('/api/k8s/kubeconfigs').catch(() => ({ kubeconfigs: [] }));
  $('kcSelect').replaceChildren(
    el('option', { value: 'default', textContent: '(current kubectl context)' }),
    ...kubeconfigs.map((kc) =>
      el('option', { value: kc.id, textContent: kc.label || kc.clusterName })
    )
  );
  await loadContexts();
}

$('kcUpload').onchange = (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const saved = await api('/api/k8s/kubeconfigs', {
        method: 'POST',
        body: { text: reader.result, filename: file.name },
      });
      await loadKubeconfigs();
      $('kcSelect').value = saved.id;
      toast(`Added ${saved.clusterName}`, 'ok');
      await loadContexts();
      await loadResources();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  reader.readAsText(file);
};

$('kcSelect').onchange = async () => {
  await loadContexts();
  await loadResources();
};

async function loadContexts() {
  const kc = $('kcSelect').value;
  try {
    const { contexts, current } = await api('/api/k8s/contexts', { query: { kc } });
    $('ctxSelect').replaceChildren(
      el('option', { value: '', textContent: current ? `${current} (current)` : '(default)' }),
      ...contexts.filter((c) => c !== current).map((c) => el('option', { value: c, textContent: c }))
    );
    await loadNamespaces();
  } catch (err) {
    toast(`kubectl: ${err.message}`, 'bad');
  }
}

async function loadNamespaces() {
  try {
    const data = await api('/api/k8s/resources', {
      query: { kc: $('kcSelect').value, context: $('ctxSelect').value, kind: 'namespaces' },
    });
    const previous = $('nsSelect').value;
    $('nsSelect').replaceChildren(
      el('option', { value: '*', textContent: 'all namespaces' }),
      ...data.rows.map((row) => el('option', { value: row.name, textContent: row.name }))
    );
    // Keep the namespace across reloads, and default to the DB one if present.
    if (data.rows.some((r) => r.name === previous)) $('nsSelect').value = previous;
    else if (data.rows.some((r) => r.name === 'uhc-dev')) $('nsSelect').value = 'uhc-dev';
  } catch {
    // A token scoped to one namespace cannot list them; the '*' option still works.
  }
}

$('ctxSelect').onchange = async () => {
  await loadNamespaces();
  await loadResources();
};
$('nsSelect').onchange = loadResources;
$('refreshK8s').onclick = () => loadResources();
$('k8sFilter').oninput = renderResources;

$('autoRefresh').onchange = (event) => {
  clearInterval(ex.timer);
  if (event.target.checked) ex.timer = setInterval(() => loadResources(true), 10000);
};

async function loadResources(quiet = false) {
  if (!ex.ready) return;
  const kind = ex.kind;

  if (!quiet) {
    $('k8sRows').replaceChildren(el('tr', {}, el('td', { className: 'empty' }, 'Loading…')));
  }

  try {
    const data = await api('/api/k8s/resources', {
      query: {
        kc: $('kcSelect').value,
        context: $('ctxSelect').value,
        namespace: $('nsSelect').value,
        kind,
      },
    });
    ex.rows = data.rows;
    renderResources();
  } catch (err) {
    ex.rows = [];
    $('k8sRows').replaceChildren(
      el('tr', {}, el('td', { className: 'empty bad' }, err.message))
    );
    $('k8sCount').textContent = '';
    if (!quiet) toast(err.message, 'bad');
  }
}

function statusClass(value) {
  if (/^(Running|Ready|Active|Bound|Complete|Normal)$/i.test(value)) return 'ok';
  if (/Terminating|Pending|ContainerCreating/i.test(value)) return 'warn';
  if (/CrashLoop|Error|Failed|NotReady|BackOff|Evicted|Warning/i.test(value)) return 'bad';
  return '';
}

function renderResources() {
  const kind = ex.kind;
  const extra = COLUMNS[kind] || ['status'];
  const namespaced = kind !== 'nodes' && kind !== 'namespaces';
  const needle = $('k8sFilter').value.trim().toLowerCase();

  const rows = needle
    ? ex.rows.filter((r) => `${r.name} ${r.namespace}`.toLowerCase().includes(needle))
    : ex.rows;

  $('k8sTitle').textContent = kind;
  $('k8sCount').textContent = `${rows.length}${rows.length !== ex.rows.length ? ` of ${ex.rows.length}` : ''}`;

  const headers = ['name', ...(namespaced ? ['namespace'] : []), ...extra, 'age'];
  $('k8sHead').replaceChildren(
    el('tr', {}, headers.map((h) => el('th', {}, h.toUpperCase())))
  );

  if (!rows.length) {
    $('k8sRows').replaceChildren(
      el('tr', {}, el('td', { colSpan: headers.length, className: 'empty' }, 'Nothing here.'))
    );
    return;
  }

  $('k8sRows').replaceChildren(
    ...rows.map((row) => {
      const cells = [el('td', {}, row.name)];
      if (namespaced) cells.push(el('td', { className: 'muted' }, row.namespace));

      for (const key of extra) {
        const value = String(row[key] ?? '-');
        const cls = key === 'status' ? statusClass(value) : key === 'restarts' && row[key] > 0 ? 'warn' : '';
        cells.push(el('td', { className: cls || (key === 'message' ? 'muted' : '') }, value));
      }
      cells.push(el('td', { className: 'muted' }, row.age));

      const tr = el('tr', { style: 'cursor:pointer' }, cells);
      tr.onclick = () => openDetail(row);
      return tr;
    })
  );
}

// ---- detail drawer: logs / describe / exec -------------------------------

function openDetail(row) {
  ex.selected = row;
  $('detailPanel').hidden = false;
  $('detailTitle').textContent = `${ex.kind} · ${row.name}`;

  const isPod = ex.kind === 'pods';
  $('tabLogs').hidden = !isPod;
  $('tabExec').hidden = !isPod;

  if (isPod && row.containers?.length) {
    $('containerField').hidden = row.containers.length < 2;
    $('containerSelect').replaceChildren(
      ...row.containers.map((c) => el('option', { value: c, textContent: c }))
    );
  } else {
    $('containerField').hidden = true;
  }

  setDetailTab(isPod ? ex.detailTab : 'describe');
}

$('detailClose').onclick = () => {
  $('detailPanel').hidden = true;
  ex.selected = null;
};

function setDetailTab(tab) {
  ex.detailTab = tab;
  for (const [id, name] of [['tabLogs', 'logs'], ['tabDescribe', 'describe'], ['tabExec', 'exec']]) {
    $(id).classList.toggle('active', name === tab);
  }
  $('execBar').hidden = tab !== 'exec';
  $('execHint').hidden = tab !== 'exec';

  if (tab === 'logs') loadLogs();
  else if (tab === 'describe') loadDescribe();
  else $('detailBody').replaceChildren(el('div', { className: 'muted' }, 'Enter a command and press Run.'));
}

$('tabLogs').onclick = () => setDetailTab('logs');
$('tabDescribe').onclick = () => setDetailTab('describe');
$('tabExec').onclick = () => setDetailTab('exec');
$('containerSelect').onchange = () => ex.detailTab === 'logs' && loadLogs();

function showDetailText(text, emptyMessage) {
  const body = $('detailBody');
  if (!text?.trim()) {
    body.replaceChildren(el('div', { className: 'muted' }, emptyMessage));
    return;
  }
  body.replaceChildren(...text.split('\n').map((line) => el('div', {}, line)));
  body.scrollTop = body.scrollHeight;
}

async function loadLogs() {
  const row = ex.selected;
  if (!row) return;
  $('detailBody').replaceChildren(el('div', { className: 'muted' }, 'Loading logs…'));
  try {
    const { text } = await api('/api/k8s/logs', {
      query: {
        kc: $('kcSelect').value, context: $('ctxSelect').value,
        namespace: row.namespace, pod: row.name,
        container: $('containerField').hidden ? '' : $('containerSelect').value,
        tail: 500,
      },
    });
    showDetailText(text, 'No log output.');
  } catch (err) {
    showDetailText(err.message, err.message);
  }
}

async function loadDescribe() {
  const row = ex.selected;
  if (!row) return;
  $('detailBody').replaceChildren(el('div', { className: 'muted' }, 'Loading…'));
  try {
    const { text } = await api('/api/k8s/describe', {
      query: {
        kc: $('kcSelect').value, context: $('ctxSelect').value,
        namespace: row.namespace, kind: ex.kind, name: row.name,
      },
    });
    showDetailText(text, 'Nothing returned.');
  } catch (err) {
    showDetailText(err.message, err.message);
  }
}

$('execRun').onclick = async (event) => {
  const row = ex.selected;
  const command = $('execCmd').value.trim();
  if (!row) return;
  if (!command) return toast('Enter a command', 'bad');

  busy(event.target, true, 'Running…');
  $('detailBody').replaceChildren(el('div', { className: 'muted' }, `$ ${command}`));
  try {
    const { text, ms } = await api('/api/k8s/exec', {
      method: 'POST',
      body: {
        kc: $('kcSelect').value, context: $('ctxSelect').value,
        namespace: row.namespace, pod: row.name,
        container: $('containerField').hidden ? '' : $('containerSelect').value,
        command,
      },
    });
    const body = $('detailBody');
    body.replaceChildren(
      el('div', { className: 'muted' }, `$ ${command}`),
      el('div', { className: 'muted' }, `— exited in ${ms}ms —`),
      ...String(text || '(no output)').split('\n').map((line) => el('div', {}, line))
    );
  } catch (err) {
    $('detailBody').replaceChildren(
      el('div', { className: 'muted' }, `$ ${command}`),
      ...String(err.message).split('\n').map((line) => el('div', { className: 'bad' }, line))
    );
  } finally {
    busy(event.target, false);
  }
};

// --------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------

async function loadAudit() {
  try {
    const { entries } = await api('/api/audit');
    const body = $('auditRows');

    if (!entries.length) {
      body.replaceChildren(el('tr', {}, el('td', { colSpan: 3, className: 'empty' }, 'Nothing logged yet.')));
      return;
    }

    body.replaceChildren(
      ...entries.map((entry) => {
        let detail;
        if (entry.task === 'vm:delete') {
          detail = `${entry.domain || '-'}/${entry.project || '-'} — ${entry.deleted?.length || 0} deleted` +
            (entry.failed?.length ? `, ${entry.failed.length} failed` : '');
        } else if (entry.task === 'k8s:exec') {
          detail = `${entry.namespace}/${entry.pod} — ${entry.command}`;
        } else if (entry.task === 'k8s:delete') {
          detail = `${entry.kind} ${entry.namespace || ''}/${entry.name}`;
        } else {
          detail = `${entry.database} — cluster ${entry.clusterId} — ` +
            (entry.removed || []).map((r) => `${r.table}:${r.rows}`).join(' ');
        }
        return el('tr', {}, [
          el('td', { className: 'mono muted' }, new Date(entry.ts).toLocaleString()),
          el('td', {}, [entry.task, entry.via === 'web' ? el('span', { className: 'pill', style: 'margin-left:6px' }, 'web') : '']),
          el('td', { className: 'mono' }, detail),
        ]);
      })
    );
  } catch (err) {
    toast(err.message, 'bad');
  }
}
$('loadAudit').onclick = loadAudit;

boot();
