// 改写校验工具的负向自测：确认三条断言分别能拦住违规改动，且还原后恢复 PASS。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = 'D:/code/ZCode/packages/ui/src/lib/chatPrepareError.ts';
const original = fs.readFileSync(file, 'utf8');

function run(label) {
  const r = spawnSync('node', ['zc-verify.mjs', '--rewrite', 'ZC-fix-b1'], {
    cwd: 'D:/code/_annot_baseline',
    encoding: 'utf8',
  });
  const summary = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('SUMMARY')) ?? '<no summary>';
  const firstErr = (r.stderr || '').split(/\r?\n/).filter(Boolean)[0] ?? '';
  console.log(`${label}: exit=${r.status}`);
  console.log(`  ${summary}`);
  if (firstErr) console.log(`  first-error: ${firstErr}`);
}

// 负例 1：改动代码 → codeTokenDiff 必须非 0
fs.writeFileSync(file, original + 'const __neg = 1;\n', 'utf8');
run('NEG code-change');

// 负例 2：删上游注释（HEAD 里已存在的那行）→ upstreamCommentDeleted 必须非 0
const upstream = original
  .split('\n')
  .find((l) => l.includes('部分错误对象会带循环引用'));
if (!upstream) {
  console.error('NEG setup failed: upstream comment not found');
  process.exit(1);
}
fs.writeFileSync(file, original.replace(upstream + '\n', ''), 'utf8');
run('NEG upstream-comment');

// 还原后必须回到 PASS
fs.writeFileSync(file, original, 'utf8');
run('RESTORED');
