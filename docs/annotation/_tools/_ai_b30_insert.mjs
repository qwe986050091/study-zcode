// B30 insert: tool result + content part types
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-text/tool-result.ts',
    want: [13, 13],
    blocks: [
      {
        at: 1,
        expect: "import type { JSONObject } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// tool-result：工具执行成功后回填给模型的结果类型',
          '// 静态结果按 ToolSet 推导 input/output，动态结果保留 unknown。',
          '// 两者共享 type=tool-result，靠 dynamic 字段判别。',
          '// 本文件只有类型，无运行时逻辑。',
        ],
      },
      {
        at: 10,
        expect: 'export type StaticToolResult<TOOLS extends ToolSet> = ValueOf<{',
        lines: [
          '// 每个键都映射为独立的结果类型，input/output 直接从工具定义推导；',
          '// providerExecuted 表示结果由供应商侧直接给出，本地未执行；',
          '// preliminary 标记流式过程中的中间结果，最终结果会再发一次；',
          '// toolMetadata 不进入模型消息，仅供调用方观察。',
        ],
      },
      {
        at: 26,
        expect: 'export type DynamicToolResult = {',
        lines: [
          '// 动态结果不知道具体 schema，input/output 只能是 unknown；',
          '// dynamic 固定为 true，使判别联合可以收窄。',
        ],
      },
      {
        at: 40,
        expect: 'export type TypedToolResult<TOOLS extends ToolSet> =',
        lines: [
          '// 判别联合：dynamic 为 true 时收窄到动态结果，否则为静态结果；',
          '// 调用方应先判断 dynamic 再读取 output。',
        ],
      },
    ],
  },
  {
    name: 'generate-text/content-part.ts',
    want: [12, 12],
    blocks: [
      {
        at: 1,
        expect: "import type { ToolSet } from '@ai-sdk/provider-utils';",
        lines: [
          '// ============================================================================',
          '// content-part：一次生成产出的内容部件联合类型',
          '// 文本、推理、来源、文件、工具调用/结果/错误、审批请求/响应都在这里汇总。',
          '// 每个分支自带 type 判别字段（custom 使用 kind），消费方按需要收窄。',
          '// 该类型只描述内核输出，不涉及 UI 消息协议。',
        ],
      },
      {
        at: 13,
        expect: 'export type ContentPart<TOOLS extends ToolSet> =',
        lines: [
          '// text 是唯一必带 citations 的部件，引用与文本一起产生；',
          '// custom 用 kind 的 provider.name 形式表达供应商自定义内容；',
          '// 其余分支复用各自的类型定义，避免字段重复声明；',
          '// 所有分支都允许 providerMetadata 透传原始元数据。',
        ],
      },
      {
        at: 21,
        expect: "type: 'custom';",
        lines: [
          '// custom 的 kind 必须包含点号，便于区分供应商与子类型。',
        ],
      },
      {
        at: 27,
        expect: "| ({ type: 'source' } & Source)",
        lines: [
          '// source 由语言模型来源类型展开，type 固定为 source。',
        ],
      },
      {
        at: 29,
        expect: "| ({ type: 'tool-call' } & TypedToolCall<TOOLS> & {",
        lines: [
          '// 工具三态（call/result/error）与审批两态在这里平整汇总。',
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
