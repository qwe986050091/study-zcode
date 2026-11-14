// B28 insert: ToolLoopAgent + simulate streaming middleware
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'agent/tool-loop-agent.ts',
    want: [59, 59],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// tool-loop-agent：把 generateText / streamText 封装成可复用的智能体',
          '// 每次 step 调用一次模型；若返回工具调用则执行工具并进入下一 step。',
          '// 循环终止于无工具调用的 finishReason、缺少 execute、需要审批或 stopWhen。',
        ],
      },
      {
        at: 34,
        expect: 'export interface ToolLoopAgentCallExtensions {',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 settings 中的回调不得下传给内核，避免两侧重复触发。',
          '// INV-02 stopWhen 缺省为 20 步，调用级配置优先于 settings。',
          '// INV-03 callOptionsSchema 校验失败必须在任何模型调用之前抛出。',
          '// INV-04 onEnd 缺省回落到 onFinish，显式 onEnd 优先。',
          '// 守住位置：INV-01/03 在 prepareCall，INV-02 在 baseCallArgs，INV-04 在构造与解构。',
        ],
      },
      {
        at: 59,
        expect: "readonly version = 'agent-v1';",
        lines: [
          '// 版本号供 Agent 接口与遥测识别实现代数；',
          '// 语义变化时递增，不修改已有字符串。',
        ],
      },
      {
        at: 68,
        expect: 'constructor(',
        lines: [
          '// [事务] 构造时冻结 settings 视图：显式 onEnd 优先，否则由 onFinish 派生。',
          '// 不修改调用方对象，浅拷贝避免外部后续改动影响实例。',
          '// 回调在每次调用时合并，实例本身不持有运行时状态，可被并发复用。',
        ],
      },
      {
        at: 83,
        expect: 'get id(): string | undefined {',
        lines: [
          '// 两个 getter 只暴露只读视图，不复制工具表；',
          '// 外部修改 tools 会影响后续调用，属于调用方责任。',
        ],
      },
      {
        at: 94,
        expect: 'private async prepareCall(options: {',
        lines: [
          '// prepareCall 是唯一的参数汇聚点：generate 与 stream 都先经过这里。',
          '// 返回类型显式 Omit 掉全部回调与 instructions，防止回调泄漏到内核。',
          '// prompt/messages/instructions 被重新组合成 Prompt 形状，其余字段直传。',
          '// runtimeContext 为 undefined 时不写回，保持可选字段语义。',
        ],
      },
      {
        at: 121,
        expect: 'this.settings.callOptionsSchema != null &&',
        lines: [
          '// [失败路径] 只有同时提供 schema 与 options 才校验；',
          '// 未传 options 时保留缺省行为，不强行补空对象；',
          '// 校验失败直接抛出，不会发起任何网络请求。',
        ],
      },
      {
        at: 133,
        expect: 'onStart: _settingsStableOnStart,',
        lines: [
          '// 逐个解构回调并改名成 _ 前缀，只为把它们从剩余对象中剔除；',
          '// 这些变量不会再被使用，作用是让 rest 不含回调。',
          '// 若遗漏任何一个，内核与 agent 两侧都会触发，造成重复上报。',
          '// 稳定名与 experimental_ 名成对出现，兼容旧调用方式。',
          '// onFinish/onEnd 一并剥离，由调用层用 mergeCallbacks 重新注入。',
        ],
      },
      {
        at: 148,
        expect: 'const baseCallArgs = {',
        lines: [
          '// [权衡] stopWhen 缺省 20 步：覆盖常规工具链，又能在死循环时止损；',
          '// ...options 在 stopWhen 之后展开，保证调用级值优先；',
          '// settings 已剔除回调，因此这里展开是安全的。',
        ],
      },
      {
        at: 154,
        expect: 'const preparedCallArgs =',
        lines: [
          '// 用户 prepareCall 可改写任意字段，返回值直接替换基线参数；',
          '// 返回 undefined 时沿用基线，不合并、不做深拷贝。',
          '// 回调已在基线中移除，用户无法通过 prepareCall 重新注入，',
          '// 避免回调在每次调用时被重复包装。',
        ],
      },
      {
        at: 168,
        expect: 'const {',
        lines: [
          '// instructions 与 messages 在 settings 中属于 Prompt 形状，',
          '// 但 Agent 调用参数把它们提升到顶层，这里再拆回来；',
          '// 其余字段进入 callArgs，原样交给内核。',
        ],
      },
      {
        at: 177,
        expect: 'const promptArgs = {',
        lines: [
          '// 显式构造 Prompt，避免把 undefined 字段当作「已提供」；',
          '// 该对象只读使用，不会被内核修改。',
        ],
      },
      {
        at: 184,
        expect: 'if (runtimeContext === undefined) {',
        lines: [
          '// 有 runtimeContext 时才写回，防止覆盖内核的缺省上下文；',
          '// 两条分支都返回新的合并对象，不修改 preparedCall。',
        ],
      },
      {
        at: 203,
        expect: 'private agentHeaders(preparedCall: {',
        lines: [
          '// headers 以用户提供的对象为基底，叠加 agent 标识；',
          '// 下游还会继续追加 ai/<version> 与 provider 后缀，形成链式 UA；',
          '// undefined 值被忽略，不会产生 "undefined" 字符串。',
        ],
      },
      {
        at: 215,
        expect: 'async generate({',
        lines: [
          '// 非流式入口：先整理参数，再合并 settings 与调用级回调；',
          '// generateText 不接受 onError，错误在 catch 中手动上报。',
        ],
      },
      {
        at: 240,
        expect: 'const callbackArgs = {',
        lines: [
          '// 每个回调都用 mergeCallbacks 合并：settings 先、调用级后；',
          '// 稳定名优先于 experimental_ 名，二者同时存在时只取稳定名；',
          '// timeout 允许调用级覆盖，未提供时沿用 prepareCall 的结果。',
        ],
      },
      {
        at: 272,
        expect: 'try {',
        lines: [
          '// [失败路径] abort 与超时不属于业务错误，不上报 onError；',
          '// 其余异常先通知再原样抛出，调用方仍能捕获；',
          '// headers 在这里才注入，覆盖 prepareCall 可能设置的 headers。',
        ],
      },
      {
        at: 292,
        expect: 'async stream({',
        lines: [
          '// 流式入口与非流式共享 prepareCall 与回调合并逻辑；',
          '// 额外透传 experimental_transform 与 onError/onAbort，',
          '// 因为 streamText 支持这两个回调，而 generateText 不支持。',
        ],
      },
      {
        at: 353,
        expect: 'return await stream({',
        lines: [
          '// 流式失败发生在消费阶段，由 streamText 自己触发 onError；',
          '// 这里不再包 try/catch，保持错误在流上传播的语义。',
        ],
      },
    ],
  },
  {
    name: 'middleware/simulate-streaming-middleware.ts',
    want: [23, 23],
    blocks: [
      {
        at: 1,
        expect: "import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// simulate-streaming-middleware：把一次 generate 结果伪造成流式分片',
          '// 输出顺序与真实流一致：start → metadata → 各部件 → finish → close。',
          '// 适用于只支持非流式、但上层按流协议消费的模型。',
        ],
      },
      {
        at: 7,
        expect: 'export function simulateStreamingMiddleware(): LanguageModelMiddleware {',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 首个分片必须是 stream-start，并携带全部 warnings。',
          '// INV-02 文本与推理部件必须成对出现 start/delta/end，id 全局递增。',
          '// 守住位置：INV-01 在 start 开头，INV-02 在 text 与 reasoning 分支。',
        ],
      },
      {
        at: 10,
        expect: 'wrapStream: async ({ doGenerate }) => {',
        lines: [
          '// [权衡] 复用 wrapStream：对上层表现为流式模型，',
          '// 实际只调用一次 doGenerate，因此没有真实的增量延迟；',
          '// 仅替换 stream，request/response 原样透传。',
        ],
      },
      {
        at: 13,
        expect: 'let id = 0;',
        lines: [
          '// id 在整条伪造流内单调递增，文本与推理共用同一计数器，',
          '// 保证不同部件之间不会出现重复 id。',
        ],
      },
      {
        at: 15,
        expect: 'const simulatedStream = new ReadableStream<LanguageModelV4StreamPart>({',
        lines: [
          '// start 中同步推完所有分片，消费方读取时数据已就绪；',
          '// 该路径不使用背压，也不处理取消。',
        ],
      },
      {
        at: 24,
        expect: 'for (const part of result.content) {',
        lines: [
          '// content 顺序即输出顺序，每个部件独立成组，',
          '// 不跨部件合并 delta。',
        ],
      },
      {
        at: 27,
        expect: 'if (part.text.length > 0 || (part.citations?.length ?? 0) > 0) {',
        lines: [
          '// 空文本只有带 citations 时才发出，否则会产生无意义的 delta；',
          '// 该判断同时覆盖纯引用与空字符串两种情况。',
        ],
      },
      {
        at: 51,
        expect: "case 'reasoning': {",
        lines: [
          '// 推理部件不做空值判断，始终发完整三件套；',
          '// providerMetadata 原样透传，供上层还原思维链来源。',
        ],
      },
      {
        at: 73,
        expect: 'controller.enqueue({',
        lines: [
          '// finish 携带 finishReason/usage/providerMetadata 后立即 close；',
          '// 不发送额外结束标记，流终止即完成。',
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
