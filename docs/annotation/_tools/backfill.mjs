// 批量回填：对 ZC-deep-bNNN 逐批跑六件套，把提交号与 numstat 写回台账。
//
// 关键前提：这些批次的注释已随安全快照 a8784b7e 入库，HEAD 已含注释，
// 因此所有「diff HEAD」型门禁必须显式传 --diff-base / --base = a8784b7e^，
// 否则重跑恒为 0 行，会假 PASS。这一点写进每批回填块，避免被读成"重新验收"。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'D:/code/ZCode';
const BASE = 'D:/code/_annot_baseline';
const SNAP = 'a8784b7e';
const PREFIX = '8f7daaf0'; // a8784b7e^
const DOCS = path.join(REPO, 'docs/annotation');

const from = Number(process.argv[2] || 226);
const to = Number(process.argv[3] || 207);

const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const clean = (s) => (s || '').replace(/^\uFEFF/, '');

function numstatOf(files) {
  let added = 0;
  let deleted = 0;
  const missing = [];
  for (const f of files) {
    let out = '';
    try {
      out = git(['show', '--numstat', '--format=', SNAP, '--', f]).trim();
    } catch {
      out = '';
    }
    if (!out) {
      missing.push(f);
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      if (m[1] !== '-') added += Number(m[1]);
      if (m[2] !== '-') deleted += Number(m[2]);
    }
  }
  return { added, deleted, missing };
}

function run(name, cmd, args) {
  try {
    const r = execFileSync(process.execPath, [cmd, ...args], {
      cwd: BASE,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sum = (r || '').split(/\r?\n/).filter((l) => l.startsWith('SUMMARY')).pop();
    return sum || 'SUMMARY (无输出)';
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    const sum = out.split(/\r?\n/).filter((l) => l.startsWith('SUMMARY')).pop();
    if (sum) return sum + ' [exit!=' + (e.status ?? '?') + ']';
    return 'ERR ' + (out.split(/\r?\n/).filter(Boolean)[0] || String(e.message)).slice(0, 160) + ' [' + name + ']';
  }
}

const results = [];
for (let n = from; n >= to; n--) {
  const batch = `ZC-deep-b${n}`;
  const listFile = path.join(BASE, batch, '_files.txt');
  const origDir = path.join(BASE, batch, 'orig');
  const ledger = path.join(DOCS, `ZC-DEEP-b${n}.md`);
  if (!fs.existsSync(listFile)) {
    results.push({ batch, err: 'missing _files.txt' });
    continue;
  }
  const files = clean(fs.readFileSync(listFile, 'utf8'))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const { added, deleted, missing } = numstatOf(files);

  const gates = {
    gate: run('gate', path.join(BASE, 'zc-gate.mjs'), ['--scan', listFile, '--base', PREFIX]),
    verify: run('verify', path.join(BASE, 'zc-verify.mjs'), [batch]),
    tokens: run('tokens', path.join(BASE, 'check-code-tokens.mjs'), [REPO, listFile, origDir]),
    strings: run('strings', path.join(BASE, 'check-comments-in-strings.mjs'), [
      REPO,
      listFile,
      path.join(BASE, batch, '_strings.json'),
      PREFIX,
    ]),
    boiler: run('boiler', path.join(BASE, 'deep-boilerplate.mjs'), [
      REPO,
      '--diff',
      '--diff-base',
      PREFIX,
      '--file-list',
      listFile,
    ]),
    upstream: run('upstream', path.join(BASE, 'check-upstream-comments.mjs'), [REPO, listFile, PREFIX]),
  };

  const allPass =
    Object.values(gates).every((s) => /badFiles=0|deletedNonZero=0|codeTokenDiff=0|violations=0|groups=0|missing=0/.test(s)) &&
    !Object.values(gates).some((s) => s.startsWith('ERR'));

  results.push({ batch, n, files: files.length, added, deleted, missing, gates, allPass });
}

// 输出与回填
for (const r of results) {
  if (r.err) {
    console.log(`${r.batch}: ${r.err}`);
    continue;
  }
  console.log(
    `${r.batch}: files=${r.files} numstat=+${r.added}/-${r.deleted} missing=${r.missing.length} ${r.allPass ? 'PASS' : 'CHECK'}`,
  );
  if (!r.allPass) for (const [k, v] of Object.entries(r.gates)) console.log(`   ${k}: ${v}`);
}
fs.writeFileSync(path.join(BASE, 'snapshot', 'backfill-results.json'), JSON.stringify(results, null, 1), 'utf8');
