#!/usr/bin/env node
// qc — the QuickCloud command-line tool.
//
// A thin, zero-dependency client over the QuickCloud v1 API. Authenticates with
// an API key (create one in the panel → API), so it runs anywhere you have Node
// and is fully scriptable: `qc vm list --json | jq …`, cron, CI/CD, etc.
//
// Quick start:
//   qc config set token <your-api-key>
//   qc whoami
//   qc vm list
//
// Config lives in ~/.config/quickcloud/config.json (chmod 600). You can also use
// env vars QC_API_URL and QC_API_TOKEN, which take precedence.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = '1.7.0';   // 1.7.0: SMTP relay (qc relay …); 1.6.0: managed databases; 1.5.0: storage boxes; 1.4.0: load balancers; 1.3.x: Cloud Firewall + qc update; 1.2.0: dedicated + DNS
const DEFAULT_URL = 'https://cloud.quickhost.uk';   // (the panel pre-fills this on download)
const CFG_DIR = path.join(os.homedir(), '.config', 'quickcloud');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const VC_FILE = path.join(CFG_DIR, 'version-check.json');   // cached update check

const JSON_OUT = process.argv.includes('--json');
const argv = process.argv.slice(2).filter((a) => a !== '--json');

function fail(msg) { process.stderr.write(`error: ${msg}\n`); process.exit(1); }
function say(line = '') { process.stdout.write(line + '\n'); }
function emit(obj, human) { if (JSON_OUT) say(JSON.stringify(obj, null, 2)); else human(); }

function readCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return {}; } }
function cfg() {
  const c = readCfg();
  return {
    url: (process.env.QC_API_URL || c.url || DEFAULT_URL).replace(/\/+$/, ''),
    token: process.env.QC_API_TOKEN || c.token || '',
  };
}
function saveCfg(patch) {
  const c = { ...readCfg(), ...patch };
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

function parseArgs(args) {
  const pos = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function api(method, p, body, extraHeaders = {}) {
  const { url, token } = cfg();
  if (!token) fail('no API key set — run:  qc config set token <key>   (create one in the panel → API)');
  let res;
  try {
    res = await fetch(url + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { fail(`could not reach ${url} (${e?.message || e})`); }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = json && json.error;
    let msg = (e && (e.message || e)) || `HTTP ${res.status}`;
    if (e && Array.isArray(e.fields) && e.fields.length) msg += ` — ${e.fields.map((f) => `${f.field} ${f.error}`).join(', ')}`;
    else if (e && e.dimension) msg += ` (over your ${e.dimension} limit)`;
    if (e && e.need_terms) msg += '\n  accept the credit terms once in the panel (Billing) - the API cannot accept them for you.';
    if (e && e.code === 'cleanup_fee') msg += '\n  re-run with --pay-cleanup-fee to accept the fee.';
    if (e && e.code === 'plan_locked') msg += '\n  this needs a Pay-as-you-go workspace - switch in the panel (Billing).';
    fail(msg);
  }
  return json || {};
}

// --- update check (best-effort, throttled, never blocks a command) ----------
function semverGt(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}
// Returns the latest version string the panel offers, cached for a day so we
// hit the network sparingly: HOURLY while no update is known (the panel ships
// several times a day - a day-long cache hid a release for a whole day, live
// 2026-10-06), DAILY once one is (it keeps reminding; no need to re-ask).
// Offline → falls back to the last value we learned. `force` skips the cache
// (qc update / qc version --check).
async function latestVersion(force = false) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(VC_FILE, 'utf8')); } catch { /* none yet */ }
  const ttl = cache.latest && semverGt(cache.latest, VERSION) ? 86400000 : 3600000;
  if (!force && cache.checkedAt && Date.now() - cache.checkedAt < ttl) return cache.latest || null;
  try {
    const { url } = cfg();
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url + '/api/cli/version', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await res.json().catch(() => ({}));
    const latest = j && /^\d+\.\d+\.\d+$/.test(String(j.version || '')) ? j.version : null;   // only a real version number is ever cached or shown
    try { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(VC_FILE, JSON.stringify({ checkedAt: Date.now(), latest })); } catch { /* ignore */ }
    return latest;
  } catch { return cache.latest || null; }
}
// Print an update notice to stderr (so it never pollutes stdout / --json).
async function maybeNotifyUpdate() {
  if (JSON_OUT) return;
  try {
    const latest = await latestVersion();
    if (latest && semverGt(latest, VERSION)) {
      const { url } = cfg();
      process.stderr.write(`\n⬆ A new version of qc is available (${VERSION} → ${latest}).  Run:  qc update\n  (or by hand:  curl -fsSL ${url}/api/cli/qc.mjs -o qc && chmod +x qc)\n`);
    }
  } catch { /* never block the command on the update check */ }
}

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  say(headers.map((h, i) => h.padEnd(w[i])).join('  '));
  rows.forEach((r) => say(r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ')));
}
const gb = (mb) => (mb >= 1024 ? `${mb / 1024}G` : `${mb}M`);
const gib = (bytes) => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)}G` : `${Math.round(bytes / 1048576)}M`);

// --- commands ---------------------------------------------------------------
function cmdConfig(pos) {
  const sub = (pos.shift() || 'show').toLowerCase();
  if (sub === 'show') {
    const c = cfg();
    return emit({ url: c.url, token: c.token ? '(set)' : '(none)' }, () => { say(`url   : ${c.url}`); say(`token : ${c.token ? c.token.slice(0, 6) + '…' : '(not set)'}`); say(`file  : ${CFG_FILE}`); });
  }
  if (sub === 'set') {
    const key = (pos.shift() || '').toLowerCase(); const val = pos.shift();
    if ((key !== 'url' && key !== 'token') || !val) fail('usage: qc config set url|token <value>');
    saveCfg({ [key]: val });
    return say(`saved ${key}.`);
  }
  fail('usage: qc config show | qc config set url|token <value>');
}

async function cmdWhoami() {
  const w = await api('GET', '/api/v1/workspace');
  emit(w, () => {
    say(`workspace : ${w.label} (#${w.id})  [${w.status}]`);
    say(`billing   : ${w.billing_mode}${w.tier ? `  tier ${w.tier}` : ''}`);
    const q = w.quota || {};
    for (const k of Object.keys(q)) { const v = q[k]; if (v && typeof v === 'object' && 'used' in v) say(`  ${k.padEnd(10)} ${v.used} / ${v.limit}`); }
  });
}

const FIELD_FLAG = { ciuser: '--user', password: '--password', sshkeys: '--ssh-key', user_data: '(cloud-init — panel only)' };
async function cmdTemplates(pos) {
  const r = await api('GET', '/api/v1/templates');
  const t = r.templates || [];
  const name = pos[0];
  if (name) {                                   // qc templates <name> → show its inputs
    const tpl = t.find((x) => x.name === name || (x.label || '').toLowerCase() === name.toLowerCase());
    if (!tpl) fail(`no template named '${name}' — run: qc templates`);
    return emit(tpl, () => {
      say(`${tpl.name}  (${tpl.label || tpl.name})`);
      const f = tpl.fields || {}; const keys = Object.keys(f);
      if (!keys.length) return say('no inputs required.');
      say('inputs for `vm create`:');
      for (const k of keys) say(`  ${(f[k].required ? 'required' : 'optional').padEnd(9)} ${FIELD_FLAG[k] || `--${k}`}`);
    });
  }
  emit(r, () => (t.length ? table(['NAME', 'LABEL', 'FAMILY'], t.map((x) => [x.name, x.label || x.name, x.os_family || ''])) : say('no templates.')));
}

async function cmdVm(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  const powers = { start: 'start', stop: 'stop', shutdown: 'shutdown', reboot: 'reboot' };
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/vms'); const vms = r.vms || [];
    return emit(r, () => (vms.length ? table(['ID', 'NAME', 'STATUS', 'VCPU', 'RAM', 'DISK', 'IPV4'], vms.map((v) => [v.id, v.name, v.status, v.vcpu, gb(v.ram_mb), `${v.disk_gb}G`, v.ipv4 || '—'])) : say('no VMs.')));
  }
  if (sub === 'get' || sub === 'show') {
    const id = need(pos[0], 'qc vm show <id>');
    const r = await api('GET', `/api/v1/vms/${id}`); const v = r.vm || {};
    return emit(r, () => { say(`#${v.id}  ${v.name}  [${v.status}]`); say(`spec  : ${v.vcpu} vCPU · ${gb(v.ram_mb)} RAM · ${v.disk_gb}G disk`); say(`ipv4  : ${v.ipv4 || '—'}`); if (v.ipv6) say(`ipv6  : ${v.ipv6}`); for (const p of v.priv_ips || []) say(`priv  : ${p.address}  (${p.network})`); });
  }
  if (powers[sub]) {
    const id = need(pos[0], `qc vm ${sub} <id>`);
    const r = await api('POST', `/api/v1/vms/${id}/power`, { action: powers[sub] });
    return emit(r, () => say(`${sub} queued (job ${r.job?.id}).`));
  }
  if (sub === 'create' || sub === 'new') {
    if (!flags.name) fail('usage: qc vm create --name <n> --vcpu <n> --ram <GB> --disk <GB> --os <template> [--ssh-key "<pub>"] [--user u] [--password p] [--user-data-file <path>] [--preset <name>] [--priv-net <id>] [--no-ip] [--wait]');
    if (!flags.os) fail('missing --os <template> — run `qc templates` to list them');
    const body = { name: flags.name, template: flags.os, vcpu: +flags.vcpu || 1, ram_mb: Math.round((+flags.ram || 1) * 1024), disk_gb: +flags.disk || 20, fields: {} };
    if (flags['no-ip']) body.ip = 'none';
    if (flags.user) body.fields.ciuser = flags.user;
    if (flags.password) body.fields.password = flags.password;
    if (flags['ssh-key']) body.fields.sshkeys = flags['ssh-key'];
    if (flags.preset && (flags['user-data'] || flags['user-data-file'])) fail('--preset and --user-data/--user-data-file are mutually exclusive — the preset IS the user-data');
    if (flags.preset) body.preset = flags.preset;   // a saved preset (qc preset list) — resolved server-side
    else if (flags['user-data']) body.fields.user_data = flags['user-data'];
    else if (flags['user-data-file']) { try { body.fields.user_data = fs.readFileSync(flags['user-data-file'], 'utf8'); } catch (e) { fail(`cannot read --user-data-file: ${e.message}`); } }
    if (flags['priv-net']) body.privNics = [{ networkId: +flags['priv-net'], ip: flags['priv-ip'] || undefined }];
    const r = await api('POST', '/api/v1/vms', body);
    if (flags.wait && r.job?.id) {
      if (!JSON_OUT) say(`creating '${body.name}' — VM #${r.vm?.id}, job ${r.job.id} …`);
      const j = await pollJob(r.job.id);
      if (j.status === 'failed') fail(`build failed — ${j.error || 'see panel'}`);
      const d = await api('GET', `/api/v1/vms/${r.vm.id}`); const v = d.vm || {};
      return emit(d, () => say(`ready: VM #${v.id} '${v.name}' [${v.status}]  ipv4: ${v.ipv4 || '—'}`));
    }
    return emit(r, () => say(`creating '${body.name}' — VM #${r.vm?.id}, job ${r.job?.id}. Poll:  qc job get ${r.job?.id}`));
  }
  if (sub === 'wait') {
    const id = need(pos[0], 'qc vm wait <id> [--status running|stopped]');
    const want = (flags.status || '').toLowerCase();
    for (;;) {
      const r = await api('GET', `/api/v1/vms/${id}`); const st = r.vm?.status;
      if (want ? st === want : (st === 'running' || st === 'stopped')) return emit(r, () => say(`VM #${id}: ${st}  ipv4: ${r.vm?.ipv4 || '—'}`));
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  if (sub === 'ssh') {
    const id = need(pos[0], 'qc vm ssh <id> [--user u]');
    const r = await api('GET', `/api/v1/vms/${id}`); const v = r.vm || {};
    const host = v.ipv4 || v.ipv6;
    if (!host) fail(`VM #${id} has no IP yet — try \`qc vm wait ${id}\` first`);
    const user = flags.user || 'root';
    const rest = pos.slice(1).filter((x) => x !== '--');
    const args = [`${user}@${host}`, ...rest];
    say(`ssh ${args.join(' ')}`);
    const res = spawnSync('ssh', args, { stdio: 'inherit' });
    if (res.error) fail(res.error.code === 'ENOENT' ? 'ssh not found on your PATH' : res.error.message);
    process.exit(res.status == null ? 1 : res.status);
  }
  if (sub === 'rename') {
    const id = need(pos[0], 'qc vm rename <id> <name>'); const name = need(pos[1], 'qc vm rename <id> <name>');
    const r = await api('PATCH', `/api/v1/vms/${id}`, { name });
    return emit(r, () => say(`renamed (job ${r.job?.id || '—'}).`));
  }
  if (sub === 'resize') {
    const id = need(pos[0], 'qc vm resize <id> [--vcpu n] [--ram GB] [--disk GB]');
    const body = {};
    if (flags.vcpu) body.vcpu = +flags.vcpu;
    if (flags.ram) body.ram_mb = Math.round(+flags.ram * 1024);
    if (flags.disk) body.disk_gb = +flags.disk;
    if (!Object.keys(body).length) fail('nothing to change — pass --vcpu / --ram / --disk');
    const r = await api('PATCH', `/api/v1/vms/${id}`, body);
    return emit(r, () => say(`resize queued (job ${r.job?.id}). CPU/RAM apply on the next stop/start.`));
  }
  if (sub === 'delete' || sub === 'rm') {
    const id = need(pos[0], 'qc vm delete <id>');
    if (!flags.yes && !flags.force) fail(`refusing without confirmation — re-run:  qc vm delete ${id} --yes`);
    const r = await api('DELETE', `/api/v1/vms/${id}`);
    return emit(r, () => say(`delete queued (job ${r.job?.id}).`));
  }
  fail(`unknown: vm ${sub} — try list, show, create, start, stop, shutdown, reboot, rename, resize, delete, wait, ssh`);
}

async function pollJob(id) {
  for (;;) {
    const r = await api('GET', `/api/v1/jobs/${id}`);
    const st = r.job?.status;
    if (st === 'done' || st === 'failed') return r.job;
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function cmdJob(pos) {
  const sub = (pos.shift() || 'get').toLowerCase();
  const id = need(pos[0], 'qc job get <id>   |   qc job wait <id>');
  if (sub === 'get') { const r = await api('GET', `/api/v1/jobs/${id}`); return emit(r, () => say(`job ${id}: ${r.job?.status}${r.job?.error ? ` — ${r.job.error}` : ''}`)); }
  if (sub === 'wait') {
    const j = await pollJob(id);
    return emit({ job: j }, () => say(`job ${id}: ${j.status}${j.error ? ` — ${j.error}` : ''}`));
  }
  fail('usage: qc job get|wait <id>');
}

async function cmdReseller(pos, flags) {
  if ((pos.shift() || '').toLowerCase() !== 'customers') fail('usage: qc reseller customers <list|create|show|suspend|resume|delete|sso> …');
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list') { const r = await api('GET', '/api/v1/reseller/customers'); const c = r.customers || []; return emit(r, () => (c.length ? table(['ID', 'LABEL', 'STATUS', 'EXT_REF'], c.map((x) => [x.id, x.label, x.status, x.ext_ref || '—'])) : say('no customers.'))); }
  if (sub === 'create') {
    if (!flags.label) fail('usage: qc reseller customers create --label <name> [--ext-ref <r>] [--vcpu n --ram GB --disk GB --ips n]');
    const body = { label: flags.label, ext_ref: flags['ext-ref'] };
    for (const [f, k] of [['vcpu', 'vcpu'], ['disk', 'disk_gb'], ['ips', 'ips'], ['bulk', 'bulk_gb']]) if (flags[f]) body[k] = +flags[f];
    if (flags.ram) body.ram_mb = Math.round(+flags.ram * 1024);
    const r = await api('POST', '/api/v1/reseller/customers', body);
    return emit(r, () => say(`created customer #${r.customer?.id} (${r.customer?.label}).`));
  }
  const id = need(pos[0], `qc reseller customers ${sub} <id|ext-ref>`);
  if (sub === 'show' || sub === 'get') { const r = await api('GET', `/api/v1/reseller/customers/${id}`); return emit(r, () => say(JSON.stringify(r.customer, null, 2))); }
  if (sub === 'suspend' || sub === 'resume') { const r = await api('POST', `/api/v1/reseller/customers/${id}/${sub}`); return emit(r, () => say(`${sub}d ${id}.`)); }
  if (sub === 'delete' || sub === 'rm') { if (!flags.yes) fail(`re-run with --yes to delete ${id}`); const r = await api('DELETE', `/api/v1/reseller/customers/${id}`); return emit(r, () => say(`deleted ${id}.`)); }
  if (sub === 'sso') { const r = await api('POST', `/api/v1/reseller/customers/${id}/sso`); return emit(r, () => say(r.url || '(no url)')); }
  fail(`unknown: reseller customers ${sub}`);
}

// Resolve a private network by numeric id or unique label (so `qc net attach
// web-2 db-net` works as well as by id).
async function resolveNet(arg) {
  if (/^\d+$/.test(String(arg))) return +arg;
  const r = await api('GET', '/api/v1/networks');
  const hits = (r.networks || []).filter((n) => n.label === arg);
  if (hits.length === 1) return hits[0].id;
  if (!hits.length) fail(`no private network named '${arg}' — run \`qc net list\``);
  fail(`multiple networks named '${arg}' — use the numeric id (qc net list)`);
}

async function cmdNet(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/networks'); const nets = r.networks || [];
    return emit(r, () => (nets.length ? table(['ID', 'LABEL', 'CIDR', 'GATEWAY', 'VNET'], nets.map((n) => [n.id, n.label, n.cidr, n.gateway || '—', n.vnet])) : say('no private networks.')));
  }
  if (sub === 'create' || sub === 'new') {
    const label = need(pos[0] || flags.label, 'qc net create <label> --cidr <CIDR> [--gateway <ip>]');
    if (!flags.cidr) fail('missing --cidr <CIDR> — e.g. 10.20.0.0/24');
    const r = await api('POST', '/api/v1/networks', { label, cidr: flags.cidr, gateway: flags.gateway });
    return emit(r, () => say(`created network #${r.network?.id} '${r.network?.label}' (${r.network?.cidr}).`));
  }
  if (sub === 'free-ips' || sub === 'ips') {
    const id = await resolveNet(need(pos[0], 'qc net free-ips <network>'));
    const r = await api('GET', `/api/v1/networks/${id}/free-ips`);
    return emit(r, () => say((r.ips || []).join('\n') || 'none free.'));
  }
  if (sub === 'rm' || sub === 'delete') {
    const id = await resolveNet(need(pos[0], 'qc net rm <network>'));
    if (!flags.yes && !flags.force) fail(`refusing without confirmation — re-run:  qc net rm ${id} --yes`);
    const r = await api('DELETE', `/api/v1/networks/${id}`);
    return emit(r, () => say(`deleted network ${id}.`));
  }
  if (sub === 'attach') {
    const vm = need(pos[0], 'qc net attach <vm-id> <network> [--ip <addr>]');
    const net = await resolveNet(need(pos[1], 'qc net attach <vm-id> <network> [--ip <addr>]'));
    const r = await api('POST', `/api/v1/vms/${vm}/nics`, { network: net, ip: flags.ip });
    return emit(r, () => say(`attaching network ${net} to VM ${vm} (job ${r.job?.id}). Poll:  qc job get ${r.job?.id}`));
  }
  if (sub === 'detach') {
    const vm = need(pos[0], 'qc net detach <vm-id> <nic-index>   (see `qc vm show <id>` for indices)');
    const nic = need(pos[1], 'qc net detach <vm-id> <nic-index>');
    const r = await api('DELETE', `/api/v1/vms/${vm}/nics/${nic}`);
    return emit(r, () => say(`detaching NIC ${nic} from VM ${vm} (job ${r.job?.id}).`));
  }
  fail(`unknown: net ${sub} — try list, create, free-ips, attach, detach, rm`);
}

async function cmdSnap(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const id = need(pos[0], 'qc snap list <vm-id>');
    const r = await api('GET', `/api/v1/vms/${id}/snapshots`); const snaps = r.snapshots || [];
    return emit(r, () => (snaps.length ? table(['ID', 'LABEL', 'RAM', 'STATUS', 'EXPIRES'], snaps.map((x) => [x.id, x.label || '—', x.with_ram ? 'yes' : 'no', x.status, x.expires_at || '—'])) : say('no snapshots.')));
  }
  if (sub === 'create' || sub === 'new') {
    const id = need(pos[0], 'qc snap create <vm-id> [<label>] [--ram]');
    const r = await api('POST', `/api/v1/vms/${id}/snapshots`, { note: pos[1] || flags.note, with_ram: !!flags.ram });
    return emit(r, () => say(`creating snapshot #${r.snapshot?.id} (job ${r.job?.id}). Poll:  qc job get ${r.job?.id}`));
  }
  if (sub === 'rollback' || sub === 'restore') {
    const id = need(pos[0], 'qc snap rollback <vm-id> <snap-id>');
    const snap = need(pos[1], 'qc snap rollback <vm-id> <snap-id>');
    if (!flags.yes && !flags.force) fail(`rollback DISCARDS changes made since the snapshot — re-run:  qc snap rollback ${id} ${snap} --yes`);
    const r = await api('POST', `/api/v1/vms/${id}/snapshots/${snap}/rollback`);
    return emit(r, () => say(`rolling back to snapshot ${snap} (job ${r.job?.id}).`));
  }
  if (sub === 'rm' || sub === 'delete') {
    const id = need(pos[0], 'qc snap rm <vm-id> <snap-id>');
    const snap = need(pos[1], 'qc snap rm <vm-id> <snap-id>');
    const r = await api('DELETE', `/api/v1/vms/${id}/snapshots/${snap}`);
    return emit(r, () => say(`deleting snapshot ${snap} (job ${r.job?.id}).`));
  }
  fail(`unknown: snap ${sub} — try list, create, rollback, rm`);
}

async function cmdBackup(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const id = need(pos[0], 'qc backup list <vm-id>');
    const r = await api('GET', `/api/v1/vms/${id}/backups`); const bks = r.backups || [];
    return emit(r, () => (bks.length ? table(['CREATED', 'SIZE', 'NOTES', 'VOLID'], bks.map((b) => [b.created_at || '—', b.size != null ? gib(b.size) : '—', b.notes || '—', b.volid])) : say('no backups.')));
  }
  if (sub === 'create' || sub === 'new') {
    const id = need(pos[0], 'qc backup create <vm-id> [--note "…"]');
    const r = await api('POST', `/api/v1/vms/${id}/backups`, { note: flags.note });
    return emit(r, () => say(`backup queued for VM ${id} (job ${r.job?.id}). Poll:  qc job get ${r.job?.id}`));
  }
  if (sub === 'restore') {
    const id = need(pos[0], 'qc backup restore <vm-id> <volid>');
    const volid = need(pos[1], 'qc backup restore <vm-id> <volid>');
    if (!flags.yes && !flags.force) fail(`restore OVERWRITES the VM disks from the backup — re-run:  qc backup restore ${id} '${volid}' --yes`);
    const r = await api('POST', `/api/v1/vms/${id}/backups/restore`, { volid });
    return emit(r, () => say(`restoring VM ${id} from backup (job ${r.job?.id}).`));
  }
  if (sub === 'rm' || sub === 'delete') {
    const id = need(pos[0], 'qc backup rm <vm-id> <volid>');
    const volid = need(pos[1], 'qc backup rm <vm-id> <volid>');
    if (!flags.yes && !flags.force) fail(`re-run with --yes to delete the backup:  qc backup rm ${id} '${volid}' --yes`);
    const r = await api('DELETE', `/api/v1/vms/${id}/backups`, { volid });
    return emit(r, () => say(`deleting backup (job ${r.job?.id}).`));
  }
  fail(`unknown: backup ${sub} — try list, create, restore, rm`);
}

// Saved cloud-init presets — save a bootstrap document once (RMM agent,
// monitoring, hardening), then `qc vm create --preset <name>` on every deploy.
async function cmdPreset(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/presets'); const presets = r.presets || [];
    return emit(r, () => (presets.length
      ? table(['NAME', 'SIZE', 'UPDATED'], presets.map((p) => [p.name, `${Math.max(1, Math.round((p.bytes || 0) / 1024))}K`, (p.updated_at || p.created_at || '').slice(0, 16)]))
      : say('no presets yet — save one:  qc preset save <name> --file cloud-init.yml')));
  }
  if (sub === 'save' || sub === 'set') {
    const name = need(pos[0], 'qc preset save <name> --file <path>   (or pipe:  cat init.yml | qc preset save <name>)');
    let content = '';
    if (flags.file) { try { content = fs.readFileSync(flags.file, 'utf8'); } catch (e) { fail(`cannot read --file: ${e.message}`); } }
    else if (!process.stdin.isTTY) { content = fs.readFileSync(0, 'utf8'); }
    if (!content.trim()) fail('nothing to save — pass --file <path> or pipe the document on stdin');
    const r = await api('PUT', `/api/v1/presets/${encodeURIComponent(name)}`, { content });
    return emit(r, () => say(`${r.preset?.created ? 'saved' : 'updated'} '${r.preset?.name}' (${r.preset?.bytes} bytes). Use it:  qc vm create … --preset ${r.preset?.name}`));
  }
  if (sub === 'show' || sub === 'get' || sub === 'cat') {
    const name = need(pos[0], 'qc preset show <name>');
    const r = await api('GET', `/api/v1/presets/${encodeURIComponent(name)}`);
    return emit(r, () => process.stdout.write(r.preset?.content || ''));   // raw — pipeable back to a file
  }
  if (sub === 'rm' || sub === 'delete') {
    const name = need(pos[0], 'qc preset rm <name> --yes');
    if (!flags.yes && !flags.force) fail(`refusing without confirmation — re-run:  qc preset rm ${name} --yes`);
    const r = await api('DELETE', `/api/v1/presets/${encodeURIComponent(name)}`);
    return emit(r, () => say(`deleted '${name}'. VMs already created from it are unaffected.`));
  }
  fail(`unknown: preset ${sub} — try list, save, show, rm`);
}

// --- dedicated servers -------------------------------------------------------
// Bare metal leased by the hour: browse stock, buy, (re)install, power, rescue,
// IPs, RAID. Hardware jobs are polled through the server's own job route.
const money = (n) => (n == null ? '—' : `£${Number(n).toFixed(2)}`);
// Stock rows carry cpu/ram_gb/disks flat; the owned-server detail carries the raw quick-spec JSON string.
const specLine = (d) => { let o = d; if (typeof d === 'string') { try { o = JSON.parse(d); } catch { return d; } } return o && typeof o === 'object' ? ([o.cpu, o.ram_gb ? `${o.ram_gb} GB` : null, o.disks].filter(Boolean).join(' · ') || '—') : '—'; };
// Install flags shared by `dedi buy --os` and `dedi reinstall`.
function installBody(flags) {
  const b = {};
  if (flags.os) b.template = flags.os;
  if (flags.hostname) b.hostname = flags.hostname;
  if (flags.nameservers) b.nameservers = flags.nameservers;
  if (flags.user) b.ssh_user = flags.user;
  if (flags.password) b.ssh_password = flags.password;
  if (flags['ssh-key']) b.ssh_keys = flags['ssh-key'];
  if (flags['ssh-key-file']) b.ssh_keys = fs.readFileSync(flags['ssh-key-file'], 'utf8');
  if (flags['root-ssh']) b.root_ssh = true;
  if (flags.fs) b.fs = flags.fs;
  return b;
}
async function pollDediJob(id, jobId) {
  for (;;) {
    const r = await api('GET', `/api/v1/dedicated/${id}/jobs/${jobId}`);
    if (r.job?.done) return r.job;
    await new Promise((res) => setTimeout(res, 2000));
  }
}
function sayArm(r) {
  if (r.rootPassword) { say(`root / console password: ${r.rootPassword}`); say('  (shown ONCE - it is not retrievable later; re-arm if lost)'); }
  if (r.sshLogin) say(`ssh login             : ${r.sshLogin}`);
  if (r.until) say(`armed until           : ${r.until}`);
  if (r.booting) say('booting into the installer now.');
  else if (r.bootError) say(`not booted: ${r.bootError}`);
  if (r.jobId) say(`boot job              : ${r.jobId}   (qc dedi job <id> ${r.jobId})`);
}
async function cmdDedi(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/dedicated'); const ds = r.dedicated || [];
    return emit(r, () => (ds.length ? table(['ID', 'LABEL', 'MODEL', 'STATUS', 'POWER', 'OS', 'SITE'], ds.map((d) => [d.id, d.label, d.model || '—', d.suspension ? 'suspended' : d.status, d.power_state || '—', d.installed_os || '—', d.site_name || '—'])) : say('no dedicated servers.')));
  }
  if (sub === 'stock') {
    const r = await api('GET', '/api/v1/dedicated/stock'); const st = r.stock || [];
    return emit(r, () => {
      if (!st.length) return say('nothing in stock right now.');
      table(['ID', 'MODEL', 'SPEC', '£/HR', '£/MO MAX', 'SITE', 'OS CHOICES'], st.map((s) => [s.id, s.model || '—', specLine(s), Number(s.price_hr).toFixed(3), money(s.price_month_max ?? s.price_hr * 672), s.site || '—', (s.templates || []).filter((t) => !t.incompatible).map((t) => t.id).join(',') || '—']));
      say(`\nminimum rental ${r.min_bill_hours}h, charged up front (you need credit for ${r.min_hours_credit}h).  Buy:  qc dedi buy <id> [--os <template> …]`);
    });
  }
  if (sub === 'buy') {
    const id = need(pos[0], 'qc dedi buy <stock-id> [--os <template> --hostname h --user u --password p | --ssh-key "<pub>"] [--no-boot] --yes');
    if (!flags.yes) fail(`buying charges the minimum rental from your credit at once - re-run:  qc dedi buy ${id} … --yes`);
    const body = installBody(flags);
    if (flags['no-boot']) body.boot = false;
    const r = await api('POST', `/api/v1/dedicated/stock/${id}/buy`, body, { 'Idempotency-Key': `qc-buy-${id}-${Date.now()}` });
    return emit(r, () => {
      say(`bought server #${r.id} (${r.label}) - ${money(r.charged)} charged for ${r.bill_hours}h, balance ${money(r.balance)}.`);
      if (r.address) say(`ipv4                  : ${r.address}`);
      if (r.ipNote) say(`note: ${r.ipNote}`);
      if (r.installError) say(`install: ${r.installError}`);
      sayArm(r);
    });
  }
  const id = need(pos[0], `qc dedi ${sub} <id>`);
  if (sub === 'show' || sub === 'get') {
    const r = await api('GET', `/api/v1/dedicated/${id}`); const d = r.server || {};
    return emit(r, () => {
      say(`#${d.id}  ${d.label}  [${d.suspension ? 'suspended' : d.status}]  ${d.model || ''}`);
      say(`spec    : ${specLine(d.specs)}`);
      say(`power   : ${d.power_state || '—'}${d.wall_power ? ` (wall ${d.wall_power})` : ''}   bmc: ${d.has_bmc ? 'yes' : 'no'}`);
      say(`os      : ${d.installed_os || '—'}${d.pxe_armed ? `   [install armed: ${d.pxe_template}]` : d.pxe_rescue_armed ? '   [rescue armed]' : d.pxe_netboot_armed ? '   [netboot armed]' : ''}`);
      for (const ip of d.ips || []) say(`ip      : ${ip.address}/${String(ip.cidr || '').split('/')[1] || ''}${ip.is_primary ? '  (primary)' : ''}${ip.ptr ? `  ptr ${ip.ptr}` : ''}   [#${ip.id}]`);
      if ((d.raid_arrays || []).length) say(`raid    : ${d.raid_arrays.map((a) => `${a.level || a.raid || '?'} ${a.size_gb ? a.size_gb + 'G' : ''}`).join(', ')}`);
      if (d.price_hr_micro) say(`price   : £${(d.price_hr_micro / 1e6).toFixed(3)}/h (hourly lease)`);
      if (d.suspension) say(`SUSPENDED: ${d.suspension.reason || ''}${d.suspension.release_at ? ` - released ${d.suspension.release_at}` : ''}`);
      say(`os templates: ${(d.templates || []).filter((t) => !t.incompatible).map((t) => t.id).join(', ') || '—'}`);
    });
  }
  if (sub === 'reinstall') {
    if (!flags.os) fail('usage: qc dedi reinstall <id> --os <template> [--hostname h] [--user u --password p | --ssh-key "<pub>" | --ssh-key-file p] [--root-ssh] [--fs ext4|xfs] [--boot] --yes');
    if (!flags.yes) fail(`reinstall WIPES server ${id} - re-run with --yes`);
    const body = installBody(flags); if (flags.boot) body.boot = true;
    const r = await api('POST', `/api/v1/dedicated/${id}/reinstall`, body);
    return emit(r, () => { say(`install armed on #${id}: ${r.templateName || flags.os}`); sayArm(r); if (!flags.boot) say('reboot the server to start it:  qc dedi reboot ' + id); });
  }
  const powers = { on: 'on', off: 'off', reboot: 'reboot', status: 'status' };
  if (powers[sub]) {
    const r = await api('POST', `/api/v1/dedicated/${id}/power`, { action: powers[sub] });
    if (flags.wait && r.jobId) { const j = await pollDediJob(id, r.jobId); return emit({ ...r, job: j }, () => say(`${sub}: ${j.ok ? 'ok' : 'failed'}${j.power ? ` - power ${j.power}` : ''}${j.error ? ` - ${j.error}` : ''}`)); }
    return emit(r, () => say(`${sub} queued (job ${r.jobId}).  qc dedi job ${id} ${r.jobId} --wait`));
  }
  if (sub === 'rescue' || sub === 'netboot') {
    if (!flags.yes) fail(`this reboots server ${id} into the ${sub} system - re-run with --yes`);
    const r = await api('POST', `/api/v1/dedicated/${id}/${sub}`, { boot: !flags['no-boot'] });
    return emit(r, () => { say(`${sub} armed on #${id}.`); sayArm(r); });
  }
  if (sub === 'disarm') { const r = await api('POST', `/api/v1/dedicated/${id}/disarm`, {}); return emit(r, () => say(`disarmed - the next boot goes to local disk.`)); }
  if (sub === 'console') {
    const mode = (flags.mode || 'sol').toLowerCase();
    const r = await api('POST', `/api/v1/dedicated/${id}/console`, { mode });
    return emit(r, () => { say(`${mode} console session minted (single-use): ${r.session}`); say(`open it in the panel's console page - the tunnel is a browser websocket.`); });
  }
  if (sub === 'console-clear') { const r = await api('POST', `/api/v1/dedicated/${id}/console-clear`, {}); return emit(r, () => say(`clearing console sessions (job ${r.jobId}).`)); }
  if (sub === 'bmc-reset') { if (!flags.yes) fail('re-run with --yes to reset the management controller'); const r = await api('POST', `/api/v1/dedicated/${id}/bmc-reset`, {}); return emit(r, () => say(`BMC reset queued (job ${r.jobId}).`)); }
  if (sub === 'job') {
    const jobId = need(pos[1], 'qc dedi job <id> <job-id> [--wait]');
    const j = flags.wait ? await pollDediJob(id, jobId) : (await api('GET', `/api/v1/dedicated/${id}/jobs/${jobId}`)).job;
    return emit({ job: j }, () => say(`job ${jobId}: ${j.done ? (j.ok ? 'done' : 'failed') : 'running'}${j.power ? ` - power ${j.power}` : ''}${j.storage_status ? ` - ${j.storage_status}` : ''}${j.error ? ` - ${j.error}` : ''}`));
  }
  if (sub === 'bandwidth' || sub === 'bw') {
    const r = await api('GET', `/api/v1/dedicated/${id}/bandwidth?hours=${+flags.hours || 24}`);
    return emit(r, () => { say(JSON.stringify({ bill: r.bill || null, over: r.over || null }, null, 2)); });
  }
  if (sub === 'ips') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/dedicated/${id}`); const ips = r.server?.ips || []; return emit({ ips }, () => table(['ID', 'ADDRESS', 'CIDR', 'GATEWAY', 'PRIMARY', 'PTR'], ips.map((i) => [i.id, i.address, i.cidr || '—', i.gateway || '—', i.is_primary ? 'yes' : '', i.ptr || '—']))); }
    if (act === 'add') { const r = await api('POST', `/api/v1/dedicated/${id}/ips`, flags.address ? { address: flags.address } : {}); return emit(r, () => say(`added ${r.address || JSON.stringify(r)}`)); }
    if (act === 'rm' || act === 'release') { const ipId = need(pos[2], 'qc dedi ips <id> rm <ip-id> --yes'); if (!flags.yes) fail('re-run with --yes to release the address'); const r = await api('DELETE', `/api/v1/dedicated/${id}/ips/${ipId}`, flags['pay-cleanup-fee'] ? { pay_cleanup_fee: true } : {}); return emit(r, () => say('released.')); }
    if (act === 'primary') { const ipId = need(pos[2], 'qc dedi ips <id> primary <ip-id>'); const r = await api('POST', `/api/v1/dedicated/${id}/ips/${ipId}/primary`, {}); return emit(r, () => say('primary set.')); }
    fail('usage: qc dedi ips <id> list|add [--address a]|rm <ip-id> --yes|primary <ip-id>');
  }
  if (sub === 'storage' || sub === 'raid') {
    const act = (pos[1] || 'show').toLowerCase();
    if (act === 'show') {
      const r = await api('GET', `/api/v1/dedicated/${id}/storage`);
      return emit(r, () => {
        if (!r.discovered) return say(`no discovery yet${r.busy ? ' (one is running)' : ''} - run:  qc dedi storage ${id} discover`);
        say(`discovered ${r.at}${r.busy ? '  [job running]' : ''}${r.health ? `   health: ${r.health.status}` : ''}${r.os_vd ? `   os array: ${r.os_vd}` : ''}`);
        for (const c of r.controllers || []) say(`controller: ${c.fqdd || c.id || c.name || JSON.stringify(c)}`);
        if ((r.arrays || []).length) table(['ARRAY', 'LEVEL', 'SIZE', 'STATE', 'DISKS'], r.arrays.map((a) => [a.fqdd || a.id, a.level || a.raid || '—', a.size_gb ? `${a.size_gb}G` : (a.size || '—'), a.state || '—', (a.disks || []).length]));
        if ((r.disks || []).length) table(['DISK', 'SIZE', 'MEDIA', 'STATE'], r.disks.map((d) => [d.fqdd || d.id, d.size_gb ? `${d.size_gb}G` : (d.size || '—'), d.media || '—', d.state || '—']));
      });
    }
    if (act === 'discover') { const r = await api('POST', `/api/v1/dedicated/${id}/storage/discover`, {}); return emit(r, () => say(`discovery queued (job ${r.jobId}) - then:  qc dedi storage ${id} show`)); }
    if (act === 'apply') {
      if (!flags.file) fail('usage: qc dedi storage <id> apply --file plan.json --yes   (plan: {"controller":"<fqdd>","arrays":[{"level":"RAID1","disks":["<fqdd>","<fqdd>"]}]})');
      if (!flags.yes) fail('applying a RAID layout WIPES the arrays - re-run with --yes');
      const r = await api('POST', `/api/v1/dedicated/${id}/storage/apply`, JSON.parse(fs.readFileSync(flags.file, 'utf8')));
      return emit(r, () => say(`RAID apply queued (job ${r.jobId}).`));
    }
    if (act === 'boot-vd') { const vd = need(pos[2], 'qc dedi storage <id> boot-vd <array-fqdd>'); const r = await api('POST', `/api/v1/dedicated/${id}/storage/boot-vd`, { vd }); return emit(r, () => say(`boot array set (job ${r.jobId}).`)); }
    fail('usage: qc dedi storage <id> show|discover|apply --file p --yes|boot-vd <fqdd>');
  }
  if (sub === 'release') {
    if (!flags.yes) fail(`release hands server ${id} back and WIPES it; billing stops - re-run with --yes`);
    const r = await api('POST', `/api/v1/dedicated/${id}/release`, {}, { 'Idempotency-Key': `qc-release-${id}-${Date.now()}` });
    return emit(r, () => say(`released #${id}.${r.wiping ? ' wiping.' : ''}`));
  }
  fail(`unknown: dedi ${sub} - try list, stock, buy, show, reinstall, on, off, reboot, status, rescue, netboot, disarm, console, job, bandwidth, ips, storage, release`);
}

// --- Cloud Firewall -------------------------------------------------------------
// A managed OPNsense appliance (or HA pair) in front of your servers: rules,
// port forwards, VPN users, networks, 1:1 NAT, site-to-site tunnels.
const idemKey = (what) => ({ 'Idempotency-Key': `qc-${what}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
async function cmdFw(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/firewalls'); const fws = r.firewalls || [];
    return emit(r, () => (fws.length ? table(['ID', 'LABEL', 'NAME', 'SIZE', 'HA', 'STATUS', 'WAN', 'LANS'], fws.map((f) => [f.id, f.label, f.name, f.size, f.ha ? 'yes' : '', f.status, (f.wan_ips || []).join(','), (f.lans || []).map((l) => l.cidr).join(',')])) : say('no firewalls.  Create one:  qc fw create --label edge --size small --yes')));
  }
  if (sub === 'sizes') {
    const r = await api('GET', '/api/v1/firewalls');
    return emit(r, () => { table(['SIZE', 'SPEC', '£/HR', '£/MO'], Object.keys(r.sizes || {}).map((k) => [k, `${r.sizes[k].vcpu} vCPU · ${gb(r.sizes[k].ram_mb)}`, r.prices?.[k]?.hourly ?? '—', r.prices?.[k]?.monthly ?? '—'])); say(`\nmin public IPs: single ${r.min_ips?.single}, HA pair ${r.min_ips?.ha} · max ${r.max_ips} IPs, ${r.max_lans} networks, ${r.max_per_ws} firewalls`); });
  }
  if (sub === 'create' || sub === 'new') {
    if (!flags.label) fail('usage: qc fw create --label <name> [--size small|medium|large] [--ha] [--ips n] [--lan 10.90.0.0/24] [--no-dhcp] [--subnet <id> --address <ip>] --yes');
    if (!flags.yes) fail('a firewall bills hourly from creation - re-run with --yes');
    const body = { label: flags.label, size: flags.size || 'small', ha: !!flags.ha };
    if (flags.ips) body.public_ips = +flags.ips;
    if (flags.lan) body.lan_cidr = flags.lan;
    if (flags['no-dhcp']) body.dhcp_enabled = false;
    if (flags.subnet) { body.existing_subnet_id = +flags.subnet; if (flags.address) body.address = flags.address; }
    if (flags.port) body.port_mbps = +flags.port;
    const r = await api('POST', '/api/v1/firewalls', body, idemKey('fw-create'));
    return emit(r, () => { say(`firewall #${r.firewall?.id} (${r.firewall?.name}) is building - job ${r.jobId}${r.jobIdB ? ` + ${r.jobIdB}` : ''}.`); if (r.admin_password) { say(`appliance admin password: ${r.admin_password}`); say('  (shown ONCE - store it now)'); } say(`watch:  qc fw show ${r.firewall?.id}`); });
  }
  const id = need(pos[0], `qc fw ${sub} <id>`);
  const show = (r) => {
    const f = r.firewall || {};
    say(`#${f.id}  ${f.label}  (${f.name})  [${f.status}]  ${f.size}${f.ha ? ' · HA pair' : ''}`);
    say(`wan     : ${(f.wan_ips || []).join(', ') || '—'}   admin ui: ${f.admin_access || 'any'}`);
    for (const l of f.lans || []) say(`lan #${l.id}: ${l.label || 'LAN'}  ${l.cidr}  gw ${l.gateway}${l.dhcp_from ? `  dhcp ${l.dhcp_from}-${l.dhcp_to}` : ''}${(l.vms || []).length ? `  servers: ${l.vms.map((v) => `${v.name || v.vm_id}@${v.address || 'dhcp'}`).join(', ')}` : ''}`);
    if ((f.rules || []).length) { say('rules   :'); table(['  ID', 'ACTION', 'PROTO', 'FROM', 'PORT', 'ON', 'LABEL'], f.rules.map((x) => ['  ' + x.id, x.action, x.proto, x.src_cidr || 'any', x.dport || '—', x.enabled ? 'yes' : 'no', x.label || ''])); }
    if ((f.forwards || []).length) { say('forwards:'); table(['  ID', 'PROTO', 'PUBLIC', 'TARGET', 'ON', 'LABEL'], f.forwards.map((x) => ['  ' + x.id, x.proto, `${x.wan_ip}:${x.wan_port}`, `${x.dst_ip}:${x.dst_port}`, x.enabled ? 'yes' : 'no', x.label || ''])); }
    if ((f.nat1 || []).length) { say('1:1 nat :'); table(['  ID', 'PUBLIC', 'TARGET', 'INBOUND', 'ON'], f.nat1.map((x) => ['  ' + x.id, x.wan_ip, x.dst_ip, x.inbound ? 'yes' : 'no', x.enabled ? 'yes' : 'no'])); }
    if ((f.vpn_users || []).length) say(`vpn     : ${f.vpn_users.map((u) => `${u.username} (#${u.id}${u.profile_ready ? ', profile ready' : ''})`).join(', ')}`);
    if ((f.tunnels || []).length) say(`tunnels : ${f.tunnels.map((t) => `${t.label} (#${t.id}, ${t.state || '?'})`).join(', ')}`);
    if (f.cost) say(`cost    : ${money(f.cost.monthly_max)}/mo max · £${f.cost.hourly}/h`);
    if (f.update?.available) say(`update  : OPNsense ${f.update.latest || ''} available -  qc fw update ${f.id} --yes`);
  };
  if (sub === 'show' || sub === 'get') { const r = await api('GET', `/api/v1/firewalls/${id}`); return emit(r, () => show(r)); }
  if (sub === 'rename') { const label = need(pos[1], 'qc fw rename <id> <label>'); const r = await api('PATCH', `/api/v1/firewalls/${id}`, { label }); return emit(r, () => say(`renamed to ${r.firewall?.label}.`)); }
  if (sub === 'set') {
    const body = {};
    if (flags['admin-access']) body.admin_access = flags['admin-access'];
    if (flags.alerts != null) body.alerts = flags.alerts !== 'off' && flags.alerts !== 'false';
    if (flags.port) body.port_mbps = +flags.port;
    if (!Object.keys(body).length) fail('usage: qc fw set <id> [--admin-access any|rules] [--alerts on|off] [--port <mbps>]');
    const r = await api('PATCH', `/api/v1/firewalls/${id}`, body); return emit(r, () => say('updated.'));
  }
  if (sub === 'rules' || sub === 'rule') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/firewalls/${id}`); return emit({ rules: r.firewall?.rules || [] }, () => table(['ID', 'ACTION', 'PROTO', 'FROM', 'PORT', 'ON', 'LABEL'], (r.firewall?.rules || []).map((x) => [x.id, x.action, x.proto, x.src_cidr || 'any', x.dport || '—', x.enabled ? 'yes' : 'no', x.label || '']))); }
    if (act === 'add') {
      const body = { action: flags.block ? 'block' : 'pass', proto: flags.proto || 'tcp' };
      if (flags.port) body.dport = String(flags.port);
      if (flags.from) body.src_cidr = flags.from;
      if (flags.label) body.label = flags.label;
      if (!body.dport && !['icmp', 'any'].includes(body.proto)) fail('usage: qc fw rules <id> add --port 443 [--proto tcp|udp|icmp|any] [--from <cidr>] [--block] [--label "…"]');
      const r = await api('POST', `/api/v1/firewalls/${id}/rules`, body); return emit(r, () => say(`rule added (${r.rules?.length} rules now).`));
    }
    const rid = need(pos[2], `qc fw rules <id> ${act} <rule-id>`);
    if (act === 'rm' || act === 'delete') { const r = await api('DELETE', `/api/v1/firewalls/${id}/rules/${rid}`); return emit(r, () => say('rule removed.')); }
    if (act === 'enable' || act === 'disable') { const r = await api('PATCH', `/api/v1/firewalls/${id}/rules/${rid}`, { enabled: act === 'enable' }); return emit(r, () => say(`rule ${act}d.`)); }
    fail('usage: qc fw rules <id> list|add|rm <rid>|enable <rid>|disable <rid>');
  }
  if (sub === 'forwards' || sub === 'forward') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/firewalls/${id}`); return emit({ forwards: r.firewall?.forwards || [] }, () => table(['ID', 'PROTO', 'PUBLIC', 'TARGET', 'FROM', 'ON', 'LABEL'], (r.firewall?.forwards || []).map((x) => [x.id, x.proto, `${x.wan_ip}:${x.wan_port}`, `${x.dst_ip}:${x.dst_port}`, x.src_cidr || 'any', x.enabled ? 'yes' : 'no', x.label || '']))); }
    if (act === 'add') {
      if (!flags.port || !flags.to) fail('usage: qc fw forwards <id> add --port <public> --to <lan-ip>[:port] [--proto tcp|udp] [--wan-ip <ip>] [--lan <lan-id>] [--from <cidr>] [--label "…"]');
      const [dst_ip, dst_port] = String(flags.to).split(':');
      const body = { proto: flags.proto || 'tcp', wan_port: String(flags.port), dst_ip, dst_port: dst_port || String(flags.port) };
      if (flags['wan-ip']) body.wan_ip = flags['wan-ip'];
      if (flags.lan) body.lan_id = +flags.lan;
      if (flags.from) body.src_cidr = flags.from;
      if (flags.label) body.label = flags.label;
      const r = await api('POST', `/api/v1/firewalls/${id}/forwards`, body); return emit(r, () => say(`forward added (${r.forwards?.length} now).`));
    }
    const fid = need(pos[2], `qc fw forwards <id> ${act} <forward-id>`);
    if (act === 'rm' || act === 'delete') { const r = await api('DELETE', `/api/v1/firewalls/${id}/forwards/${fid}`); return emit(r, () => say('forward removed.')); }
    if (act === 'enable' || act === 'disable') { const r = await api('PATCH', `/api/v1/firewalls/${id}/forwards/${fid}`, { enabled: act === 'enable' }); return emit(r, () => say(`forward ${act}d.`)); }
    fail('usage: qc fw forwards <id> list|add|rm <fid>|enable <fid>|disable <fid>');
  }
  if (sub === 'vpn') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/firewalls/${id}`); return emit({ vpn_users: r.firewall?.vpn_users || [] }, () => table(['ID', 'USERNAME', 'SERIAL', 'PROFILE'], (r.firewall?.vpn_users || []).map((u) => [u.id, u.username, u.serial ?? '—', u.profile_ready ? 'ready - download once' : (u.profile_downloaded ? 'downloaded' : 'issuing…')]))); }
    if (act === 'add') { const username = need(pos[2], 'qc fw vpn <id> add <username>'); const r = await api('POST', `/api/v1/firewalls/${id}/vpn-users`, { username }); return emit(r, () => say(`VPN user ${username} added - the appliance issues the certificate; then:  qc fw vpn ${id} profile <uid> --out ${username}.ovpn`)); }
    const uid = need(pos[2], `qc fw vpn <id> ${act} <user-id>`);
    if (act === 'rm' || act === 'delete') { const r = await api('DELETE', `/api/v1/firewalls/${id}/vpn-users/${uid}`); return emit(r, () => say('VPN user removed.')); }
    if (act === 'regenerate' || act === 'regen') { const r = await api('POST', `/api/v1/firewalls/${id}/vpn-users/${uid}/regenerate`, {}); return emit(r, () => say('new certificate issuing - download the new profile once it is ready.')); }
    if (act === 'profile') { const out = flags.out || `vpn-${uid}.ovpn`; const text = await apiText(`/api/v1/firewalls/${id}/vpn-users/${uid}/profile`); fs.writeFileSync(out, text, { mode: 0o600 }); return say(`profile saved to ${out} (one-time download - the server copy is gone).`); }
    fail('usage: qc fw vpn <id> list|add <username>|rm <uid>|regenerate <uid>|profile <uid> [--out file.ovpn]');
  }
  if (sub === 'lans' || sub === 'lan' || sub === 'networks') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/firewalls/${id}`); return emit({ lans: r.firewall?.lans || [] }, () => table(['ID', 'LABEL', 'CIDR', 'GATEWAY', 'DHCP', 'SERVERS'], (r.firewall?.lans || []).map((l) => [l.id, l.label || 'LAN', l.cidr, l.gateway, l.dhcp_from ? `${l.dhcp_from}-${l.dhcp_to}` : 'off', (l.vms || []).map((v) => v.name || v.vm_id).join(',')]))); }
    if (act === 'add') {
      if (!flags.cidr && !flags.subnet) fail('usage: qc fw lans <id> add --cidr 10.91.0.0/24 [--label "…"] [--no-dhcp]   |   --subnet <id> --address <ip>');
      const body = {};
      if (flags.cidr) body.lan_cidr = flags.cidr;
      if (flags.subnet) { body.subnet_id = +flags.subnet; body.address = flags.address; }
      if (flags.label) body.label = flags.label;
      if (flags['no-dhcp']) body.dhcp_enabled = false;
      const r = await api('POST', `/api/v1/firewalls/${id}/lans`, body); return emit(r, () => say(`network added (${r.firewall?.lans?.length} now).`));
    }
    const lid = need(pos[2], `qc fw lans <id> ${act} <lan-id>`);
    if (act === 'rm' || act === 'delete') { if (!flags.yes) fail('re-run with --yes to remove the network'); const r = await api('DELETE', `/api/v1/firewalls/${id}/lans/${lid}`); return emit(r, () => say('network removed.')); }
    if (act === 'attach') { const vm = need(pos[3], 'qc fw lans <id> attach <lan-id> <vm-id> [--address <ip>]'); const body = { vm_id: +vm }; if (flags.address) { body.addr_mode = 'fixed'; body.address = flags.address; } const r = await api('POST', `/api/v1/firewalls/${id}/lans/${lid}/vms`, body); return emit(r, () => say(`VM ${vm} attached to network ${lid}.`)); }
    if (act === 'detach') { const vm = need(pos[3], 'qc fw lans <id> detach <lan-id> <vm-id>'); const r = await api('DELETE', `/api/v1/firewalls/${id}/lans/${lid}/vms/${vm}`); return emit(r, () => say(`VM ${vm} detached.`)); }
    if (act === 'private-only') { const vm = need(pos[3], 'qc fw lans <id> private-only <lan-id> <vm-id> --yes'); if (!flags.yes) fail(`this RELEASES VM ${vm}'s public IP - re-run with --yes`); const r = await api('POST', `/api/v1/firewalls/${id}/lans/${lid}/vms/${vm}/private-only`, {}); return emit(r, () => say(`VM ${vm} going private-only (job ${r.jobId || '?'}).`)); }
    if (act === 'addresses' || act === 'free') { const r = await api('GET', `/api/v1/firewalls/${id}/lans/${lid}/addresses`); return emit(r, () => say(JSON.stringify(r, null, 2))); }
    fail('usage: qc fw lans <id> list|add|rm <lid> --yes|attach <lid> <vm-id>|detach <lid> <vm-id>|private-only <lid> <vm-id> --yes|addresses <lid>');
  }
  if (sub === 'wan' || sub === 'ips') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/firewalls/${id}`); return emit({ wan_addresses: r.firewall?.wan_addresses || [] }, () => table(['ID', 'ADDRESS', 'PRIMARY', 'NAT1', 'FORWARDS', 'REMOVABLE'], (r.firewall?.wan_addresses || []).map((a) => [a.id, a.address, a.primary ? 'yes' : '', a.nat1 ? a.nat1.dst_ip || 'yes' : '', a.forwards ?? 0, a.removable ? 'yes' : 'no']))); }
    if (act === 'add') { const r = await api('POST', `/api/v1/firewalls/${id}/wan`, {}); return emit(r, () => say(`public address added: ${(r.firewall?.wan_ips || []).join(', ')}`)); }
    if (act === 'rm' || act === 'delete') { const ipid = need(pos[2], 'qc fw wan <id> rm <ip-id> --yes'); if (!flags.yes) fail('re-run with --yes to release the address'); const r = await api('DELETE', `/api/v1/firewalls/${id}/wan/${ipid}`); return emit(r, () => say('address released.')); }
    fail('usage: qc fw wan <id> list|add|rm <ip-id> --yes');
  }
  if (sub === 'nat1' || sub === 'nat') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/firewalls/${id}`); return emit({ nat1: r.firewall?.nat1 || [] }, () => table(['ID', 'PUBLIC', 'TARGET', 'INBOUND', 'ON', 'LABEL'], (r.firewall?.nat1 || []).map((x) => [x.id, x.wan_ip, x.dst_ip, x.inbound ? 'yes' : 'no', x.enabled ? 'yes' : 'no', x.label || '']))); }
    if (act === 'add') {
      if (!flags.to) fail('usage: qc fw nat1 <id> add --to <lan-ip> [--wan-ip <ip>|new] [--lan <lan-id>] [--no-inbound] [--label "…"]');
      const body = { wan_ip: flags['wan-ip'] || 'new', dst_ip: flags.to, inbound: !flags['no-inbound'] };
      if (flags.lan) body.lan_id = +flags.lan;
      if (flags.label) body.label = flags.label;
      const r = await api('POST', `/api/v1/firewalls/${id}/nat1`, body); return emit(r, () => say(`1:1 mapping added (${r.firewall?.nat1?.length} now).`));
    }
    const nid = need(pos[2], `qc fw nat1 <id> ${act} <nat-id>`);
    if (act === 'rm' || act === 'delete') { const r = await api('DELETE', `/api/v1/firewalls/${id}/nat1/${nid}`); return emit(r, () => say('mapping removed.')); }
    fail('usage: qc fw nat1 <id> list|add|rm <nid>');
  }
  if (sub === 'tunnels' || sub === 'tunnel') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/firewalls/${id}/tunnels`); return emit(r, () => table(['ID', 'LABEL', 'REMOTE NETS', 'ENDPOINT', 'STATE', 'HANDSHAKE'], (r.tunnels || []).map((t) => [t.id, t.label, (t.remote_networks || []).join(','), t.endpoint || '—', t.state || '—', t.last_handshake || '—']))); }
    if (act === 'add') {
      if (!flags.label || !flags.remote) fail('usage: qc fw tunnels <id> add --label HQ --remote 192.168.1.0/24[,…] [--lans <lan-id,…>] [--endpoint host:port] [--peer-pubkey k] [--peer-fw <fw-id> --peer-lans <ids>]');
      const body = { label: flags.label, remote_networks: String(flags.remote).split(','), lan_ids: flags.lans ? String(flags.lans).split(',').map(Number) : undefined, endpoint: flags.endpoint, peer_pubkey: flags['peer-pubkey'], peer_firewall_id: flags['peer-fw'] ? +flags['peer-fw'] : undefined, peer_lan_ids: flags['peer-lans'] ? String(flags['peer-lans']).split(',').map(Number) : undefined };
      const r = await api('POST', `/api/v1/firewalls/${id}/tunnels`, body);
      return emit(r, () => say(`tunnel #${r.tunnel?.id || '?'} added.${r.tunnel?.config_ready ? `  Far-end config (once):  qc fw tunnels ${id} config ${r.tunnel.id} --out hq.conf` : ''}`));
    }
    const tid = need(pos[2], `qc fw tunnels <id> ${act} <tunnel-id>`);
    if (act === 'rm' || act === 'delete') { if (!flags.yes) fail('re-run with --yes to delete the tunnel'); const r = await api('DELETE', `/api/v1/firewalls/${id}/tunnels/${tid}`); return emit(r, () => say('tunnel deleted.')); }
    if (act === 'enable' || act === 'disable') { const r = await api('PATCH', `/api/v1/firewalls/${id}/tunnels/${tid}`, { enabled: act === 'enable' }); return emit(r, () => say(`tunnel ${act}d.`)); }
    if (act === 'regenerate' || act === 'regen') { const r = await api('POST', `/api/v1/firewalls/${id}/tunnels/${tid}/regenerate`, {}); return emit(r, () => say('new keys issued - download the far-end config again (once).')); }
    if (act === 'config') { const out = flags.out || `tunnel-${tid}.conf`; const text = await apiText(`/api/v1/firewalls/${id}/tunnels/${tid}/config`); fs.writeFileSync(out, text, { mode: 0o600 }); return say(`far-end config saved to ${out} (one-time download - the private key is gone from the server).`); }
    fail('usage: qc fw tunnels <id> list|add|rm <tid> --yes|enable <tid>|disable <tid>|regenerate <tid>|config <tid> [--out file]');
  }
  if (sub === 'reboot') { if (!flags.yes) fail('re-run with --yes to reboot the appliance(s)'); const r = await api('POST', `/api/v1/firewalls/${id}/reboot`, {}); return emit(r, () => say('reboot queued.')); }
  if (sub === 'update') { if (!flags.yes) fail('re-run with --yes to apply the OPNsense update (the appliance reboots)'); const r = await api('POST', `/api/v1/firewalls/${id}/update`, {}); return emit(r, () => say('update started - watch:  qc fw show ' + id)); }
  if (sub === 'traffic') { const r = await api('GET', `/api/v1/firewalls/${id}/traffic?range=${flags.range || '1h'}`); return emit(r, () => say(JSON.stringify(r, null, 2))); }
  if (sub === 'delete' || sub === 'rm') { if (!flags.yes) fail(`deleting firewall ${id} destroys the appliance(s), releases its public IPs and detaches every server - re-run with --yes`); const r = await api('DELETE', `/api/v1/firewalls/${id}`, undefined, idemKey('fw-delete')); return emit(r, () => say(`firewall ${id} deleted.`)); }
  fail(`unknown: fw ${sub} - try list, sizes, create, show, rename, set, rules, forwards, vpn, lans, wan, nat1, tunnels, reboot, update, traffic, delete`);
}
// A GET that returns a FILE (the one-time .ovpn / WireGuard downloads): the
// body is text, not JSON, and a v1 error still arrives as the JSON envelope.
async function apiText(p) {
  const { url, token } = cfg();
  if (!token) fail('no API key set — run:  qc config set token <key>');
  let res; try { res = await fetch(url + p, { headers: { Authorization: `Bearer ${token}` } }); } catch (e) { fail(`could not reach ${url} (${e?.message || e})`); }
  const text = await res.text();
  if (!res.ok) { let j = null; try { j = JSON.parse(text); } catch { /* not json */ } fail((j && j.error && j.error.message) || `HTTP ${res.status}`); }
  return text;
}

// --- load balancers -------------------------------------------------------------
// Shared HAProxy fleet: an LB is a hostname (lb-<slug>.<base>); HTTP listeners
// are Host-routed on :80/:443 with free managed certificates, TCP listeners
// claim a port. Backends must be your own public addresses.
async function cmdLb(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/lbs'); const lbs = r.lbs || [];
    return emit(r, () => {
      if (!lbs.length) return say(`no load balancers (${money(r.month_gbp)}/mo each).  Create one:  qc lb create --label web --yes`);
      table(['ID', 'LABEL', 'HOSTNAME', 'STATUS', 'LISTENERS', 'BACKENDS', 'DOMAINS'], lbs.map((l) => [l.id, l.label, l.hostname, l.suspended ? 'suspended' : l.status, l.listeners, l.backends, `${l.domains_verified}/${l.domains}`]));
      if ((r.fleet_ips || []).length) say(`\nfleet addresses: ${r.fleet_ips.join(', ')}${r.fleet_degraded ? '  (DEGRADED - some nodes down)' : ''}`);
    });
  }
  if (sub === 'info' || sub === 'pricing' || sub === 'sizes') {
    // No sizes: an LB lives on the shared fleet - one product, one price; the
    // shape is what you put on it, within these limits.
    const r = await api('GET', '/api/v1/lbs'); const st = r.settings || {};
    return emit(r, () => {
      say(`load balancer: ${money(r.month_gbp)}/mo max each, billed hourly - shared fleet, no sizes to pick`);
      say(`limits       : ${st.max_lbs ?? '—'} load balancers · ${st.max_listeners ?? '—'} listeners each · ${st.max_backends ?? '—'} backends per listener · ${st.max_domains ?? '—'} custom domains each`);
      say(`listeners    : HTTP on :80/:443 (Host-routed, free managed certificates) · TCP on ports ${st.tcp_port_min ?? '—'}-${st.tcp_port_max ?? '—'}`);
      say(`fleet        : ${(r.fleet_ips || []).length ? r.fleet_ips.join(', ') + (r.fleet_degraded ? '  (DEGRADED)' : '') : '(addresses shown once you have a load balancer)'}${r.ready === false ? '   NOT READY - creation refused for now' : ''}`);
    });
  }
  if (sub === 'create' || sub === 'new') {
    if (!flags.label) fail('usage: qc lb create --label <name> --yes');
    if (!flags.yes) fail('a load balancer bills hourly from creation - re-run with --yes');
    const r = await api('POST', '/api/v1/lbs', { label: flags.label }, idemKey('lb-create'));
    return emit(r, () => say(`load balancer #${r.lb?.id} created: ${r.lb?.hostname}\nnext:  qc lb listeners ${r.lb?.id} add --http   then   qc lb backends ${r.lb?.id} <listener-id> add --ip <your-ip> --port 8080`));
  }
  const id = need(pos[0], `qc lb ${sub} <id>`);
  if (sub === 'show' || sub === 'get') {
    const r = await api('GET', `/api/v1/lbs/${id}`); const l = r.lb || {};
    return emit(r, () => {
      say(`#${l.id}  ${l.label}  ${l.hostname}  [${l.suspended ? 'suspended' : l.status}]${l.cost ? `  ${money(l.cost.monthly_max)}/mo max` : ''}`);
      for (const li of l.listeners || []) {
        say(`listener #${li.id}: ${li.protocol} :${li.port}  ${li.algorithm}${li.sticky ? ' sticky' : ''}${li.proxy_protocol ? ' proxy-protocol' : ''}  hc ${li.hc?.kind}${li.hc?.path ? ' ' + li.hc.path : ''} every ${li.hc?.interval_s}s${li.tls && li.tls.mode !== 'none' ? `  tls ${li.tls.mode}${li.tls.https_redirect ? ' +redirect' : ''}` : ''}`);
        if ((li.backends || []).length) table(['  ID', 'ADDRESS', 'PORT', 'WEIGHT', 'ON', 'HEALTH', 'SESSIONS'], li.backends.map((b) => ['  ' + b.id, b.ip, b.port, b.weight, b.enabled ? 'yes' : 'drained', b.health?.status || '—', b.health?.sessions ?? '—']));
        else say('  (no backends yet)');
      }
      if (!(l.listeners || []).length) say('no listeners yet.');
      for (const d of l.domains || []) say(`domain  : ${d.domain}  ${d.verified ? 'verified' : 'NOT verified' + (d.last_error ? ` - ${d.last_error}` : '')}`);
      for (const c of l.certs || []) say(`cert    : ${c.hostname}  ${c.state || c.status || ''}${c.not_after ? `  until ${c.not_after}` : ''}${c.resumes_at ? `  resumes ${c.resumes_at}` : ''}${c.error ? `  ${c.error}` : ''}`);
    });
  }
  if (sub === 'rename') { const label = need(pos[1], 'qc lb rename <id> <label>'); const r = await api('PATCH', `/api/v1/lbs/${id}`, { label }); return emit(r, () => say(`renamed to ${r.lb?.label}.`)); }
  if (sub === 'listeners' || sub === 'listener') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/lbs/${id}`); return emit({ listeners: r.lb?.listeners || [] }, () => table(['ID', 'PROTO', 'PORT', 'ALGO', 'STICKY', 'HC', 'TLS', 'BACKENDS'], (r.lb?.listeners || []).map((li) => [li.id, li.protocol, li.port, li.algorithm, li.sticky ? 'yes' : '', `${li.hc?.kind}${li.hc?.path ? ' ' + li.hc.path : ''}`, li.tls?.mode || 'none', (li.backends || []).length]))); }
    if (act === 'add') {
      const body = { protocol: flags.tcp ? 'tcp' : 'http' };
      if (flags.port) body.port = +flags.port;
      if (flags.algorithm) body.algorithm = flags.algorithm;
      if (flags.sticky) body.sticky = true;
      if (flags['proxy-protocol']) body.proxy_protocol = true;
      if (flags['hc-path']) body.hc_path = flags['hc-path'];
      if (flags['hc-status']) body.hc_status = +flags['hc-status'];
      if (flags['hc-interval']) body.hc_interval_s = +flags['hc-interval'];
      if (flags.tls) body.tls_mode = flags.tls;
      if (flags.redirect) body.https_redirect = true;
      if (flags['backend-port']) body.tls_backend_port = +flags['backend-port'];
      if (body.protocol === 'tcp' && !body.port) fail('usage: qc lb listeners <id> add --tcp --port <n>   |   add --http [--tls managed|passthrough] [--redirect] [--algorithm roundrobin|leastconn|source] [--sticky] [--hc-path /healthz]');
      const r = await api('POST', `/api/v1/lbs/${id}/listeners`, body);
      const li = (r.lb?.listeners || []).slice(-1)[0];
      return emit(r, () => say(`listener added${li ? ` (#${li.id}, ${li.protocol} :${li.port})` : ''}.`));
    }
    const lid = need(pos[2], `qc lb listeners <id> ${act} <listener-id>`);
    if (act === 'rm' || act === 'delete') { if (!flags.yes) fail('re-run with --yes to remove the listener and its backends'); const r = await api('DELETE', `/api/v1/lbs/${id}/listeners/${lid}`); return emit(r, () => say('listener removed.')); }
    if (act === 'set') {
      const body = {};
      if (flags.algorithm) body.algorithm = flags.algorithm;
      if (flags.sticky != null) body.sticky = flags.sticky !== 'off' && flags.sticky !== 'false';
      if (flags['proxy-protocol'] != null) body.proxy_protocol = flags['proxy-protocol'] !== 'off' && flags['proxy-protocol'] !== 'false';
      if (flags['hc-path']) body.hc_path = flags['hc-path'];
      if (flags['hc-status']) body.hc_status = +flags['hc-status'];
      if (flags['hc-interval']) body.hc_interval_s = +flags['hc-interval'];
      if (flags.tls) body.tls_mode = flags.tls;
      if (flags.redirect != null) body.https_redirect = flags.redirect !== 'off' && flags.redirect !== 'false';
      if (flags['backend-port']) body.tls_backend_port = +flags['backend-port'];
      if (!Object.keys(body).length) fail('usage: qc lb listeners <id> set <lid> [--algorithm a] [--sticky on|off] [--hc-path p] [--hc-interval s] [--tls none|managed|passthrough] [--redirect on|off] [--backend-port n]');
      const r = await api('PATCH', `/api/v1/lbs/${id}/listeners/${lid}`, body); return emit(r, () => say('listener updated.'));
    }
    fail('usage: qc lb listeners <id> list|add|set <lid>|rm <lid> --yes');
  }
  if (sub === 'backends' || sub === 'backend') {
    const lid = need(pos[1], 'qc lb backends <id> <listener-id> list|add|set <bid>|drain <bid>|undrain <bid>|rm <bid>');
    const act = (pos[2] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/lbs/${id}`); const li = (r.lb?.listeners || []).find((x) => String(x.id) === String(lid)); if (!li) fail(`listener ${lid} not found on LB ${id}`); return emit({ backends: li.backends }, () => table(['ID', 'ADDRESS', 'PORT', 'WEIGHT', 'ON', 'HEALTH', 'SESSIONS'], li.backends.map((b) => [b.id, b.ip, b.port, b.weight, b.enabled ? 'yes' : 'drained', b.health?.status || '—', b.health?.sessions ?? '—']))); }
    if (act === 'add') { if (!flags.ip) fail('usage: qc lb backends <id> <lid> add --ip <your-public-ip> [--port n] [--weight 1-256]'); const body = { ip: flags.ip }; if (flags.port) body.port = +flags.port; if (flags.weight) body.weight = +flags.weight; const r = await api('POST', `/api/v1/lbs/${id}/listeners/${lid}/backends`, body); return emit(r, () => say('backend added.')); }
    const bid = need(pos[3], `qc lb backends <id> <lid> ${act} <backend-id>`);
    if (act === 'rm' || act === 'delete') { const r = await api('DELETE', `/api/v1/lbs/${id}/listeners/${lid}/backends/${bid}`); return emit(r, () => say('backend removed.')); }
    if (act === 'drain' || act === 'undrain') { const r = await api('PATCH', `/api/v1/lbs/${id}/listeners/${lid}/backends/${bid}`, { enabled: act === 'undrain' }); return emit(r, () => say(act === 'drain' ? 'backend drained (no new traffic).' : 'backend back in service.')); }
    if (act === 'set') { const body = {}; if (flags.port) body.port = +flags.port; if (flags.weight) body.weight = +flags.weight; if (!Object.keys(body).length) fail('usage: qc lb backends <id> <lid> set <bid> [--port n] [--weight n]'); const r = await api('PATCH', `/api/v1/lbs/${id}/listeners/${lid}/backends/${bid}`, body); return emit(r, () => say('backend updated.')); }
    fail('usage: qc lb backends <id> <lid> list|add --ip a [--port n]|set <bid>|drain <bid>|undrain <bid>|rm <bid>');
  }
  if (sub === 'domains' || sub === 'domain') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/lbs/${id}`); return emit({ domains: r.lb?.domains || [], certs: r.lb?.certs || [] }, () => table(['ID', 'DOMAIN', 'VERIFIED', 'LAST ERROR'], (r.lb?.domains || []).map((d) => [d.id, d.domain, d.verified ? 'yes' : 'no', d.last_error || '']))); }
    if (act === 'add') { const domain = need(pos[2], 'qc lb domains <id> add <domain>'); const r = await api('POST', `/api/v1/lbs/${id}/domains`, { domain }); return emit(r, () => { const d = r.domain || {}; say(`domain ${d.domain} added - point it at the load balancer, then:  qc lb domains ${id} verify ${d.id}`); if (d.cname_target) say(`  CNAME  ${d.domain} → ${d.cname_target}`); if (d.txt_name) say(`  or TXT ${d.txt_name} = ${d.txt_value}  (apex domains: plus A/AAAA records to the fleet addresses)`); }); }
    const did = need(pos[2], `qc lb domains <id> ${act} <domain-id>`);
    if (act === 'verify' || act === 'check') { const r = await api('POST', `/api/v1/lbs/${id}/domains/${did}/verify`, {}); return emit(r, () => say(r.verified ? `verified${r.via ? ` (via ${r.via})` : ''} - a certificate follows within minutes.` : `not verified yet${r.error || r.last_error ? ` - ${r.error || r.last_error}` : ''}`)); }
    if (act === 'rm' || act === 'delete') { const r = await api('DELETE', `/api/v1/lbs/${id}/domains/${did}`); return emit(r, () => say('domain removed.')); }
    fail('usage: qc lb domains <id> list|add <domain>|verify <did>|rm <did>');
  }
  if (sub === 'delete' || sub === 'rm') { if (!flags.yes) fail(`deleting load balancer ${id} withdraws its hostname - every CNAME pointing at it stops working. Re-run with --yes`); const r = await api('DELETE', `/api/v1/lbs/${id}`, undefined, idemKey('lb-delete')); return emit(r, () => say(`load balancer ${id} deleted.`)); }
  fail(`unknown: lb ${sub} - try list, info, create, show, rename, listeners, backends, domains, delete`);
}

// --- storage boxes --------------------------------------------------------------
// Quota'd SFTP storage on the network-storage fleet: metered per GB or a fixed
// monthly plan; snapshots, IP allowlist, SSH keys. Creating / resizing / mode
// changes are MONEY (billing.write on the key); the rest is storage.write.
async function cmdBox(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  const gbCol = (b) => `${b.used_gb ?? 0}/${b.quota_gb}G`;
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/storage-boxes'); const boxes = r.boxes || [];
    return emit(r, () => {
      if (!boxes.length) return say(`no storage boxes.  Create one:  qc box create --metered --cap 100 --yes   (see  qc box plans)`);
      table(['ID', 'LABEL', 'USERNAME', 'MODE', 'USED/QUOTA', 'STATE', 'SNAPS', 'ALLOWLIST'], boxes.map((b) => [b.id, b.label || '—', b.username, b.billing_mode === 'fixed' ? `fixed ${b.plan_name || b.plan_slug}` : 'metered', gbCol(b), b.status === 'deleting' ? 'deleting' : b.state + (b.reason ? ` (${b.reason})` : ''), (b.snapshots || []).length, (b.allowlist || []).length ? `${b.allowlist.length} cidr` : 'anywhere']));
      say(`\nsftp: ${r.host || '—'} port ${r.sftp_port || '—'}  ·  connect:  sftp -P ${r.sftp_port || 2022} <username>@${r.host || 'host'}`);
    });
  }
  if (sub === 'plans' || sub === 'pricing' || sub === 'sizes') {
    const r = await api('GET', '/api/v1/storage-boxes');
    return emit(r, () => {
      say(`metered: ${money(r.metered?.gb_mo_gbp)}/GB/mo for the space you USE (quota ${r.metered?.floor_gb}-${r.metered?.max_cap_gb} GB)`);
      if ((r.plans || []).length) { say('fixed plans (billed monthly from credit):'); table(['  SLUG', 'NAME', 'SIZE', '£/MO'], r.plans.map((p) => ['  ' + p.slug, p.name, `${p.size_gb}G`, money(p.price_gbp ?? (p.price_micro != null ? p.price_micro / 1e6 : null))])); }
      say(`\nlimits: ${r.max_boxes} boxes · ${r.max_snapshots} snapshots each  ·  sftp ${r.host || '—'}:${r.sftp_port || '—'}`);
    });
  }
  if (sub === 'create' || sub === 'new') {
    if (!flags.metered && !flags.plan) fail('usage: qc box create --metered --cap <GB> [--label l] --yes   |   --plan <slug> [--label l] --yes');
    if (!flags.yes) fail('a storage box bills from creation - re-run with --yes');
    const body = flags.plan ? { mode: 'fixed', plan: flags.plan } : { mode: 'metered', cap_gb: +flags.cap };
    if (flags.metered && !flags.cap) fail('metered boxes need --cap <GB>');
    if (flags.label) body.label = flags.label;
    const r = await api('POST', '/api/v1/storage-boxes', body, idemKey('box-create'));
    return emit(r, () => { const b = r.box || {}; say(`storage box #${b.id} created (${b.quota_gb} GB, ${b.billing_mode}).`); say(`sftp username : ${b.username}`); say(`sftp password : ${r.password}   (shown ONCE - store it, or attach an SSH key:  qc box keys ${b.id} set <key-id>)`); say(`connect       : sftp -P ${r.sftp_port || 2022} ${b.username}@${r.host || 'host'}`); });
  }
  const id = need(pos[0], `qc box ${sub} <id>`);
  if (sub === 'show' || sub === 'get') {
    const r = await api('GET', `/api/v1/storage-boxes/${id}`); const b = r.box || {};
    return emit(r, () => {
      say(`#${b.id}  ${b.label || ''}  ${b.username}  [${b.status === 'deleting' ? 'deleting' : b.state}${b.reason ? ` - ${b.reason}` : ''}]`);
      say(`storage : ${gbCol(b)}  ${b.billing_mode === 'fixed' ? `fixed plan ${b.plan_name || b.plan_slug}${b.period_end ? `, renews ${String(b.period_end).slice(0, 10)}` : ''}${b.pending_plan_slug ? ` → ${b.pending_plan_slug} at renewal` : ''}` : 'metered (pay for what you use)'}`);
      say(`snapshots: ${b.auto_snap ? `daily, keep ${b.auto_keep}` : 'manual only'}${(b.snapshots || []).length ? '' : '  (none yet)'}`);
      for (const sn of b.snapshots || []) say(`  #${sn.id}  ${sn.name}  ${sn.kind}  ${sn.status}${sn.gb != null ? `  ${sn.gb}G` : ''}  ${sn.created_at || ''}`);
      say(`access  : ${(b.allowlist || []).length ? b.allowlist.map((a) => `${a.cidr} [#${a.id}]`).join(', ') : 'from anywhere'}`);
      say(`ssh keys: ${(b.keys || []).length ? b.keys.map((k) => `${k.label} [#${k.id}]`).join(', ') : 'none (password only)'}`);
      say(`restore : snapshots are read-only under /.zfs/snapshot/<name>/ over SFTP - copy files back from there`);
    });
  }
  if (sub === 'password' || sub === 'passwd') { if (!flags.yes) fail('this replaces the current SFTP password - re-run with --yes'); const r = await api('POST', `/api/v1/storage-boxes/${id}/password`, {}); return emit(r, () => say(`new sftp password for ${r.username || 'box ' + id}: ${r.password}   (shown ONCE)`)); }
  if (sub === 'resize') { if (!flags.cap && !flags.plan) fail('usage: qc box resize <id> --cap <GB>   |   --plan <slug>'); const r = await api('POST', `/api/v1/storage-boxes/${id}/resize`, flags.plan ? { plan: flags.plan } : { cap_gb: +flags.cap }); return emit(r, () => say(`quota now ${r.box?.quota_gb} GB${r.box?.pending_plan_slug ? ` (plan change to ${r.box.pending_plan_slug} applies at renewal)` : ''}.`)); }
  if (sub === 'mode') { const mode = need(pos[1], 'qc box mode <id> metered|fixed [--plan <slug>]'); const r = await api('POST', `/api/v1/storage-boxes/${id}/mode`, { mode, plan: flags.plan }); return emit(r, () => say(`now ${r.box?.billing_mode}${r.box?.plan_slug ? ` (${r.box.plan_slug})` : ''}.`)); }
  if (sub === 'snap' || sub === 'snapshots' || sub === 'snapshot') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/storage-boxes/${id}`); return emit({ snapshots: r.box?.snapshots || [] }, () => table(['ID', 'NAME', 'KIND', 'STATUS', 'SIZE', 'CREATED'], (r.box?.snapshots || []).map((sn) => [sn.id, sn.name, sn.kind, sn.status, sn.gb != null ? `${sn.gb}G` : '—', sn.created_at || '—']))); }
    if (act === 'create' || act === 'take') { const r = await api('POST', `/api/v1/storage-boxes/${id}/snapshots`, {}); return emit(r, () => say(`snapshot ${r.snapshot?.name || r.snapshot?.id} queued.`)); }
    if (act === 'auto') { const on = (pos[2] || '').toLowerCase(); if (!['on', 'off'].includes(on)) fail('usage: qc box snap <id> auto on|off [--keep n]'); const r = await api('POST', `/api/v1/storage-boxes/${id}/autosnap`, { enabled: on === 'on', keep: flags.keep ? +flags.keep : undefined }); return emit(r, () => say(`daily snapshots ${on}${on === 'on' ? `, keeping ${r.box?.auto_keep}` : ''}.`)); }
    const sid = need(pos[2], `qc box snap <id> ${act} <snapshot-id>`);
    if (act === 'rm' || act === 'delete') { const r = await api('DELETE', `/api/v1/storage-boxes/${id}/snapshots/${sid}`); return emit(r, () => say('snapshot deletion queued.')); }
    fail('usage: qc box snap <id> list|create|auto on|off [--keep n]|rm <snapshot-id>');
  }
  if (sub === 'allow' || sub === 'allowlist') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/storage-boxes/${id}`); return emit({ allowlist: r.box?.allowlist || [] }, () => ((r.box?.allowlist || []).length ? table(['ID', 'CIDR'], r.box.allowlist.map((a) => [a.id, a.cidr])) : say('no allowlist - reachable from anywhere.'))); }
    if (act === 'add') { const cidr = need(pos[2], 'qc box allow <id> add <cidr>'); const r = await api('POST', `/api/v1/storage-boxes/${id}/allowlist`, { cidr }); return emit(r, () => say(`allowed ${cidr} (${r.allowlist?.length} entr${r.allowlist?.length === 1 ? 'y' : 'ies'}).`)); }
    if (act === 'rm' || act === 'delete') { const eid = need(pos[2], 'qc box allow <id> rm <entry-id>'); const r = await api('DELETE', `/api/v1/storage-boxes/${id}/allowlist/${eid}`); return emit(r, () => say(r.allowlist?.length ? 'entry removed.' : 'entry removed - the box is reachable from anywhere again.')); }
    fail('usage: qc box allow <id> list|add <cidr>|rm <entry-id>');
  }
  if (sub === 'keys' || sub === 'key') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/storage-boxes/${id}/keys`); return emit(r, () => ((r.keys || []).length ? table(['ID', 'LABEL', 'KEY'], r.keys.map((k) => [k.id, k.label, (k.public_key || '').slice(0, 40) + '…'])) : say('no SSH keys attached (password login only). Keys come from the panel key manager.'))); }
    if (act === 'set') { const ids = pos.slice(2).map(Number).filter(Number.isInteger); if (!ids.length && !flags.none) fail('usage: qc box keys <id> set <key-id> [<key-id>…]   |   set --none'); const r = await api('PUT', `/api/v1/storage-boxes/${id}/keys`, { key_ids: flags.none ? [] : ids }); return emit(r, () => say(`${r.keys?.length || 0} key(s) attached.`)); }
    fail('usage: qc box keys <id> list|set <key-id…>|set --none');
  }
  if (sub === 'delete' || sub === 'rm') { if (!flags.yes) fail(`deleting storage box ${id} DESTROYS its data and snapshots - re-run with --yes`); const r = await api('DELETE', `/api/v1/storage-boxes/${id}`, undefined, idemKey('box-delete')); return emit(r, () => say(`storage box ${id} is being deleted.`)); }
  fail(`unknown: box ${sub} - try list, plans, create, show, password, resize, mode, snap, allow, keys, delete`);
}

// --- managed databases ----------------------------------------------------------
// PostgreSQL / MariaDB / Valkey instances on dedicated resources (optionally a
// 3-node HA cluster). Creating builds VMs that bill hourly from the moment they
// exist, so create / restore are --yes gated and idempotent. Passwords are shown
// once; there is no shell or console - that is the product.
async function cmdDb(pos, flags) {
  const sub = (pos.shift() || 'list').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/databases'); const dbs = r.databases || [];
    return emit(r, () => (dbs.length ? table(['ID', 'LABEL', 'ENGINE', 'SIZE', 'HA', 'STATUS', 'HOST', 'PORT', '£/MO MAX'], dbs.map((d) => [d.id, d.label, `${d.engine} ${d.version || ''}`, d.size?.slug || d.size || '—', d.ha ? `${d.cluster?.state || 'yes'}` : '', d.status, d.connect?.host || d.address || '—', d.port, money(d.cost?.all_in?.monthly_max)])) : say('no database instances.  Create one:  qc db create --label app --engine postgres --size s --allow <your-ip>/32 --yes   (see  qc db sizes)')));
  }
  if (sub === 'sizes' || sub === 'engines' || sub === 'info') {
    const r = await api('GET', '/api/v1/databases');
    return emit(r, () => {
      say(`engines : ${Object.entries(r.engines || {}).map(([k, e]) => `${k} (${e.label}${e.versions ? ' ' + e.versions.join('/') : ''})`).join(', ') || '—'}`);
      table(['SIZE', 'CPU', 'MEMORY', 'DATA', '£/MO MAX (ALL-IN)', 'HA CLUSTER £/MO'], (r.sizes || []).map((z) => [z.slug, z.vcpu, gb(z.ram_mb), `${z.disk_gb}G`, money(z.total?.monthly_max), z.total_ha ? money(z.total_ha.monthly_max) : (r.ha?.offered ? '—' : 'not offered')]));
      say(`\nall-in = management + dedicated CPU/memory + system and data disks, billed hourly; backups metered on top. PITR ${r.pitr_days ?? '—'} days.`);
      say(`access  : public (own IPv4, TLS required, access list REQUIRED) or private (one of your networks with a router: ${(r.networks || []).filter((n) => n.usable).map((n) => `#${n.id} ${n.label} ${n.cidr}`).join(', ') || 'none usable yet'})`);
      if (r.your_ip) say(`your ip : ${r.your_ip}  (a sensible first --allow entry)`);
      if (r.ready === false) say('NOT READY - the platform is not fully configured; creation is refused for now.');
    });
  }
  if (sub === 'create' || sub === 'new') {
    if (!flags.label || !flags.engine) fail('usage: qc db create --label <n> --engine postgres|mariadb|valkey [--size s|m|l] [--version v] (--allow <cidr>[,…] | --network <id> [--address <ip>]) [--database <name>] [--ha] --yes');
    if (!flags.yes) fail('a database instance builds dedicated servers that bill hourly from now - re-run with --yes' + (flags.ha ? ' (an HA cluster builds THREE)' : ''));
    const body = { label: flags.label, engine: flags.engine, size: flags.size || 's' };
    if (flags.version) body.version = String(flags.version);
    if (flags.network) { body.listen_mode = 'private'; body.network_id = +flags.network; if (flags.address) body.address = flags.address; }
    else { body.listen_mode = 'public'; if (!flags.allow) fail('a public instance needs an access list: --allow <cidr>[,<cidr>…] (or use --network <id> for a private one)'); body.allowlist = String(flags.allow).split(',').map((x) => x.trim()).filter(Boolean); }
    if (flags.database) body.database = flags.database;
    if (flags.ha) body.ha = true;
    const r = await api('POST', '/api/v1/databases', body, idemKey('db-create'));
    return emit(r, () => {
      const d = r.database || {};
      say(`database #${d.id} (${d.label}) is building${d.ha ? ' as a 3-node HA cluster' : ''} - job ${r.jobId}.  Est. ${money(d.cost?.all_in?.monthly_max)}/mo max.`);
      say(`host     : ${d.connect?.host || d.address || '(pending)'}:${d.port || ''}`);
      say(`admin    : ${d.connect?.user || 'qcadmin'}`);
      if (r.admin_password) { say(`password : ${r.admin_password}`); say('  (shown ONCE - store it now; later:  qc db admin-password <id> rotate)'); }
      say(`ca cert  : qc db ca ${d.id} --out ca.pem   (once the instance is active)`);
      say(`watch    : qc db show ${d.id}`);
    });
  }
  const id = need(pos[0], `qc db ${sub} <id>`);
  if (sub === 'show' || sub === 'get') {
    const r = await api('GET', `/api/v1/databases/${id}`); const d = r.database || {};
    return emit(r, () => {
      say(`#${d.id}  ${d.label}  ${d.engine} ${d.version || ''}  [${d.status}]${d.ha ? `  HA cluster: ${d.cluster?.state || '?'}${d.cluster?.leader_idx != null ? `, leader node ${d.cluster.leader_idx}` : ''}` : ''}`);
      if (d.build && d.build.length) for (const b of d.build) say(`building : node ${b.idx ?? 0} - ${b.text || b.phase || ''}`);
      say(`connect  : ${d.connect?.host || '—'}:${d.port}  user ${d.connect?.user || '—'}  tls ${d.connect?.tls || 'required'}  (${d.listen_mode}${d.address ? ' ' + d.address : ''})`);
      say(`size     : ${d.size?.slug || ''} ${d.size?.vcpu ? `${d.size.vcpu} CPU · ${gb(d.size.ram_mb)} · ${d.size.disk_gb}G data` : ''}   cost ${money(d.cost?.all_in?.monthly_max)}/mo max`);
      if (d.usage) say(`usage    : disk ${d.usage.disk_pct ?? '—'}%  memory ${d.usage.mem_pct ?? d.usage.memory_pct ?? '—'}%  connections ${d.usage.connections ?? '—'}${d.usage.max_connections ? '/' + d.usage.max_connections : ''}`);
      if ((d.users || []).length) { say('users    :'); table(['  ID', 'NAME', 'ACCESS/GRANTS'], d.users.map((u) => ['  ' + u.id, u.name, u.access || (u.grants || []).map((g) => `${g.database || g.database_id}:${g.role}`).join(', ') || '—'])); }
      if ((d.databases || []).length) { say('databases:'); table(['  ID', 'NAME', 'STATUS', 'OWNER', 'EXTENSIONS', 'SIZE'], d.databases.map((x) => ['  ' + x.id, x.name, x.status, x.owner || x.owner_user_id || '—', (x.extensions || []).join(',') || '—', x.stats?.size_gb != null ? `${x.stats.size_gb}G` : '—'])); }
      if ((d.unmanaged || []).length) say(`unmanaged: ${d.unmanaged.map((u) => u.name).join(', ')}  (created over SQL - adopt with  qc db adopt ${d.id} <name>)`);
      say(`access   : ${(d.allowlist || []).length ? d.allowlist.map((a) => `${a.cidr}${a.label ? ' ' + a.label : ''} [#${a.id}]`).join(', ') : (d.listen_mode === 'private' ? 'the private network' : 'none')}`);
      if (d.backup) say(`backups  : ${d.backup.enabled ? (d.backup.pitr ? `nightly + point-in-time${d.backup.window?.from ? ` (window ${d.backup.window.from} → ${d.backup.window.to})` : ''}` : 'nightly snapshots') : 'not configured'}${d.backup.last ? `  last ${d.backup.last.ts} ${d.backup.last.ok ? 'ok' : 'FAILED'}` : ''}`);
      if (d.restore) say(`restore  : ${d.restore.state}${d.restore.from ? ` from #${d.restore.from}` : ''}${d.restore.at ? ` @ ${d.restore.at}` : ''}${d.restore.error ? ` - ${d.restore.error}` : ''}`);
      if (d.recover) say(`recover  : ${d.recover.state} ${d.recover.database || ''} → ${d.recover.target || ''}${d.recover.error ? ` - ${d.recover.error}` : ''}`);
    });
  }
  if (sub === 'rename') { const label = need(pos[1], 'qc db rename <id> <label>'); const r = await api('PATCH', `/api/v1/databases/${id}`, { label }); return emit(r, () => say(`renamed to ${r.database?.label}.`)); }
  if (sub === 'admin-password' || sub === 'admin') {
    const act = (pos[1] || 'reveal').toLowerCase();
    if (act === 'rotate') { if (!flags.yes) fail('rotating replaces the admin password everywhere - re-run with --yes'); const r = await api('POST', `/api/v1/databases/${id}/admin-password/rotate`, {}); return emit(r, () => say(`admin user ${r.user}  new password: ${r.password}   (shown ONCE)`)); }
    const r = await api('POST', `/api/v1/databases/${id}/admin-password`, {}); return emit(r, () => say(`admin ${r.user}@${r.host}:${r.port}  password: ${r.password}   (shown ONCE - it is scrubbed now)`));
  }
  if (['start', 'stop', 'shutdown', 'reboot'].includes(sub)) { if (!flags.yes && sub !== 'start') fail(`re-run with --yes to ${sub} the instance`); const r = await api('POST', `/api/v1/databases/${id}/power`, { action: sub }); return emit(r, () => say(`${sub} queued (job ${r.jobId || '?'}).`)); }
  if (sub === 'switchover') { const idx = need(pos[1], 'qc db switchover <id> <node-idx> --yes'); if (!flags.yes) fail('a switchover moves the endpoint to another node (brief reconnects) - re-run with --yes'); const r = await api('POST', `/api/v1/databases/${id}/switchover`, { idx: +idx }); return emit(r, () => say(`switchover to node ${idx} requested - the cluster moves on its next heartbeat.`)); }
  if (sub === 'logs' || sub === 'log') {
    if (flags.request || flags.refresh) { const r = await api('POST', `/api/v1/databases/${id}/logs`, flags.node != null ? { idx: +flags.node } : {}); return emit(r, () => say('log requested - the instance answers on its next heartbeat; run  qc db logs ' + id + '  in ~30s.')); }
    const r = await api('GET', `/api/v1/databases/${id}/logs${flags.node != null ? `?idx=${+flags.node}` : ''}`); return emit(r, () => { if (r.pending) say('(a request is outstanding)'); say(r.tail || r.log || '(no log yet - request one with  --request)'); });
  }
  if (sub === 'recovery') { const on = (pos[1] || '').toLowerCase(); if (!['on', 'off'].includes(on)) fail('usage: qc db recovery <id> on|off   (MariaDB single instance: read-only recovery mode)'); const r = await api('POST', `/api/v1/databases/${id}/recovery`, { on: on === 'on' }); return emit(r, () => say(`recovery mode ${on}.`)); }
  if (sub === 'alerts') { const on = (pos[1] || '').toLowerCase(); if (!['on', 'off'].includes(on)) fail('usage: qc db alerts <id> on|off'); const r = await api('PATCH', `/api/v1/databases/${id}/alerts`, { alerts: on === 'on' }); return emit(r, () => say(`HA event emails ${on}.`)); }
  if (sub === 'ca' || sub === 'ca-cert') { const out = flags.out || `db-${id}-ca.pem`; const text = await apiText(`/api/v1/databases/${id}/ca.pem`); fs.writeFileSync(out, text); return say(`CA certificate saved to ${out}  (e.g. psql "sslmode=verify-full sslrootcert=${out} …")`); }
  if (sub === 'users' || sub === 'user') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/databases/${id}`); return emit({ users: r.database?.users || [] }, () => table(['ID', 'NAME', 'ACCESS/GRANTS'], (r.database?.users || []).map((u) => [u.id, u.name, u.access || (u.grants || []).map((g) => `${g.database || g.database_id}:${g.role}`).join(', ') || '—']))); }
    if (act === 'add') { const name = need(pos[2], 'qc db users <id> add <name> [--password p] [--access full|readwrite|readonly (valkey)]'); const body = { name }; if (flags.password) body.password = flags.password; if (flags.access) body.access = flags.access; const r = await api('POST', `/api/v1/databases/${id}/users`, body); return emit(r, () => say(`user ${r.user?.name} (#${r.user?.id}) added  password: ${r.password}   (shown ONCE)`)); }
    const uid = need(pos[2], `qc db users <id> ${act} <user-id>`);
    if (act === 'rm' || act === 'delete') { if (!flags.yes) fail('re-run with --yes to remove the user'); const r = await api('DELETE', `/api/v1/databases/${id}/users/${uid}`); return emit(r, () => say('user removed.')); }
    if (act === 'password' || act === 'rotate') { const r = await api('POST', `/api/v1/databases/${id}/users/${uid}/password`, flags.password ? { password: flags.password } : {}); return emit(r, () => say(`user ${r.user?.name}: new password ${r.password}   (shown ONCE)`)); }
    if (act === 'grant') { const dbRef = need(pos[3], 'qc db users <id> grant <user-id> <database-id> owner|readwrite|readonly|none'); const role = need(pos[4], 'qc db users <id> grant <user-id> <database-id> owner|readwrite|readonly|none'); const r = await api('PUT', `/api/v1/databases/${id}/users/${uid}/grants`, { database_id: +dbRef, role: role === 'none' ? null : role }); return emit(r, () => say(role === 'none' ? 'grant removed.' : `granted ${role}.`)); }
    if (act === 'access') { const access = need(pos[3], 'qc db users <id> access <user-id> full|readwrite|readonly'); const r = await api('PUT', `/api/v1/databases/${id}/users/${uid}/access`, { access }); return emit(r, () => say(`access set to ${access}.`)); }
    fail('usage: qc db users <id> list|add <name>|rm <uid> --yes|password <uid> [--password p]|grant <uid> <db-id> <role>|access <uid> <level>');
  }
  if (sub === 'databases' || sub === 'dbs') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/databases/${id}`); return emit({ databases: r.database?.databases || [] }, () => table(['ID', 'NAME', 'STATUS', 'OWNER', 'EXTENSIONS'], (r.database?.databases || []).map((x) => [x.id, x.name, x.status, x.owner || x.owner_user_id || '—', (x.extensions || []).join(',') || '—']))); }
    if (act === 'add' || act === 'create') { const name = need(pos[2], 'qc db databases <id> add <name> [--owner <user-id>] [--extensions a,b]'); const body = { name }; if (flags.owner) body.owner_user_id = +flags.owner; if (flags.extensions) body.extensions = String(flags.extensions).split(','); const r = await api('POST', `/api/v1/databases/${id}/databases`, body); return emit(r, () => say(`database ${r.database?.name} (#${r.database?.id}) queued.`)); }
    const did = need(pos[2], `qc db databases <id> ${act} <database-id>`);
    if (act === 'drop' || act === 'rm') { if (!flags.yes) fail(`DROP destroys database ${did}'s data - re-run with --yes`); const r = await api('DELETE', `/api/v1/databases/${id}/databases/${did}`); return emit(r, () => say('drop queued (destroy-list: the name stays reserved until the instance confirms).')); }
    if (act === 'extensions') { const ext = pos.slice(3).join(',').split(',').map((x) => x.trim()).filter(Boolean); const r = await api('PUT', `/api/v1/databases/${id}/databases/${did}/extensions`, { extensions: ext }); return emit(r, () => say(`extensions: ${(r.database?.extensions || []).join(', ') || 'none'}.`)); }
    fail('usage: qc db databases <id> list|add <name>|drop <did> --yes|extensions <did> <ext…>');
  }
  if (sub === 'adopt') { const name = need(pos[1], 'qc db adopt <id> <name>'); const r = await api('POST', `/api/v1/databases/${id}/databases/adopt`, { name }); return emit(r, () => say(`adopted ${r.database?.name} (#${r.database?.id}).`)); }
  if (sub === 'settings' || sub === 'set') {
    if (pos.length < 2 && !Object.keys(flags).some((k) => k !== 'json')) { const r = await api('GET', `/api/v1/databases/${id}`); return emit({ settings: r.database?.settings, setting_specs: r.database?.setting_specs }, () => { say(JSON.stringify(r.database?.settings || {}, null, 2)); say('\nsettable keys: ' + Object.keys(r.database?.setting_specs || {}).join(', ')); }); }
    // qc db set <id> key=value [key=value…]
    const body = {}; for (const kv of pos.slice(1)) { const [k, ...v] = kv.split('='); if (k && v.length) body[k] = v.join('='); }
    if (!Object.keys(body).length) fail('usage: qc db set <id> key=value [key=value…]   (qc db set <id>  alone lists current settings + keys)');
    const r = await api('PUT', `/api/v1/databases/${id}/settings`, body); return emit(r, () => say('settings applied: ' + JSON.stringify(r.settings || r)));
  }
  if (sub === 'allow' || sub === 'allowlist') {
    const act = (pos[1] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', `/api/v1/databases/${id}`); return emit({ allowlist: r.database?.allowlist || [] }, () => table(['ID', 'CIDR', 'LABEL'], (r.database?.allowlist || []).map((a) => [a.id, a.cidr, a.label || '']))); }
    if (act === 'add') { const cidr = need(pos[2], 'qc db allow <id> add <cidr> [--label l]'); const r = await api('POST', `/api/v1/databases/${id}/allowlist`, { cidr, label: flags.label }); return emit(r, () => say(`allowed ${r.entry?.cidr} [#${r.entry?.id}].`)); }
    if (act === 'rm' || act === 'delete') { const aid = need(pos[2], 'qc db allow <id> rm <entry-id>'); const r = await api('DELETE', `/api/v1/databases/${id}/allowlist/${aid}`); return emit(r, () => say('entry removed.')); }
    fail('usage: qc db allow <id> list|add <cidr> [--label l]|rm <entry-id>');
  }
  if (sub === 'backup') { const r = await api('POST', `/api/v1/databases/${id}/backup`, {}); return emit(r, () => say('full backup requested (the instance takes it on its next heartbeat).')); }
  if (sub === 'restore') {
    if (!flags.at && !flags.set) fail('usage: qc db restore <id> --at 2026-10-06T08:30:00Z [--label l] [--size s] [--allow <cidr,…> | --network <id> [--address ip]] --yes   (Valkey: --set <timestamp>)');
    if (!flags.yes) fail('restore builds a NEW instance that bills from now - re-run with --yes');
    const body = {}; if (flags.at) body.at = flags.at; if (flags.set) body.set = flags.set; if (flags.label) body.label = flags.label; if (flags.size) body.size = flags.size;
    if (flags.network) { body.listen_mode = 'private'; body.network_id = +flags.network; if (flags.address) body.address = flags.address; }
    else if (flags.allow) { body.listen_mode = 'public'; body.allowlist = String(flags.allow).split(',').map((x) => x.trim()).filter(Boolean); }
    const r = await api('POST', `/api/v1/databases/${id}/restore`, body, idemKey('db-restore'));
    return emit(r, () => say(`restoring into NEW instance #${r.database?.id} (${r.database?.label}) - job ${r.jobId || '?'}.  Watch:  qc db show ${r.database?.id}`));
  }
  if (sub === 'recover') { const database = need(pos[1], 'qc db recover <id> <database-name> --at <utc> [--target <new-name>]'); if (!flags.at) fail('--at <UTC moment> is required'); const r = await api('POST', `/api/v1/databases/${id}/recover`, { database, at: flags.at, target: flags.target }); return emit(r, () => say(`recovering ${database} as ${r.database?.recover?.target || flags.target || '(auto name)'} - watch  qc db show ${id}`)); }
  if (sub === 'delete' || sub === 'rm') { if (!flags.yes) fail(`deleting instance ${id} destroys its server(s); backups are kept for the grace period. Re-run with --yes`); const r = await api('DELETE', `/api/v1/databases/${id}`, undefined, idemKey('db-delete')); return emit(r, () => say(`database instance ${id} is being deleted.${r.backup_purge_at ? `  Backups kept until ${r.backup_purge_at} (restorable to a new instance).` : ''}`)); }
  fail(`unknown: db ${sub} - try list, sizes, create, show, rename, admin-password, start|stop|shutdown|reboot, switchover, logs, recovery, alerts, ca, users, databases, adopt, set, allow, backup, restore, recover, delete`);
}

// --- SMTP relay (QuickSMTP) ---------------------------------------------------
// Day-2 only: senders, DKIM domains, the delivery log. Subscribing / plan
// changes are done in the panel (money + reseller ledger).
async function cmdRelay(pos, flags) {
  const sub = (pos.shift() || 'status').toLowerCase();
  if (sub === 'status' || sub === 'show' || sub === 'overview') {
    const r = await api('GET', '/api/v1/relay');
    return emit(r, () => {
      const su = r.subscription;
      if (!su) { say(`no SMTP relay subscription - subscribe in the panel (plans: ${(r.plans || []).map((p) => `${p.slug} ${p.emails_mo}/mo ${money(p.price_gbp)}`).join(', ') || '—'}).`); return; }
      say(`plan     : ${su.plan_name} (${su.plan_slug})  ${money(su.price_gbp)}/mo  [${su.status}${su.blocked ? ` - BLOCKED: ${su.block_reason}` : ''}]${su.cancel_at_period_end ? '  cancels at period end' : ''}${su.pending_plan_slug ? `  → ${su.pending_plan_slug} at renewal` : ''}`);
      say(`quota    : ${su.period_accepted}/${su.emails_mo} this billing period · resets ${String(su.period_end || '').slice(0, 10)}`);
      if (r.usage) say(`delivered: ${r.usage.delivered}  bounced ${r.usage.bounced}  accepted ${r.usage.accepted}`);
      say(`smtp     : ${r.smtp_host}  (STARTTLS, port 587 - log in with a sender username + its secret)`);
      say(`senders  : ${(r.senders || []).length ? r.senders.map((x) => `${x.username} [#${x.id} ${x.status}${x.paused_reason ? ': ' + x.paused_reason : ''}]`).join(', ') : 'none -  qc relay senders add --label app'}`);
      say(`domains  : ${(r.domains || []).length ? r.domains.map((d) => `${d.domain} [#${d.id} ${d.status}]`).join(', ') : 'none -  qc relay domains add example.com'}`);
    });
  }
  if (sub === 'senders' || sub === 'sender') {
    const act = (pos[0] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', '/api/v1/relay'); return emit({ senders: r.senders || [] }, () => ((r.senders || []).length ? table(['ID', 'USERNAME', 'STATUS', 'REASON', 'LAST USED'], r.senders.map((x) => [x.id, x.username, x.status, x.paused_reason || '', x.last_used_at || 'never'])) : say('no senders.'))); }
    if (act === 'add' || act === 'create') { if (!flags.label) fail('usage: qc relay senders add --label <what it is for>   (becomes part of the SMTP username)'); const r = await api('POST', '/api/v1/relay/senders', { label: flags.label }, idemKey('relay-sender')); return emit(r, () => { say(`sender #${r.sender?.id} created`); say(`smtp host : ${r.smtp_host}  (port 587, STARTTLS)`); say(`username  : ${r.sender?.username}`); say(`password  : ${r.secret}   (shown ONCE - only a hash is kept)`); }); }
    const id = need(pos[1], `qc relay senders ${act} <sender-id>`);
    if (['pause', 'resume', 'revoke'].includes(act)) { if (act === 'revoke' && !flags.yes) fail('revoking is permanent (create a new sender afterwards) - re-run with --yes'); const r = await api('POST', `/api/v1/relay/senders/${id}/status`, { status: act === 'pause' ? 'paused' : act === 'resume' ? 'active' : 'revoked', reason: flags.reason }); return emit(r, () => say(`sender ${r.sender?.username} is now ${r.sender?.status}.`)); }
    fail('usage: qc relay senders list|add --label l|pause <id>|resume <id>|revoke <id> --yes');
  }
  if (sub === 'domains' || sub === 'domain') {
    const act = (pos[0] || 'list').toLowerCase();
    if (act === 'list') { const r = await api('GET', '/api/v1/relay'); return emit({ domains: r.domains || [] }, () => ((r.domains || []).length ? r.domains.forEach((d) => { say(`#${d.id}  ${d.domain}  [${d.status}]`); say(`  TXT  ${d.dns_name}`); say(`       ${d.dns_value}`); }) : say('no sending domains.'))); }
    if (act === 'add') { const domain = need(pos[1], 'qc relay domains add <domain>'); const r = await api('POST', '/api/v1/relay/domains', { domain }, idemKey('relay-domain')); return emit(r, () => { const d = r.domain || {}; say(`domain ${d.domain} added - publish this DNS record so mail gets DKIM-signed:`); say(`  TXT  ${d.dns_name}`); say(`       ${d.dns_value}`); if (d.domain) say(`  (hosted here?  qc dns set ${d.domain} ${String(d.dns_name).replace('.' + d.domain, '')} TXT '${d.dns_value}')`); }); }
    if (act === 'rm' || act === 'delete') { const id = need(pos[1], 'qc relay domains rm <domain-id> --yes'); if (!flags.yes) fail('re-run with --yes to remove the domain (mail from it stops being signed)'); const r = await api('DELETE', `/api/v1/relay/domains/${id}`); return emit(r, () => say('domain removed.')); }
    fail('usage: qc relay domains list|add <domain>|rm <id> --yes');
  }
  if (sub === 'log' || sub === 'events') {
    if (flags.csv) { const text = await apiText(`/api/v1/relay/events.csv${flags.q ? `?q=${encodeURIComponent(flags.q)}` : ''}`); const out = flags.out || 'quicksmtp-delivery-log.csv'; fs.writeFileSync(out, text); return say(`delivery log saved to ${out}`); }
    const qs = new URLSearchParams(); if (flags.q) qs.set('q', flags.q); if (flags.sender) qs.set('sender_id', flags.sender); if (flags.limit) qs.set('limit', flags.limit);
    const r = await api('GET', `/api/v1/relay/events${qs.toString() ? '?' + qs : ''}`); const ev = r.events || [];
    return emit(r, () => (ev.length ? table(['TIME', 'EVENT', 'SENDER', 'FROM', 'TO', 'SUBJECT', 'CODE', 'REASON'], ev.map((e) => [e.at || e.created_at || '', e.event, e.username || e.sender_id, e.from_addr || '', e.rcpt || '', (e.subject || '').slice(0, 40), e.smtp_code ?? '', (e.reason || '').slice(0, 50)])) : say('no delivery events yet.')));
  }
  fail(`unknown: relay ${sub} - try status, senders, domains, log`);
}

// --- hosted DNS ---------------------------------------------------------------
// Zones by id or name; record sets are whole-set upserts (Route-53 style), so
// `qc dns set example.com www A 203.0.113.10 203.0.113.11` replaces the set.
async function cmdDns(pos, flags) {
  const sub = (pos.shift() || 'zones').toLowerCase();
  if (sub === 'zones' || sub === 'list' || sub === 'ls') {
    const r = await api('GET', '/api/v1/dns/zones'); const zs = r.zones || [];
    return emit(r, () => { if (r.ns_hosts) say(`nameservers: ${r.ns_hosts.join(', ')}`); zs.length ? table(['ID', 'ZONE', 'STATUS', 'SERIAL', 'DELEGATED', 'RRSETS'], zs.map((z) => [z.id, z.name, z.status, z.serial, z.delegation_ok == null ? '—' : (z.delegation_ok ? 'yes' : 'NO'), z.rrsets])) : say('no zones.'); });
  }
  if (sub === 'add' || sub === 'create') { const name = need(pos[0], 'qc dns add <domain>'); const r = await api('POST', '/api/v1/dns/zones', { name }, { 'Idempotency-Key': `qc-zone-${name}` }); return emit(r, () => say(`zone #${r.zone?.id} ${r.zone?.name} added.`)); }
  const zone = need(pos[0], `qc dns ${sub} <zone>`);
  if (sub === 'show' || sub === 'records' || sub === 'get') {
    const r = await api('GET', `/api/v1/dns/zones/${encodeURIComponent(zone)}`); const z = r.zone || {}; const sets = z.rrsets || [];
    return emit(r, () => { say(`#${z.id}  ${z.name}  serial ${z.serial ?? '—'}`); sets.length ? table(['ID', 'NAME', 'TYPE', 'TTL', 'POLICY', 'RECORDS'], sets.map((s) => [s.id, s.name || '@', s.type, s.ttl, s.policy || 'simple', (s.records || []).map((x) => x.content + (x.weight ? ` (w${x.weight})` : '') + (x.failover_role ? ` (${x.failover_role})` : '')).join(' | ')])) : say('no record sets.'); });
  }
  if (sub === 'set') {
    const name = need(pos[1], 'qc dns set <zone> <name|@> <TYPE> <value…> [--ttl n]'); const type = need(pos[2], 'qc dns set <zone> <name|@> <TYPE> <value…>').toUpperCase();
    const values = pos.slice(3); if (!values.length) fail('give at least one value');
    const body = { name, type, records: values, ...(flags.ttl ? { ttl: +flags.ttl } : {}) };
    const r = await api('PUT', `/api/v1/dns/zones/${encodeURIComponent(zone)}/rrsets`, body);
    return emit(r, () => say(`${name} ${type} set (${values.length} record${values.length === 1 ? '' : 's'}); zone serial ${r.zone?.serial ?? '—'}.`));
  }
  if (sub === 'rm' || sub === 'delete-record') { const rr = need(pos[1], 'qc dns rm <zone> <name:TYPE|rrset-id>'); const r = await api('DELETE', `/api/v1/dns/zones/${encodeURIComponent(zone)}/rrsets/${encodeURIComponent(rr)}`); return emit(r, () => say(`removed ${rr}.`)); }
  if (sub === 'check') { const r = await api('POST', `/api/v1/dns/zones/${encodeURIComponent(zone)}/check-delegation`, {}); return emit(r, () => say(JSON.stringify(r, null, 2))); }
  if (sub === 'export') { const r = await api('GET', `/api/v1/dns/zones/${encodeURIComponent(zone)}/export`); return emit(r, () => process.stdout.write(r.text || '')); }
  if (sub === 'import') { if (!flags.file) fail('usage: qc dns import <zone> --file zone.txt'); const r = await api('POST', `/api/v1/dns/zones/${encodeURIComponent(zone)}/import`, { text: fs.readFileSync(flags.file, 'utf8') }); return emit(r, () => say(JSON.stringify(r, null, 2))); }
  if (sub === 'delete' || sub === 'rm-zone') { if (!flags.yes) fail(`deleting ${zone} removes every record and stops answering within seconds - re-run with --yes`); const r = await api('DELETE', `/api/v1/dns/zones/${encodeURIComponent(zone)}`, undefined, { 'Idempotency-Key': `qc-zone-del-${zone}` }); return emit(r, () => say(`deleted ${zone}.`)); }
  fail(`unknown: dns ${sub} - try zones, add, show, set, rm, check, export, import, delete`);
}

// qc update: fetch the panel's current qc.mjs and replace THIS file in place.
// Safety: the download must parse as a module (node --check on a temp copy)
// and carry a VERSION line before it replaces anything; the swap is a rename
// (atomic on the same filesystem); the old copy is kept as qc.prev next to it
// for one command's worth of regret. A directory we can't write to gets the
// sudo one-liner instead of a half-written binary.
async function cmdUpdate(flags) {
  const self = fs.realpathSync(process.argv[1]);
  const { url } = cfg();
  const latest = await latestVersion(true);
  if (!latest) fail(`could not reach ${url}/api/cli/version to check for updates`);
  if (!flags.force && !semverGt(latest, VERSION)) return say(`qc ${VERSION} is up to date (panel offers ${latest}).`);
  let res; try { res = await fetch(url + '/api/cli/qc.mjs'); } catch (e) { fail(`download failed: ${e?.message || e}`); }
  if (!res.ok) fail(`download failed: HTTP ${res.status}`);
  const src = await res.text();
  const m = src.match(/const VERSION = '([^']+)'/);
  if (!m) fail('the download does not look like qc (no VERSION line) - not installed');
  const tmp = path.join(path.dirname(self), `.qc.${process.pid}.tmp.mjs`);
  try { fs.writeFileSync(tmp, src, { mode: 0o755 }); }
  catch (e) { fail(`cannot write to ${path.dirname(self)} (${e.code}) - update by hand:\n  curl -fsSL ${url}/api/cli/qc.mjs -o qc && chmod +x qc && sudo mv qc ${self}`); }
  const chk = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  if (chk.status !== 0) { try { fs.unlinkSync(tmp); } catch { /* */ } fail(`the downloaded file does not parse - not installed:\n${chk.stderr.trim().split('\n').slice(0, 3).join('\n')}`); }
  try { fs.copyFileSync(self, self + '.prev'); fs.renameSync(tmp, self); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* */ } fail(`could not replace ${self} (${e.code}) - update by hand:\n  curl -fsSL ${url}/api/cli/qc.mjs -o qc && chmod +x qc && sudo mv qc ${self}`); }
  try { fs.writeFileSync(VC_FILE, JSON.stringify({ checkedAt: Date.now(), latest: m[1] })); } catch { /* */ }
  say(`updated qc ${VERSION} → ${m[1]} at ${self}  (previous copy kept as ${path.basename(self)}.prev)`);
}
function need(v, usage) { if (v == null || v === '') fail(`usage: ${usage}`); return v; }

// --- shell tab completion ---------------------------------------------------
// `qc completion bash|zsh` prints a snippet that delegates back to
// `qc __complete <cword> <words…>`, so completion always tracks the command tree.
const COMPLETE_TOP = ['config', 'whoami', 'templates', 'vm', 'net', 'snap', 'backup', 'preset', 'dedi', 'fw', 'lb', 'box', 'db', 'relay', 'dns', 'job', 'reseller', 'update', 'completion', 'help', 'version'];
const COMPLETE_SUB = {
  vm: ['list', 'show', 'create', 'start', 'stop', 'shutdown', 'reboot', 'rename', 'resize', 'delete', 'wait', 'ssh'],
  net: ['list', 'create', 'free-ips', 'attach', 'detach', 'rm'],
  snap: ['list', 'create', 'rollback', 'rm'],
  backup: ['list', 'create', 'restore', 'rm'],
  preset: ['list', 'save', 'show', 'rm'],
  dedi: ['list', 'stock', 'buy', 'show', 'reinstall', 'on', 'off', 'reboot', 'status', 'rescue', 'netboot', 'disarm', 'console', 'console-clear', 'bmc-reset', 'job', 'bandwidth', 'ips', 'storage', 'release'],
  fw: ['list', 'sizes', 'create', 'show', 'rename', 'set', 'rules', 'forwards', 'vpn', 'lans', 'wan', 'nat1', 'tunnels', 'reboot', 'update', 'traffic', 'delete'],
  lb: ['list', 'info', 'create', 'show', 'rename', 'listeners', 'backends', 'domains', 'delete'],
  box: ['list', 'plans', 'create', 'show', 'password', 'resize', 'mode', 'snap', 'allow', 'keys', 'delete'],
  db: ['list', 'sizes', 'create', 'show', 'rename', 'admin-password', 'start', 'stop', 'shutdown', 'reboot', 'switchover', 'logs', 'recovery', 'alerts', 'ca', 'users', 'databases', 'adopt', 'set', 'allow', 'backup', 'restore', 'recover', 'delete'],
  relay: ['status', 'senders', 'domains', 'log'],
  dns: ['zones', 'add', 'show', 'set', 'rm', 'check', 'export', 'import', 'delete'],
  job: ['get', 'wait'], config: ['show', 'set'], reseller: ['customers'],
};
function cmdComplete(raw) {
  const cword = parseInt(raw[0], 10) || 0;
  const words = raw.slice(1).map(String);          // words[0] === 'qc'
  const cur = words[cword] || '';
  const cmd = (words[1] || '').toLowerCase();
  const sub = (words[2] || '').toLowerCase();
  let c = [];
  if (cword <= 1) c = COMPLETE_TOP;
  else if (cword === 2 && COMPLETE_SUB[cmd]) c = COMPLETE_SUB[cmd];
  else if (cmd === 'config' && sub === 'set' && cword === 3) c = ['url', 'token'];
  else if (cmd === 'reseller' && sub === 'customers' && cword === 3) c = ['list', 'create', 'show', 'suspend', 'resume', 'delete', 'sso'];
  else if (cmd === 'completion' && cword === 2) c = ['bash', 'zsh'];
  else if (cmd === 'vm' && sub === 'create' && cur.startsWith('-')) c = ['--name', '--vcpu', '--ram', '--disk', '--os', '--ssh-key', '--user', '--password', '--user-data', '--user-data-file', '--preset', '--priv-net', '--priv-ip', '--no-ip', '--wait'];
  else if (cmd === 'net' && sub === 'create' && cur.startsWith('-')) c = ['--cidr', '--gateway'];
  else if (cmd === 'net' && sub === 'attach' && cur.startsWith('-')) c = ['--ip'];
  else if (cmd === 'net' && sub === 'rm' && cur.startsWith('-')) c = ['--yes'];
  else if (cmd === 'snap' && sub === 'create' && cur.startsWith('-')) c = ['--ram', '--note'];
  else if (cmd === 'snap' && (sub === 'rollback' || sub === 'rm') && cur.startsWith('-')) c = ['--yes'];
  else if (cmd === 'backup' && sub === 'create' && cur.startsWith('-')) c = ['--note'];
  else if (cmd === 'backup' && (sub === 'restore' || sub === 'rm') && cur.startsWith('-')) c = ['--yes'];
  else if (cmd === 'preset' && sub === 'save' && cur.startsWith('-')) c = ['--file'];
  else if (cmd === 'preset' && sub === 'rm' && cur.startsWith('-')) c = ['--yes'];
  else if (cmd === 'vm' && sub === 'resize' && cur.startsWith('-')) c = ['--vcpu', '--ram', '--disk'];
  else if (cmd === 'vm' && sub === 'wait' && cur.startsWith('-')) c = ['--status'];
  else if (cmd === 'vm' && sub === 'ssh' && cur.startsWith('-')) c = ['--user'];
  else if (cmd === 'vm' && sub === 'delete' && cur.startsWith('-')) c = ['--yes'];
  else if (cmd === 'reseller' && cur.startsWith('-')) c = ['--label', '--ext-ref', '--vcpu', '--ram', '--disk', '--ips', '--yes'];
  else if (cmd === 'dedi' && (sub === 'buy' || sub === 'reinstall') && cur.startsWith('-')) c = ['--os', '--hostname', '--nameservers', '--user', '--password', '--ssh-key', '--ssh-key-file', '--root-ssh', '--fs', '--boot', '--no-boot', '--yes'];
  else if (cmd === 'dedi' && sub === 'ips' && cword === 3) c = ['list', 'add', 'rm', 'primary'];
  else if (cmd === 'dedi' && sub === 'storage' && cword === 3) c = ['show', 'discover', 'apply', 'boot-vd'];
  else if (cmd === 'dedi' && cur.startsWith('-')) c = ['--yes', '--wait', '--mode', '--hours', '--address', '--pay-cleanup-fee', '--file'];
  else if (cmd === 'dns' && cur.startsWith('-')) c = ['--ttl', '--file', '--yes'];
  else if (cmd === 'fw' && sub === 'create' && cur.startsWith('-')) c = ['--label', '--size', '--ha', '--ips', '--lan', '--no-dhcp', '--subnet', '--address', '--port', '--yes'];
  else if (cmd === 'fw' && ['rules', 'forwards', 'vpn', 'lans', 'wan', 'nat1', 'tunnels'].includes(sub) && cword === 3) c = ['list', 'add', 'rm'];
  else if (cmd === 'lb' && sub === 'listeners' && cur.startsWith('-')) c = ['--http', '--tcp', '--port', '--algorithm', '--sticky', '--proxy-protocol', '--hc-path', '--hc-status', '--hc-interval', '--tls', '--redirect', '--backend-port', '--yes'];
  else if (cmd === 'lb' && cur.startsWith('-')) c = ['--label', '--ip', '--port', '--weight', '--yes'];
  else if (cmd === 'relay' && cur.startsWith('-')) c = ['--label', '--reason', '--q', '--sender', '--limit', '--csv', '--out', '--yes'];
  else if (cmd === 'db' && cur.startsWith('-')) c = ['--label', '--engine', '--size', '--version', '--allow', '--network', '--address', '--database', '--ha', '--password', '--access', '--owner', '--extensions', '--at', '--set', '--target', '--out', '--node', '--request', '--yes'];
  else if (cmd === 'box' && cur.startsWith('-')) c = ['--metered', '--cap', '--plan', '--label', '--keep', '--none', '--yes'];
  else if (cmd === 'fw' && cur.startsWith('-')) c = ['--port', '--proto', '--from', '--to', '--block', '--label', '--wan-ip', '--lan', '--cidr', '--address', '--out', '--remote', '--lans', '--endpoint', '--range', '--yes'];
  process.stdout.write(c.filter((x) => x.startsWith(cur)).join('\n') + '\n');
}
function cmdCompletion(pos) {
  const sh = (pos[0] || '').toLowerCase();
  if (sh === 'bash') return say(`_qc() { local IFS=$'\\n'; COMPREPLY=( $(qc __complete "$COMP_CWORD" "\${COMP_WORDS[@]}" 2>/dev/null) ); }\ncomplete -F _qc qc`);
  if (sh === 'zsh') return say(`_qc() { compadd -- \${(f)"$(qc __complete $((CURRENT-1)) \${words[@]} 2>/dev/null)"} }\ncompdef _qc qc`);
  fail('usage: qc completion bash|zsh   (add `eval "$(qc completion bash)"` to your ~/.bashrc or ~/.zshrc)');
}

function help() {
  say(`qc ${VERSION} — QuickCloud CLI

Usage: qc <command> [args] [--json]

  config show                       show current url + token location
  config set url|token <value>      configure the panel URL / API key
  whoami                            workspace, billing & quota
  templates                         OS templates you can launch from
  templates <name>                  required inputs for one template

  vm list                           list your VMs
  vm show <id>                      VM detail
  vm create --name <n> --vcpu <n> --ram <GB> --disk <GB> --os <template>
            [--ssh-key "<pub>"] [--user u] [--password p]
            [--user-data-file <path>] [--preset <name>] [--no-ip] [--wait]
                                    --user-data-file: cloud-init run on first boot
                                    --preset: a saved cloud-init preset (qc preset list)
  vm start|stop|shutdown|reboot <id>
  vm rename <id> <name>
  vm resize <id> [--vcpu n] [--ram GB] [--disk GB]
  vm wait <id> [--status running|stopped]   block until VM reaches a state
  vm ssh <id> [--user u] [-- ssh args…]     open an SSH session to the VM
  vm delete <id> --yes

  net list                          list your private networks
  net create <label> --cidr <CIDR> [--gateway <ip>]
  net free-ips <network>            free addresses in a network
  net attach <vm-id> <network> [--ip <addr>]    add a private NIC to a VM
  net detach <vm-id> <nic-index>    remove an interface from a VM
  net rm <network> --yes            delete a private network

  snap list <vm-id>                 list snapshots
  snap create <vm-id> [<label>] [--ram]     point-in-time snapshot
  snap rollback <vm-id> <snap-id> --yes     revert (discards later changes)
  snap rm <vm-id> <snap-id>

  backup list <vm-id>               list durable (off-storage) backups
  backup create <vm-id> [--note "…"]
  backup restore <vm-id> <volid> --yes      in-place restore (overwrites disks)
  backup rm <vm-id> <volid> --yes

  preset list                       saved cloud-init presets (bootstrap documents)
  preset save <name> --file <path>  save/update one (or pipe it on stdin)
  preset show <name>                print its content
  preset rm <name> --yes            delete it

  dedi list                         your dedicated servers
  dedi stock                        bare metal for sale by the hour
  dedi buy <stock-id> [--os <tpl> --hostname h --user u --password p|--ssh-key "<pub>"] --yes
                                    charges the minimum rental now; --os installs straight away
  dedi show <id>                    hardware, power, IPs, armed boot, RAID
  dedi reinstall <id> --os <tpl> [--hostname h] [--user u --password p|--ssh-key-file p]
                 [--root-ssh] [--fs ext4|xfs] [--boot] --yes     WIPES the server
  dedi on|off|reboot|status <id> [--wait]   chassis power via the management controller
  dedi rescue|netboot <id> --yes    boot SystemRescue / the netboot.xyz menu
  dedi disarm <id>                  cancel an armed PXE boot
  dedi console <id> [--mode sol|vnc]        mint a console session (open in the panel)
  dedi job <id> <job-id> [--wait]   poll a hardware job
  dedi ips <id> list|add [--address a]|rm <ip-id> --yes|primary <ip-id>
  dedi storage <id> show|discover|apply --file plan.json --yes|boot-vd <fqdd>
  dedi bandwidth <id> [--hours n]
  dedi release <id> --yes           hand an hourly server back (wiped, billing stops)

  fw list | sizes                   your Cloud Firewalls / sizes + prices
  fw create --label <n> [--size small|medium|large] [--ha] [--ips n] [--lan <cidr>] --yes
  fw show <id>                      addresses, networks, rules, forwards, NAT, VPN, tunnels
  fw rules <id> list|add --port 443 [--proto tcp|udp] [--from <cidr>] [--block]|rm <rid>|enable|disable
  fw forwards <id> list|add --port <public> --to <lan-ip>[:port]|rm <fid>
  fw vpn <id> list|add <user>|profile <uid> --out u.ovpn|regenerate <uid>|rm <uid>
  fw lans <id> list|add --cidr <c>|attach <lid> <vm-id>|detach <lid> <vm-id>|private-only <lid> <vm-id> --yes|rm <lid> --yes
  fw wan <id> list|add|rm <ip-id> --yes        extra public addresses
  fw nat1 <id> list|add --to <lan-ip> [--wan-ip <ip>|new]|rm <nid>
  fw tunnels <id> list|add --label HQ --remote <cidr>|config <tid> --out f|rm <tid> --yes
  fw reboot|update <id> --yes
  fw delete <id> --yes

  lb list | info                    your load balancers / price, limits, port range, fleet
  lb create --label <n> --yes       a hostname on the shared fleet, billed hourly
  lb show <id>                      listeners, backends + health, domains, certificates
  lb listeners <id> add --http [--tls managed] [--redirect] [--algorithm a] [--sticky] [--hc-path p]
  lb listeners <id> add --tcp --port <n>    |  set <lid> …  |  rm <lid> --yes
  lb backends <id> <lid> add --ip <your-ip> [--port n] [--weight n] | drain|undrain|rm <bid>
  lb domains <id> add <domain> | verify <did> | rm <did>
  lb delete <id> --yes

  box list | plans                  your storage boxes / metered price + fixed plans
  box create --metered --cap <GB> | --plan <slug> [--label l] --yes    SFTP password printed ONCE
  box show <id>                     usage, snapshots, allowlist, keys
  box password <id> --yes           new SFTP password (shown once)
  box resize <id> --cap <GB>|--plan <slug>    box mode <id> metered|fixed [--plan s]
  box snap <id> list|create|auto on|off [--keep n]|rm <sid>
  box allow <id> list|add <cidr>|rm <eid>     SFTP allowed from these ranges only
  box keys <id> list|set <key-id…>|set --none          key-based SFTP (panel key manager ids)
  box delete <id> --yes

  db list | sizes                   your database instances / engines, sizes with all-in prices
  db create --label <n> --engine postgres|mariadb|valkey [--size s] (--allow <cidr,…> | --network <id>) [--database d] [--ha] --yes
                                    builds dedicated server(s), bills hourly; admin password printed ONCE
  db show <id>                      connection, users, databases, access, backups, usage
  db admin-password <id> [rotate --yes]       one-time reveal / fresh password
  db users <id> list|add <name>|password <uid>|grant <uid> <db-id> <role>|rm <uid> --yes
  db databases <id> list|add <name> [--extensions a,b]|drop <did> --yes
  db allow <id> list|add <cidr>|rm <eid>      access list (public instances)
  db set <id> [key=value…]          engine settings (alone: show current + settable keys)
  db start|stop|shutdown|reboot <id> [--yes]   single instance power;  db switchover <id> <node> --yes (HA)
  db backup <id>                    full backup now
  db restore <id> --at <utc> [--label l] --yes     NEW instance from a point in time
  db recover <id> <database> --at <utc> [--target n]   one database back INTO this instance
  db logs <id> [--request] | db ca <id> --out ca.pem | db alerts <id> on|off
  db delete <id> --yes

  relay status                      SMTP relay subscription, quota, senders, domains
  relay senders list|add --label l|pause <id>|resume <id>|revoke <id> --yes   (password shown once)
  relay domains list|add <domain>|rm <id> --yes       DKIM: prints the TXT record to publish
  relay log [--q text] [--sender id] [--limit n] [--csv --out file]   delivery log

  dns zones                         your hosted zones + our nameservers
  dns add <domain>                  add a zone
  dns show <zone>                   all record sets (zone by id or name)
  dns set <zone> <name|@> <TYPE> <value…> [--ttl n]   create/replace a record set
  dns rm <zone> <name:TYPE|id>      delete a record set ('@:TXT' = apex)
  dns check <zone>                  is the domain delegated to us?
  dns export <zone>                 BIND zone file to stdout
  dns import <zone> --file <path>   import a BIND zone file
  dns delete <zone> --yes           delete the zone

  job get <id>                      check an async job
  job wait <id>                     block until a job finishes

  reseller customers list|create|show|suspend|resume|delete|sso …   (reseller keys)

  update                            download the panel's current qc and replace this one
  version [--check]                 this version (--check: ask the panel for the latest now)
  completion bash|zsh               print a shell tab-completion script

Add --json to any command for machine-readable output.
Tab completion:  add  eval "$(qc completion bash)"  (or zsh) to your shell rc.
Auth: create a key in the panel → API, then:  qc config set token <key>`);
}

// Completion bridge — handled from the RAW argv (the words being completed can
// look like flags, which the normal parser would swallow).
if (process.argv[2] === '__complete') { cmdComplete(process.argv.slice(3)); process.exit(0); }

const { pos, flags } = parseArgs(argv);
const cmd = (pos.shift() || 'help').toLowerCase();
(async () => {
  switch (cmd) {
    case 'help': case '-h': case '--help': return help();
    case 'version': case '-v': case '--version': {
      say(`qc ${VERSION}`);
      if (flags.check) { const latest = await latestVersion(true); say(latest ? (semverGt(latest, VERSION) ? `latest: ${latest} - run:  qc update` : `latest: ${latest} - up to date`) : 'could not reach the panel to check'); }
      return;
    }
    case 'update': case 'self-update': return cmdUpdate(flags);
    case 'completion': return cmdCompletion(pos);
    case 'config': return cmdConfig(pos, flags);
    case 'whoami': case 'workspace': return cmdWhoami();
    case 'templates': return cmdTemplates(pos);
    case 'vm': return cmdVm(pos, flags);
    case 'net': return cmdNet(pos, flags);
    case 'snap': case 'snapshot': return cmdSnap(pos, flags);
    case 'backup': return cmdBackup(pos, flags);
    case 'preset': case 'presets': return cmdPreset(pos, flags);
    case 'dedi': case 'dedicated': return cmdDedi(pos, flags);
    case 'fw': case 'firewall': return cmdFw(pos, flags);
    case 'lb': case 'loadbalancer': return cmdLb(pos, flags);
    case 'box': case 'storagebox': case 'storage': return cmdBox(pos, flags);
    case 'db': case 'database': case 'databases': return cmdDb(pos, flags);
    case 'relay': case 'smtp': return cmdRelay(pos, flags);
    case 'dns': return cmdDns(pos, flags);
    case 'job': return cmdJob(pos, flags);
    case 'reseller': return cmdReseller(pos, flags);
    default: fail(`unknown command: ${cmd} (try: qc help)`);
  }
})()
  .then(() => { if (!['completion', 'update', 'version', '-v', '--version'].includes(cmd)) return maybeNotifyUpdate(); })
  .catch((e) => fail(e?.message || String(e)));
