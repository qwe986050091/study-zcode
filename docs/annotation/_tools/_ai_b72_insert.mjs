// B72 insert: prompt/split-data-url.ts + registry/index.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/split-data-url.ts',
    want: [5, 5],
    blocks: [
      { at: 1, expect: 'export function splitDataUrl(dataUrl: string): {', lines: [
        '// 把 data URL 拆成 mediaType 与 base64 负载。',
        '// 解析失败时两个字段均为 undefined，交由调用方报错。',
      ] },
      { at: 5, expect: 'try {', lines: [
        '// 用第一个逗号分隔头部与负载。',
      ] },
      { at: 6, expect: "const [header, base64Content] = dataUrl.split(',');", lines: [
        '// 头部形如 data:image/png;base64，取分号前的 MIME。',
      ] },
      { at: 11, expect: '} catch {', lines: [
        '// 任何解析异常都退化为空结果。',
      ] },
    ],
  },
  {
    name: 'registry/index.ts',
    want: [4, 4],
    blocks: [
      { at: 4, expect: "export { customProvider } from './custom-provider';", lines: [
        '// 注册表模块公共出口：自定义 provider 与注册表工厂。',
      ] },
      { at: 14, expect: '/** @deprecated Use `Experimental_DecisionProviderRegistry` instead. */', lines: [
        '// 以下为弃用类型别名，保留以兼容旧代码。',
        '// 旧名称映射到决策注册表，行为完全一致。',
      ] },
      { at: 15, expect: 'export type Experimental_EvaluationProviderRegistry<', lines: [
        '// 泛型参数与决策注册表相同。',
      ] },
    ],
  },
];

let grand = 0;
for (const f of files) {
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  let bad = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      bad++;
    }
    total += b.lines.length;
  }
  if (bad) process.exit(1);
  if (process.env.DRY) {
    console.log('DRY', f.name, total);
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`COUNT ${f.name}=${total} want ${f.want[0]}..${f.want[1]}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  console.log('ADDED', f.name, total);
  grand += total;
}
console.log('TOTAL', grand);
