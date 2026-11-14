// 统计本轮打透文件新增注释里“只说做什么、没有原因/后果”的比例（启发式）。
import { execFileSync } from 'node:child_process';

const REPO = 'd:\\code\\opensource\\uv';
const SNAP = 'd:\\code\\_annot_baseline\\uv-rework\\pre-s3\\';
const files = {
  resolver: 'crates/uv-resolver/src/resolver/mod.rs',
  dist: 'crates/uv-distribution/src/source/mod.rs',
  py: 'crates/uv-python-discovery/src/lib.rs',
};
const causal = /因为|否则|失败|导致|必须|依赖|保证|避免|防止|若不|一旦|崩溃|泄漏|不可|不能|只能|顺序|不变量|竞态|重复|冲突|回退|兜底|超时|校验|原子|提前|放弃|报错|跳过/;
for (const [k, f] of Object.entries(files)) {
  let out = '';
  try {
    out = execFileSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', SNAP + f.split('/').join('\\'), f], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    out = e.stdout || '';
  }
  const lines = out.split(/\r?\n/).filter((l) => /^\+\s*\/\//.test(l)).map((l) => l.replace(/^\+\s*\/\/\s?/, ''));
  const bad = lines.filter((l) => !causal.test(l));
  console.log(k, 'added=' + lines.length, 'noCausal=' + bad.length, 'ratio=' + ((bad.length / lines.length) * 100).toFixed(1) + '%');
  for (const l of bad.slice(0, 4)) console.log('   - ' + l);
}
