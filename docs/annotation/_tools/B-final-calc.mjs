import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/VK-R6/repo-quality-now.json', 'utf8'));
const byBase = new Map();
for (const r of j.rows) {
  const b = r.path.split('/').pop();
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(r);
}
const md = fs.readFileSync('d:/code/opensource/valkey/docs/annotation/README-rework.md', 'utf8');
const sec = md.split('## 3.')[1].split('## 4.')[0];
const names = [...new Set([...sec.matchAll(/`([A-Za-z0-9_./-]+\.c)`/g)].map((m) => m[1]))];
const s3 = [];
const unresolved = [];
for (const n of names) {
  let r = j.rows.find((x) => x.path === (n.startsWith('src/') ? n : 'src/' + n));
  if (!r) {
    const cands = byBase.get(n.split('/').pop()) || [];
    r = cands.find((x) => x.path.startsWith('src/modules/')) || cands[0];
  }
  if (r) s3.push({ name: n, ...r }); else unresolved.push(n);
}
console.log('§3 .c=' + names.length + ' resolved=' + s3.length + ' units=' + s3.reduce((s, r) => s + r.units, 0));
if (unresolved.length) console.log('unresolved: ' + unresolved.join(', '));
const done = new Set(`entry.c sort.c ordered_index.c call_reply.c geo.c bitops.c listpack.c ziplist.c adlist.c hyperloglog.c quicklist.c intset.c util.c vset.c t_path_hash.c hellohook.c lzf_d.c setcpuaffinity.c siphash.c geohash.c valkey-benchmark-dataset.c lzf_c.c memtest.c sha256.c release.c pqsort.c compression.c`.split(/\s+/));
const doneRows = s3.filter((r) => done.has(r.path.split('/').pop()));
const rest = s3.filter((r) => !done.has(r.path.split('/').pop()));
console.log('§3 DONE files=' + doneRows.length + ' units=' + doneRows.reduce((s, r) => s + r.units, 0));
console.log('§3 REMAIN files=' + rest.length + ' units=' + rest.reduce((s, r) => s + r.units, 0));
rest.sort((a, b) => b.units - a.units);
console.log('--- §3 remaining top20 ---');
rest.slice(0, 20).forEach((r, i) => console.log(`${i + 1}\t${r.path}\t${r.units}\t${r.coverage.toFixed(1)}%\t${r.branchCoverage.toFixed(1)}%`));
const big = rest.filter((r) => r.units >= 500);
console.log('§3 remain >=500: ' + big.length + ' files / ' + big.reduce((s, r) => s + r.units, 0) + ' units :: ' + big.map((r) => r.path).join(', '));
const queue = fs.readFileSync('d:/code/_annot_baseline/B-remaining.txt', 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
  const [p, cov, br, u] = l.split('\t'); return { p, cov: +cov, br, u: +u };
});
const qdone = new Set(`src/commands.c src/rand.c src/serverassert.c src/trace/trace.c src/lzf_d.c src/setcpuaffinity.c src/siphash.c src/geohash.c src/valkey-benchmark-dataset.c src/lzf_c.c src/memtest.c src/modules/hellohook.c src/sha256.c src/release.c src/pqsort.c src/compression.c`.split(/\s+/));
const qr = queue.filter((r) => !qdone.has(r.p));
console.log('queue remain files=' + qr.length + ' units=' + qr.reduce((s, r) => s + r.u, 0));
const s3doneBase = new Set(doneRows.map((r) => r.path.split('/').pop()));
const qrNotS3 = qr.filter((r) => !s3doneBase.has(r.p.split('/').pop()) && !rest.some((x) => x.path === r.p));
console.log('queue-remain not in §3-remain: ' + qrNotS3.map((r) => r.p).join(', '));
const qNotInS3Any = queue.filter((r) => !s3.some((x) => x.path === r.p));
console.log('queue(all) not in §3: ' + qNotInS3Any.map((r) => r.p).join(', '));
