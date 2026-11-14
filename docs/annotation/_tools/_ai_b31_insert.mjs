// B31 insert: generated file data resolver + tool error types
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-text/resolve-generated-file-data.ts',
    want: [11, 11],
    blocks: [
      {
        at: 1,
        expect: "import type { LanguageModelV4Content } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// resolve-generated-file-data：把模型给出的文件数据解析成字节',
          '// 支持内联 data 与远端 url 两种形态，二者由 type 判别。',
          '// 远端下载走统一的 download 工具，可被 abortSignal 取消。',
          '// 缓存按数据对象身份建立弱引用，不阻止对象回收。',
        ],
      },
      {
        at: 9,
        expect: 'export type GeneratedFileDataCache = WeakMap<',
        lines: [
          '// WeakMap 以数据对象本身为键：同一对象只下载一次，',
          '// 数据对象被回收后缓存项自动消失。',
        ],
      },
      {
        at: 14,
        expect: 'export async function resolveGeneratedFileData({',
        lines: [
          '// 返回值保持 string | Uint8Array 联合，不做统一编码；',
          '// 是否再解码由调用方按 MIME 类型决定。',
        ],
      },
      {
        at: 23,
        expect: "if (data.type === 'data') {",
        lines: [
          '// 内联数据直接返回，不复制、不缓存。',
        ],
      },
      {
        at: 27,
        expect: 'const cachedData = cache?.get(data);',
        lines: [
          '// 远端数据先查缓存，避免同一部件在多个 step 重复下载。',
        ],
      },
    ],
  },
  {
    name: 'generate-text/tool-error.ts',
    want: [10, 10],
    blocks: [
      {
        at: 1,
        expect: "import type { JSONObject } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// tool-error：工具执行失败时回填给模型与调用方的错误类型',
          '// 静态错误按 ToolSet 推导 input，动态错误保留 unknown。',
          '// 与 tool-result 结构对称，靠 type=tool-error 与 dynamic 判别。',
          '// error 始终是 unknown，由上层决定如何呈现。',
        ],
      },
      {
        at: 6,
        expect: 'export type StaticToolError<TOOLS extends ToolSet> = ValueOf<{',
        lines: [
          '// input 仍是强类型，便于定位是哪次调用失败；',
          '// providerExecuted 表示错误由供应商侧产生，本地没有执行；',
          '// toolMetadata 不进入模型消息，仅供观测。',
        ],
      },
      {
        at: 21,
        expect: 'export type DynamicToolError = {',
        lines: [
          '// 动态错误只能给出 unknown 输入，dynamic 固定为 true。',
        ],
      },
      {
        at: 34,
        expect: 'export type TypedToolError<TOOLS extends ToolSet> =',
        lines: [
          '// 判别联合，与 TypedToolResult 保持同一套收窄方式。',
        ],
      },
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
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      process.exit(1);
    }
    total += b.lines.length;
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
