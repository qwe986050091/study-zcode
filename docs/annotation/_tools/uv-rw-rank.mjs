// 关键文件候选排名：风险域命中数 × 低覆盖度 × 规模。
// 输入：deep-quality --diff 的 JSON（rows 里有全文件覆盖度）+ 文件内容里的风险词频。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'd:\\code\\opensource\\uv';
const SRC = 'd:\\code\\_annot_baseline\\uv-rw-s1-after-diff.json';
const OUT = 'd:\\code\\_annot_baseline\\uv-rw-key-candidates.json';

const RISK = {
  concurrency: /\b(unsafe|Atomic[A-Za-z]*|Mutex|RwLock|thread::|spawn|Send|Sync|tokio::sync|OnceLock|LazyLock|Ordering::)\b/g,
  persistence: /\b(fsync|sync_all|sync_data|rename|persist|NamedTempFile|TempDir|flush|File::create|OpenOptions|remove_file|hard_link)\b/g,
  protocol: /\b(retry|Retry|StatusCode|handshake|Idempotent|idempotent|Content-Type|Accept-Encoding|ETag|If-None-Match|Range)\b/g,
  resource: /\b(Drop|drop\(|TempDir|tempfile|BufReader|BufWriter|File|Read|Write|close|shutdown)\b/g,
  security: /\b(auth|Auth|credential|Credential|secret|Secret|sanitize|validate|validate_|strip_prefix|canonicalize|permission|Permissions|trust|Trust)\b/g,
  algorithm: /\b(pubgrub|BTree|HashMap|BTreeMap|HashSet|Version|VersionSpecifier|compare|Ord|cmp|binary_search|sort_by)\b/g,
  serialization: /\b(serde|Serialize|Deserialize|deserialize|serialize|from_str|from_slice|to_string|toml|json|MessagePack)\b/g,
  invariants: /\b(invariant|invariant_|INV-|assert!|debug_assert!|unreachable!|expect\(|unwrap\()/g,
};

const rows = JSON.parse(fs.readFileSync(SRC, 'utf8')).rows;
const out = [];
for (const r of rows) {
  if (r.units < 40) continue; // 太小、风险面有限
  const abs = path.join(REPO, r.path.split('/').join(path.sep));
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const hits = {};
  let total = 0;
  for (const [k, re] of Object.entries(RISK)) {
    re.lastIndex = 0;
    const n = (text.match(re) || []).length;
    hits[k] = n;
    // 并发/持久化/协议/安全/序列化权重更高
    const w = ['concurrency', 'persistence', 'protocol', 'security', 'serialization'].includes(k) ? 2 : 1;
    total += n * w;
  }
  const cov = r.coverage ?? 0;
  const branch = r.branchCoverage ?? 0;
  // 风险密度（每百个代码单元） × 覆盖缺口
  const riskPer100 = (total / Math.max(1, r.units)) * 100;
  const gap = Math.max(0, 65 - cov) / 65;
  const score = riskPer100 * (0.35 + gap) * Math.log10(1 + r.units);
  out.push({ ...r, hits, riskTotal: total, riskPer100: Number(riskPer100.toFixed(2)), score: Number(score.toFixed(2)) });
}
out.sort((a, b) => b.score - a.score);
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
for (const r of out.slice(0, 60)) {
  const top = Object.entries(r.hits).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`${String(r.score).padStart(6)} cov=${String(r.coverage).padStart(5)} br=${String(r.branchCoverage).padStart(5)} u=${String(r.units).padStart(5)} ${r.path}  ${top}`);
}
console.log('total candidates=' + out.length);
