// B29 insert: generate-text barrel + agent UI stream adapter
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-text/index.ts',
    want: [33, 33],
    blocks: [
      {
        at: 1,
        expect: "export type { ActiveTools } from './active-tools';",
        lines: [
          '// ============================================================================',
          '// generate-text 公共导出（barrel）',
          '// 所有非流式与流式文本生成相关的类型、函数都从这里统一出口，',
          '// 上层通过 ai 主入口再导出，禁止深层路径依赖。',
          '// 本文件不包含实现，只声明对外契约。',
        ],
      },
      {
        at: 3,
        expect: 'export {',
        lines: [
          '// filterActiveTools 保留稳定导出，experimental_ 别名仅为兼容旧代码；',
          '// 两者指向同一实现，新增代码应使用稳定名。',
        ],
      },
      {
        at: 11,
        expect: "export { generateText, type GenerateTextInclude } from './generate-text';",
        lines: [
          '// 非流式生成主入口；Include 控制结果中包含哪些可选产物。',
          '// 类型与函数同源导出，避免调用方从实现文件直接引入。',
        ],
      },
      {
        at: 12,
        expect: 'export type {',
        lines: [
          '// 事件类型覆盖 start / step / error / abort / end 全生命周期；',
          '// 回调与事件一一对应，命名以 On*Callback 与 *Event 成对。',
        ],
      },
      {
        at: 32,
        expect: "export type { GenerateTextResult } from './generate-text-result';",
        lines: [
          '// 非流式结果类型，包含 steps、toolCalls、usage 等聚合产物；',
          '// 结果类型不导出实现，保证内核可重构。',
        ],
      },
      {
        at: 45,
        expect: "export * as Output from './output';",
        lines: [
          '// Output 以命名空间导出：Output.object() / Output.text() 等构造器；',
          '// 同时以类型别名导出一份纯类型，避免值命名空间被误当类型使用；',
          '// 两种导出来自同一文件，语义保持一致。',
        ],
      },
      {
        at: 54,
        expect: "export { smoothStream, type ChunkDetector } from './smooth-stream';",
        lines: [
          '// 平滑流：把过快的增量按节奏重排，仅影响呈现层时序；',
          '// 不改变分片内容与最终拼接结果。',
        ],
      },
      {
        at: 66,
        expect: 'export {',
        lines: [
          '// 停止条件在导出层同时给出函数与类型；',
          '// stepCountIs 为旧名别名，内部直接指向 isStepCount。',
        ],
      },
      {
        at: 77,
        expect: 'export {',
        lines: [
          '// 实验性能力统一加 experimental_ 前缀，便于后续重命名；',
          '// streamLanguageModelCall 暴露单次模型调用的原始分片流；',
          '// 旧类型别名保留到 v8，注释里已标注移除版本。',
        ],
      },
      {
        at: 86,
        expect: 'export {',
        lines: [
          '// 流式生成主入口；lowMemory 变体以额外内存为代价换取更小的常驻占用；',
          '// 两者共享同一份 StreamTextResult 契约。',
        ],
      },
      {
        at: 98,
        expect: 'export type {',
        lines: [
          '// 流式结果、文本分片与 UI 流选项三组类型；',
          '// TextStreamPart 是消费方最常判别的联合类型。',
        ],
      },
      {
        at: 103,
        expect: 'export type {',
        lines: [
          '// 工具审批配置：函数式与配置式两种写法；',
          '// 状态类型描述一次审批在生命周期中的取值。',
        ],
      },
      {
        at: 110,
        expect: "export { detectToolDrift, fingerprintTools } from './tool-fingerprint';",
        lines: [
          '// 工具指纹用于检测跨 step 的工具漂移；',
          '// 两个函数必须成对使用，指纹算法变更属于破坏性改动。',
        ],
      },
      {
        at: 138,
        expect: 'export type {',
        lines: [
          '// 工具结果与错误按静态/动态分为两类；',
          '// 判别字段决定调用方能否拿到强类型 output。',
        ],
      },
    ],
  },
  {
    name: 'agent/create-agent-ui-stream.ts',
    want: [5, 5],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// create-agent-ui-stream：把 Agent 的流式输出转换为 UI 消息流',
          '// 依次完成消息校验、模型消息转换、调用 agent.stream、协议转换四步。',
        ],
      },
      {
        at: 71,
        expect: 'export async function createAgentUIStream<',
        lines: [
          '// 只有 ToolLoopAgent 能消费 steering，其它实现会静默丢弃消息，故显式拒绝；',
          '// 校验与转换都在流创建之前完成，失败时不会产生半开的流。',
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
