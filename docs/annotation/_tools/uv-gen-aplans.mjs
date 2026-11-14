// 生成 A 类总述 + B 类抽样可写项的计划文件（锚点 + cursor 相对 occurrence）。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'd:/code/opensource/uv';
const outDir = 'd:/code/_annot_baseline/uv-rework/aplans';
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ['crates/uv-netrc/src/netrc.rs', 589, '// 测试夹具：密码用双引号包裹、内部再转义一对引号，验证 tokenizer 只在最外层引号处截断。'],
  ['crates/uv-netrc/src/netrc.rs', 805, '// 测试夹具：注释行放在第二条 machine 之后，验证末尾注释不会吞掉下一条凭据。'],
  ['crates/uv-netrc/src/netrc.rs', 823, '// 测试夹具：#comment 紧贴第二条 machine 之后，验证行尾注释仍被整行丢弃。'],
  ['crates/uv-netrc/src/netrc.rs', 841, '// 测试夹具：单独一个 # 放在末尾，验证它不改变前面两条凭据的归属。'],
  ['crates/uv-pep440/src/version.rs', 3339, '// 错误文案：给出上限数值与超限位置，{string:?} 保留原始片段便于定位。'],
  ['crates/uv-pep440/src/version.rs', 3377, '// 错误文案：同时回显已解析前缀与剩余片段，二者拼起来就是原始输入。'],
  ['crates/uv-python-discovery/src/project.rs', 409, '// 提示文案：~= 缺 patch 时给出被解释成的区间与建议写法，{spec_0} 是补零后的对照。'],
  ['crates/uv-workspace/src/pyproject.rs', 635, '// 文档示例：dev-dependencies 的旧式写法，值是 PEP 508 需求列表。'],
  ['crates/uv-workspace/src/pyproject.rs', 743, '// 文档示例：constraint-dependencies 只给传递依赖封版本上界，不单独引入包。'],
  ['crates/uv-workspace/src/pyproject.rs', 798, '// 文档示例：environments 用环境标记把解析范围限定在 macOS。'],
  ['crates/uv-workspace/src/pyproject.rs', 835, '// 文档示例：required-environments 要求无 sdist 的包提供对应平台的 wheel。'],
  ['crates/uv-workspace/src/pyproject.rs', 903, '// 文档示例：conflicts 每项是一组互斥的 extra/group，按 fork 分开求解。'],
  ['crates/uv-distribution-types/src/index.rs', 875, '// 未显式配置时落到 Auto：先匿名请求，401 后再查凭据；默认值语义见 AuthPolicy 的 #[default]。'],
];

const byFile = new Map();
for (const [f, line, text] of targets) {
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f).push({ line, text });
}

for (const [f, list] of byFile) {
  list.sort((a, b) => a.line - b.line);
  const lines = fs.readFileSync(path.join(repo, f), 'utf8').replace(/\r\n/g, '\n').split('\n');
  let prevIdx = -1;
  const edits = [];
  for (const t of list) {
    const anchor = lines[t.line - 1].trim();
    if (!anchor) throw new Error(`empty anchor ${f}:${t.line}`);
    const cur = t.line - 1;
    let n = 0;
    for (let k = Math.max(0, prevIdx); k < cur; k++) if (lines[k].trim() === anchor) n++;
    edits.push({ anchor, occurrence: n + 1, comments: [t.text] });
    prevIdx = cur;
  }
  const name = f.split('/').slice(-2).join('-').replace('.rs', '') + '.json';
  fs.writeFileSync(path.join(outDir, name), JSON.stringify({ file: f, edits }, null, 1), 'utf8');
  console.log(`wrote ${name} edits=${edits.length}`);
}
