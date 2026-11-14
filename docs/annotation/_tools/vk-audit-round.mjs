// 本轮收口证据：A 档单元覆盖率 + W 新旧拆分 + badFiles 分档归属
import fs from 'node:fs';
import path from 'node:path';
import { commentMap, diffAdded, judgeBlocks } from './vk-gate.mjs';

const REPO = 'd:/code/opensource/valkey';
const BASE = 'd:/code/_annot_baseline';

const A = [
  'src/resp_parser.c','src/connection.c','src/socket.c','src/anet.c','src/unix.c','src/syncio.c',
  'src/pubsub.c','src/tracking.c','src/t_stream.c',
  'src/ae_epoll.c','src/ae_kqueue.c','src/ae_select.c','src/ae_evport.c','src/io_threads.c',
  'src/bio.c','src/mutexqueue.c','src/queues.c','src/memory_prefetch.c','src/threads_mngr.c',
  'src/rio.c','src/rdb_transcoder.c','src/forkless.c','src/childinfo.c','src/db.c','src/kvstore.c',
  'src/lazyfree.c','src/defrag.c','src/bgiteration.c','src/object.c','src/sds.c',
  'src/cluster.c','src/cluster_legacy.c','src/cluster_migrateslots.c','src/cluster_slot_stats.c',
  'src/sentinel.c','src/module.c','src/scripting_engine.c','src/script.c','src/eval.c',
  'src/modules/lua/script_lua.c','src/modules/lua/engine_lua.c','src/modules/lua/function_lua.c',
  'src/t_hash.c','src/t_zset.c','src/t_set.c','src/t_list.c','src/t_string.c',
];

function isStatementStart(t, prevCode) {
  if (/^[{}];?$/.test(t)) return false;                 // 孤立大括号/分号
  if (/^\}\s*(else|while)\b/.test(t)) return true;      // } else / } while
  if (/^(else|case\b|default\b)/.test(t)) return true;
  if (!prevCode) return true;
  const p = prevCode.text;
  if (/^#/.test(p)) return true;
  return /[;{}:]$/.test(p);
}

function analyze(abs) {
  const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
  let inBlock = false, prevNonBlank = null, prevCode = null;
  let units = 0, covered = 0;
  const uncovered = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (inBlock) { if (t.includes('*/')) inBlock = false; prevNonBlank = { type: 'comment', text: t }; continue; }
    if (t.startsWith('//')) { prevNonBlank = { type: 'comment', text: t }; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; prevNonBlank = { type: 'comment', text: t }; continue; }
    if (t.startsWith('#')) { prevNonBlank = { type: 'pp', text: t }; prevCode = { text: t }; continue; }
    if (isStatementStart(t, prevCode)) {
      units++;
      if (prevNonBlank && prevNonBlank.type === 'comment' && prevNonBlank.text.startsWith('//')) covered++;
      else uncovered.push(i + 1);
    }
    prevCode = { text: t };
    prevNonBlank = { type: 'code', text: t };
  }
  return { units, covered, uncovered };
}

function waterLines(rel) {
  const cm = commentMap(path.join(REPO, rel));
  const { added } = diffAdded(rel, REPO);
  const entries = added.filter((n) => cm.has(n)).map((n) => ({ line: n, content: cm.get(n) }));
  const { findings } = judgeBlocks(entries);
  const lines = [];
  for (const f of findings) for (let l = f.line; l <= f.endLine; l++) lines.push(l);
  return { added: entries.length, lines };
}

function loadEntries(dir, file) {
  const p = path.join(BASE, dir, file);
  if (!fs.existsSync(p)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(p, 'utf8')).map((e) => e.line));
}

// 1) A 档覆盖率
const rows = [];
for (const rel of A) {
  const abs = path.join(REPO, rel);
  const { units, covered, uncovered } = analyze(abs);
  const w = waterLines(rel);
  rows.push({ rel, units, covered, cov: units ? (covered / units) * 100 : 100, added: w.added, water: w.lines.length, uncovered: uncovered.length });
}
rows.sort((a, b) => a.cov - b.cov);
console.log('RANK\tcov%\tunits\tcovered\tadded\twater\tfile');
rows.forEach((r) => console.log(`${r.cov.toFixed(1)}\t${r.units}\t${r.covered}\t${r.added}\t${r.water}\t${r.rel}`));
const pass = rows.filter((r) => r.cov >= 90 && r.water === 0).length;
const passW = rows.filter((r) => r.cov >= 90).length;
console.log(`A_FILES=${rows.length} cov>=90%=${passW} cov>=90%&&W=0=${pass} cov>=80%=${rows.filter(r=>r.cov>=80).length} cov<70%=${rows.filter(r=>r.cov<70).length}`);
console.log('LOW10:');
rows.slice(0, 10).forEach((r) => console.log(`  ${r.rel}\tcov=${r.cov.toFixed(1)}%\tunits=${r.units}\tcovered=${r.covered}\tadded=${r.added}\twater=${r.water}`));
console.log('THIN(added<50):');
rows.filter((r) => r.added < 50).forEach((r) => console.log(`  ${r.rel}\tadded=${r.added}\tcov=${r.cov.toFixed(1)}%`));

// 2) W 新旧拆分
function split(rel, batches) {
  const w = waterLines(rel);
  const sets = batches.map(([d, f]) => [d, loadEntries(d, f)]);
  const tally = {};
  for (const [d] of sets) tally[d] = 0;
  let legacy = 0;
  for (const l of w.lines) {
    const hit = sets.find(([, s]) => s.has(l));
    if (hit) tally[hit[0]]++;
    else legacy++;
  }
  console.log(`SPLIT ${rel} added=${w.added} water=${w.lines.length} legacy=${legacy} ` +
    Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' '));
}
split('src/module.c', [
  ['VK-A21a', 'out-module_a.json'], ['VK-A21b', 'out-module_b.json'],
  ['VK-A21c', 'out-module_c.json'], ['VK-A21d', 'out-module_d.json'],
]);
split('src/cluster_legacy.c', [
  ['VK-A19a', 'out-cluster_legacy_a.json'], ['VK-A19b', 'out-cluster_legacy_b.json'],
  ['VK-A19c', 'out-cluster_legacy_c.json'],
]);

// 3) badFiles 归属
const BAD = ['src/module.c','src/server.c','src/cluster_legacy.c','src/db.c','src/hashtable.c','src/bgiteration.c','src/sds.c','src/replication.c','src/tls.c','src/io_threads.c','src/acl.c','src/aof.c','src/forkless.c','src/memory_prefetch.c','src/ae.c','src/object.c','src/rdb.c','src/blocked.c','src/defrag.c','src/multi.c','src/connection.c','src/evict.c','src/expire.c','src/lazyfree.c','src/rio.c'];
const aset = new Set(A);
const inA = BAD.filter((f) => aset.has(f));
const notA = BAD.filter((f) => !aset.has(f));
console.log(`BADFILES=${BAD.length} inA=${inA.length} notA=${notA.length}`);
console.log('  A档: ' + inA.join(', '));
console.log('  非A: ' + notA.join(', '));
