import fs from 'node:fs';
const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/quality-now.json', 'utf8'));
const ex = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/weak-exemptions.json', 'utf8'));
const rows = new Map(q.rows.map((r) => [r.path, r]));
const A = new Set(`src/resp_parser.c src/connection.c src/socket.c src/anet.c src/unix.c src/syncio.c src/pubsub.c src/tracking.c src/t_stream.c src/ae_epoll.c src/ae_kqueue.c src/ae_select.c src/ae_evport.c src/io_threads.c src/bio.c src/mutexqueue.c src/queues.c src/memory_prefetch.c src/threads_mngr.c src/rio.c src/rdb_transcoder.c src/forkless.c src/childinfo.c src/db.c src/kvstore.c src/lazyfree.c src/defrag.c src/bgiteration.c src/object.c src/sds.c src/cluster.c src/cluster_legacy.c src/cluster_migrateslots.c src/cluster_slot_stats.c src/sentinel.c src/module.c src/scripting_engine.c src/script.c src/eval.c src/modules/lua/script_lua.c src/modules/lua/engine_lua.c src/modules/lua/function_lua.c src/t_hash.c src/t_zset.c src/t_set.c src/t_list.c src/t_string.c`.split(/\s+/));
const C = new Set(`src/commands.c src/serverassert.c src/rand.c src/trace/trace.c src/trace/trace_aof.c src/trace/trace_cluster.c src/trace/trace_commands.c src/trace/trace_db.c src/trace/trace_rdb.c src/trace/trace_server.c`.split(/\s+/));
const CEILING = new Set(['src/siphash.c']);
const { execSync } = await import('node:child_process');
const all = execSync('git ls-files "src"', { cwd: 'd:/code/opensource/valkey', encoding: 'utf8' })
  .split(/\r?\n/).filter((p) => p.endsWith('.c') && !p.startsWith('src/unit/'));
const B = all.filter((p) => !A.has(p) && !C.has(p));
const info = B.map((p) => {
  const r = rows.get(p) || { units: 0, covered: 0, coverage: 0, branchCoverage: 100 };
  return { path: p, units: r.units, covered: r.covered, rest: r.units - r.covered, cov: r.coverage, br: r.branchCoverage == null ? 100 : r.branchCoverage };
});
const done = info.filter((r) => CEILING.has(r.path) || (r.cov >= 60 && r.br >= 70));
const rest = info.filter((r) => !done.includes(r));
const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
const fmt = (n) => n.toLocaleString('en-US');
console.log(`文件进度  ${done.length}/${B.length}  (${(done.length / B.length * 100).toFixed(1)}%)`);
console.log(`单元进度  ${fmt(sum(done, 'units'))}/${fmt(sum(info, 'units'))}  (${(sum(done, 'units') / sum(info, 'units') * 100).toFixed(1)}%)  uncovered=${fmt(sum(rest, 'rest'))}`);
console.log('剩余最大 5 文件：');
for (const r of [...rest].sort((a, b) => b.rest - a.rest).slice(0, 5)) console.log(`  ${r.path}  剩余 ${fmt(r.rest)} / ${fmt(r.units)}  语句 ${r.cov.toFixed(1)}%  分支 ${r.br.toFixed(1)}%`);
console.log(`weak 拆分  自有 ${ex.ownWeak}（新增注释 ${fmt(ex.addedCommentLines)} 行，率 ${ex.ownWeakRate.toFixed(2)}%） / 上游原有 ${ex.upstreamWeak}（已豁免）`);
