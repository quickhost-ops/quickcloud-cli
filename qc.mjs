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

const VERSION = '1.0.0';
const DEFAULT_URL = 'https://cloud.quickhost.uk';   // (the panel pre-fills this on download)
const CFG_DIR = path.join(os.homedir(), '.config', 'quickcloud');
const CFG_FILE = path.join(CFG_DIR, 'config.json');

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

async function api(method, p, body) {
  const { url, token } = cfg();
  if (!token) fail('no API key set — run:  qc config set token <key>   (create one in the panel → API)');
  let res;
  try {
    res = await fetch(url + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
    fail(msg);
  }
  return json || {};
}

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  say(headers.map((h, i) => h.padEnd(w[i])).join('  '));
  rows.forEach((r) => say(r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ')));
}
const gb = (mb) => (mb >= 1024 ? `${mb / 1024}G` : `${mb}M`);

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
    return emit(r, () => { say(`#${v.id}  ${v.name}  [${v.status}]`); say(`spec  : ${v.vcpu} vCPU · ${gb(v.ram_mb)} RAM · ${v.disk_gb}G disk`); say(`ipv4  : ${v.ipv4 || '—'}`); if (v.ipv6) say(`ipv6  : ${v.ipv6}`); });
  }
  if (powers[sub]) {
    const id = need(pos[0], `qc vm ${sub} <id>`);
    const r = await api('POST', `/api/v1/vms/${id}/power`, { action: powers[sub] });
    return emit(r, () => say(`${sub} queued (job ${r.job?.id}).`));
  }
  if (sub === 'create' || sub === 'new') {
    if (!flags.name) fail('usage: qc vm create --name <n> --vcpu <n> --ram <GB> --disk <GB> --os <template> [--ssh-key "<pub>"] [--user u] [--password p] [--user-data-file <path>] [--no-ip] [--wait]');
    if (!flags.os) fail('missing --os <template> — run `qc templates` to list them');
    const body = { name: flags.name, template: flags.os, vcpu: +flags.vcpu || 1, ram_mb: Math.round((+flags.ram || 1) * 1024), disk_gb: +flags.disk || 20, fields: {} };
    if (flags['no-ip']) body.ip = 'none';
    if (flags.user) body.fields.ciuser = flags.user;
    if (flags.password) body.fields.password = flags.password;
    if (flags['ssh-key']) body.fields.sshkeys = flags['ssh-key'];
    if (flags['user-data']) body.fields.user_data = flags['user-data'];
    else if (flags['user-data-file']) { try { body.fields.user_data = fs.readFileSync(flags['user-data-file'], 'utf8'); } catch (e) { fail(`cannot read --user-data-file: ${e.message}`); } }
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

function need(v, usage) { if (v == null || v === '') fail(`usage: ${usage}`); return v; }

// --- shell tab completion ---------------------------------------------------
// `qc completion bash|zsh` prints a snippet that delegates back to
// `qc __complete <cword> <words…>`, so completion always tracks the command tree.
const COMPLETE_TOP = ['config', 'whoami', 'templates', 'vm', 'job', 'reseller', 'completion', 'help', 'version'];
const COMPLETE_SUB = {
  vm: ['list', 'show', 'create', 'start', 'stop', 'shutdown', 'reboot', 'rename', 'resize', 'delete', 'wait', 'ssh'],
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
  else if (cmd === 'vm' && sub === 'create' && cur.startsWith('-')) c = ['--name', '--vcpu', '--ram', '--disk', '--os', '--ssh-key', '--user', '--password', '--user-data', '--user-data-file', '--no-ip', '--wait'];
  else if (cmd === 'vm' && sub === 'resize' && cur.startsWith('-')) c = ['--vcpu', '--ram', '--disk'];
  else if (cmd === 'vm' && sub === 'wait' && cur.startsWith('-')) c = ['--status'];
  else if (cmd === 'vm' && sub === 'ssh' && cur.startsWith('-')) c = ['--user'];
  else if (cmd === 'vm' && sub === 'delete' && cur.startsWith('-')) c = ['--yes'];
  else if (cmd === 'reseller' && cur.startsWith('-')) c = ['--label', '--ext-ref', '--vcpu', '--ram', '--disk', '--ips', '--yes'];
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
            [--user-data-file <path>] [--no-ip] [--wait]
                                    --user-data-file: cloud-init run on first boot
  vm start|stop|shutdown|reboot <id>
  vm rename <id> <name>
  vm resize <id> [--vcpu n] [--ram GB] [--disk GB]
  vm wait <id> [--status running|stopped]   block until VM reaches a state
  vm ssh <id> [--user u] [-- ssh args…]     open an SSH session to the VM
  vm delete <id> --yes

  job get <id>                      check an async job
  job wait <id>                     block until a job finishes

  reseller customers list|create|show|suspend|resume|delete|sso …   (reseller keys)

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
    case 'version': case '-v': case '--version': return say(`qc ${VERSION}`);
    case 'completion': return cmdCompletion(pos);
    case 'config': return cmdConfig(pos, flags);
    case 'whoami': case 'workspace': return cmdWhoami();
    case 'templates': return cmdTemplates(pos);
    case 'vm': return cmdVm(pos, flags);
    case 'job': return cmdJob(pos, flags);
    case 'reseller': return cmdReseller(pos, flags);
    default: fail(`unknown command: ${cmd} (try: qc help)`);
  }
})().catch((e) => fail(e?.message || String(e)));
