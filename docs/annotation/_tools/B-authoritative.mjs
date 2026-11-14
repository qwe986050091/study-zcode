import fs from 'node:fs';
import { execSync } from 'node:child_process';
const REPO = 'd:/code/opensource/valkey';
const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/quality-now.json', 'utf8'));
const rows = new Map(q.rows.map((r) => [r.path, r]));
const all = execSync('git ls-files "src"', { cwd: REPO, encoding: 'utf8' })
  .split(/\r?\n/).filter((p) => p.endsWith('.c') && !p.startsWith('src/unit/'));
const A = new Set(`src/resp_parser.c src/connection.c src/socket.c src/anet.c src/unix.c src/syncio.c src/pubsub.c src/tracking.c src/t_stream.c src/ae_epoll.c src/ae_kqueue.c src/ae_select.c src/ae_evport.c src/io_threads.c src/bio.c src/mutexqueue.c src/queues.c src/memory_prefetch.c src/threads_mngr.c src/rio.c src/rdb_transcoder.c src/forkless.c src/childinfo.c src/db.c src/kvstore.c src/lazyfree.c src/defrag.c src/bgiteration.c src/object.c src/sds.c src/cluster.c src/cluster_legacy.c src/cluster_migrateslots.c src/cluster_slot_stats.c src/sentinel.c src/module.c src/scripting_engine.c src/script.c src/eval.c src/modules/lua/script_lua.c src/modules/lua/engine_lua.c src/modules/lua/function_lua.c src/t_hash.c src/t_zset.c src/t_set.c src/t_list.c src/t_string.c`.split(/\s+/));
const C = new Set(`src/commands.c src/serverassert.c src/rand.c src/trace/trace.c src/trace/trace_aof.c src/trace/trace_cluster.c src/trace/trace_commands.c src/trace/trace_db.c src/trace/trace_rdb.c src/trace/trace_server.c`.split(/\s+/));
const CEILING = new Set(['src/siphash.c']); // B23 已登记结构性上限
const B = all.filter((p) => !A.has(p) && !C.has(p));
const info = B.map((p) => {
  const r = rows.get(p) || { units: 0, covered: 0, coverage: 0, branchCoverage: 100 };
  const br = r.branchCoverage == null ? 100 : r.branchCoverage;
  return { path: p, units: r.units, covered: r.covered, rest: r.units - r.covered, cov: r.coverage, br };
});
const done = info.filter((r) => CEILING.has(r.path) || (r.cov >= 60 && r.br >= 70));
const rest = info.filter((r) => !done.includes(r));
const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
const fmt = (n) => n.toLocaleString('en-US');
console.log(`B_TIER=${B.length} units=${sum(info, 'units')}`);
console.log(`DONE=${done.length} files units=${sum(done, 'units')}`);
console.log(`REST=${rest.length} files units=${sum(rest, 'units')} uncovered=${sum(rest, 'rest')}`);
rest.sort((a, b) => b.units - a.units);
const lines = [];
lines.push('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const r of rest) lines.push(`| ${r.path} | ${fmt(r.units)} | ${fmt(r.covered)} | ${fmt(r.rest)} | ${r.cov.toFixed(1)}% | ${r.br.toFixed(1)}% |`);
lines.push(`| **合计（${rest.length} 文件）** | **${fmt(sum(rest, 'units'))}** | **${fmt(sum(rest, 'covered'))}** | **${fmt(sum(rest, 'rest'))}** | - | - |`);
fs.writeFileSync('d:/code/_annot_baseline/B-table.md', lines.join('\n') + '\n');
console.log('written B-table.md');
console.log('ceiling files:', [...CEILING].join(', '));
