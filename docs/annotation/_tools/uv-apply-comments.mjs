// 按锚点批量插入 `//` 注释行（只增行，绝不改代码）。
// 用法：node uv-apply-comments.mjs <plan.json> [--dry]
// plan.json: { "file": "crates/.../x.rs", "edits": [ { "anchor": "let foo = ...", "comments": ["说明一", "说明二"], "occurrence": 1 } ] }
//   anchor     ：目标代码行的 trim 后内容（必须逐字一致）
//   comments   ：插入到该行上方的注释文本；自动加缩进与 `// ` 前缀
//   occurrence ：同一 anchor 的第几次命中（默认 1），按文件顺序从上次位置继续查找
// 约束：注释文本不得包含 `*/`；文件必须已存在；只做插入。
import fs from 'node:fs';
import path from 'node:path';
import { linesInsideStrings } from './uv-string-spans.mjs';

const [planPath, ...flags] = process.argv.slice(2);
if (!planPath) {
  console.error('usage: node uv-apply-comments.mjs <plan.json> [--dry]');
  process.exit(2);
}
const dry = flags.includes('--dry');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, ''));
const file = path.isAbsolute(plan.file) ? plan.file : path.join('d:\\code\\opensource\\uv', plan.file.split('/').join(path.sep));
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);
const isLineComment = (l) => /^\s*\/\//.test(l);

let cursor = 0;
let inserted = 0;
let shift = 0;
const errors = [];
// 行首是否落在字符串字面量内部：命中则拒绝插入（raw string / indoc! / 多行字符串）
const insideString = linesInsideStrings(raw.replace(/\r\n/g, '\n'));
for (const [i, edit] of plan.edits.entries()) {
  const anchor = String(edit.anchor ?? '').trim();
  const want = Math.max(1, Number(edit.occurrence || 1));
  const comments = edit.comments || [];
  if (!anchor) {
    errors.push(`#${i} anchor 为空`);
    continue;
  }
  if (!comments.length) {
    errors.push(`#${i} comments 为空（${anchor.slice(0, 40)}）`);
    continue;
  }
  if (comments.some((c) => String(c).includes('*/'))) {
    errors.push(`#${i} 注释含 */（${anchor.slice(0, 40)}）`);
    continue;
  }
  let seen = 0;
  let at = -1;
  for (let j = cursor; j < lines.length; j++) {
    if (lines[j].trim() === anchor) {
      seen++;
      if (seen === want) {
        at = j;
        break;
      }
    }
  }
  if (at < 0) {
    errors.push(`#${i} 找不到 anchor（occurrence=${want}）：${anchor.slice(0, 60)}`);
    continue;
  }
  // 插入点绝不能落在字符串字面量内部：注释对编译器合法，却会改掉运行时数据或测试期望值
  const origLine = at - shift;
  if (insideString[origLine]) {
    errors.push(`#${i} 锚点位于字符串字面量内部，拒绝插入：${anchor.slice(0, 60)}`);
    continue;
  }
  // 锚点上方已有注释块时拒绝重复插入（避免同一位置堆两层）
  let k = at - 1;
  while (k >= 0 && lines[k].trim() === '') k--;
  if (k >= 0 && isLineComment(lines[k])) {
    errors.push(`#${i} 锚点上方已有注释，拒绝叠加：${anchor.slice(0, 60)}`);
    continue;
  }
  const indent = (lines[at].match(/^\s*/) || [''])[0];
  const block = comments.map((c) => {
    const t = String(c).trim();
    return indent + (t.startsWith('//') ? t : '// ' + t);
  });
  lines.splice(at, 0, ...block);
  cursor = at + block.length;
  shift += block.length;
  inserted += block.length;
}

if (!dry && inserted > 0) fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log(`APPLY file=${path.relative('d:\\code\\opensource\\uv', file)} inserted=${inserted} edits=${plan.edits.length} errors=${errors.length}${dry ? ' (dry)' : ''}`);
for (const e of errors) console.log('  ! ' + e);
process.exit(errors.length ? 1 : 0);
