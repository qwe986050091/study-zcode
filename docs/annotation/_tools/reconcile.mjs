import fs from 'node:fs';
import { execSync } from 'node:child_process';
const REPO = 'd:/code/opensource/valkey';
const BASE = 'c96bdec';
const A = new Set(`src/resp_parser.c src/connection.c src/socket.c src/anet.c src/unix.c src/syncio.c src/pubsub.c src/tracking.c src/t_stream.c src/ae_epoll.c src/ae_kqueue.c src/ae_select.c src/ae_evport.c src/io_threads.c src/bio.c src/mutexqueue.c src/queues.c src/memory_prefetch.c src/threads_mngr.c src/rio.c src/rdb_transcoder.c src/forkless.c src/childinfo.c src/db.c src/kvstore.c src/lazyfree.c src/defrag.c src/bgiteration.c src/object.c src/sds.c src/cluster.c src/cluster_legacy.c src/cluster_migrateslots.c src/cluster_slot_stats.c src/sentinel.c src/module.c src/scripting_engine.c src/script.c src/eval.c src/modules/lua/script_lua.c src/modules/lua/engine_lua.c src/modules/lua/function_lua.c src/t_hash.c src/t_zset.c src/t_set.c src/t_list.c src/t_string.c`.split(/\s+/));
const C = new Set(`src/commands.c src/serverassert.c src/rand.c src/trace/trace.c src/trace/trace_aof.c src/trace/trace_cluster.c src/trace/trace_commands.c src/trace/trace_db.c src/trace/trace_rdb.c src/trace/trace_server.c`.split(/\s+/));
const all = execSync('git ls-files "src"', { cwd: REPO, encoding: 'utf8' }).split(/\r?\n/).filter((p) => p.endsWith('.c') && !p.startsWith('src/unit/'));
const B = all.filter((p) => !A.has(p) && !C.has(p));
export const sets = { A, C, B: new Set(B), all };
function classify(rev) {
  const files = execSync(`git diff --name-only ${BASE} ${rev}`, { cwd: REPO, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const srcC = files.filter((p) => p.endsWith('.c') && p.startsWith('src/') && !p.startsWith('src/unit/'));
  const other = files.filter((p) => !srcC.includes(p));
  const a = srcC.filter((p) => A.has(p));
  const c = srcC.filter((p) => C.has(p));
  const b = srcC.filter((p) => !A.has(p) && !C.has(p));
  return { rev, files: files.length, srcC: srcC.length, a: a.length, c: c.length, b: b.length, other: other.length, otherList: other };
}
const now = classify('HEAD');
const then = classify('28600a4');
console.log('total .c (excl unit) =', all.length, '| A =', A.size, '| C =', C.size, '| B =', B.length);
for (const r of [then, now]) console.log(JSON.stringify({ rev: r.rev, files: r.files, srcC: r.srcC, A: r.a, C: r.c, B: r.b, other: r.other }));
console.log('other@HEAD:', now.otherList.join(', '));
