// B20 insert: realtime setup/frame/index/types + provider v4 adapters
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'realtime/validate-realtime-setup.ts',
    want: [11, 12],
    blocks: [
      {
        at: 1,
        expect: "import { z } from '../util/zod';",
        lines: [
          '// ============================================================================',
          '// validateRealtimeSetup：一次性 token 端点响应的运行期校验（zod）',
          '// 对应 realtime-session 的 token 分支；校验失败即抛错，不进入建连流程。',
          '// ============================================================================',
        ],
      },
      {
        at: 4,
        expect: 'const setupSchema = z.object({',
        lines: [
          '// 只校验安全关键字段，额外字段原样保留。',
        ],
      },
      {
        at: 5,
        expect: 'token: z.string().refine(value => value.trim().length > 0),',
        lines: [
          '// [失败路径] 纯空白 token 视为无效，避免把空凭证交给 WebSocket。',
        ],
      },
      {
        at: 6,
        expect: 'url: z.string().refine(value => {',
        lines: [
          '// URL 校验与传输层一致：必须是 ws/wss 且 host 非空；',
          '// 这里用 try-catch 包住 new URL，畸形串直接判假。',
        ],
      },
      {
        at: 18,
        expect: 'tools: z',
        lines: [
          '// tools 是服务端对工具能力的最终裁定，结构必须与本地定义同形：',
          '// type 固定 function，parameters 为任意 JSON 对象。',
        ],
      },
      {
        at: 30,
        expect: 'export function validateRealtimeSetup(payload: unknown): RealtimeSetupResponse {',
        lines: [
          '// [失败路径] 统一错误文案，不把 zod 的路径细节暴露给调用方。',
        ],
      },
    ],
  },
  {
    name: 'realtime/encode-realtime-frame.ts',
    want: [8, 9],
    blocks: [
      {
        at: 1,
        expect: '/** Private Live continuous wire budgets; legacy transports do not enforce them. */',
        lines: [
          '// ============================================================================',
          '// encode-realtime-frame：连续 PCM 中继的帧编码与字节预算',
          '// 只被 LiveWebSocket 使用；老式传输不执行这些预算，故不在此收口。',
          '// ============================================================================',
        ],
      },
      {
        at: 2,
        expect: 'export const REALTIME_MAX_FRAME_BYTES = 128 * 1024;',
        lines: [
          '// [资源] 单帧与累计缓冲都限制 128 KiB，二者共同防止慢消费者拖爆内存。',
        ],
      },
      {
        at: 11,
        expect: 'export function encodeRealtimeFrame(value: unknown): EncodedRealtimeFrame {',
        lines: [
          '// 编码一次并返回精确字节数：二进制直接透传，字符串按 UTF-8 计长。',
          '// 避免先 JSON.stringify 再重复计算长度。',
        ],
      },
      {
        at: 20,
        expect: "const data = typeof value === 'string' ? value : JSON.stringify(value);",
        lines: [
          '// [失败路径] JSON.stringify 对 undefined/函数返回 undefined，必须显式报错。',
        ],
      },
      {
        at: 26,
        expect: 'export function assertRealtimeFrameBudget(',
        lines: [
          '// [资源] 两道检查：单帧上限与「已缓冲 + 新帧」上限；任一超限即拒绝。',
        ],
      },
    ],
  },
  {
    name: 'realtime/index.ts',
    want: [8, 9],
    blocks: [
      {
        at: 1,
        expect: 'export {',
        lines: [
          '// ============================================================================',
          '// realtime 子包公共出口：全部带 experimental_ 前缀，表示 API 可能变动。',
          '// 这里只做重命名导出，具体语义见各实现文件。',
          '// 之所以统一加前缀，是为了让未稳定的实时协议可以小幅演进而不破坏语义化版本。',
          '// ============================================================================',
        ],
      },
      {
        at: 6,
        expect: "export { getRealtimeToolDefinitions as experimental_getRealtimeToolDefinitions } from './get-realtime-tool-definitions';",
        lines: [
          '// 工具定义转换与抽象会话类是本包的两个主要入口。',
        ],
      },
      {
        at: 14,
        expect: "export type { RealtimeSetupResponse as Experimental_RealtimeSetupResponse } from './realtime-types';",
        lines: [
          '// token 端点响应类型单独从 realtime-types 导出，避免与协议类型混在一起。',
          '// 该类型只描述换取结果，不参与运行时状态。',
        ],
      },
    ],
  },
  {
    name: 'types/realtime-model.ts',
    want: [7, 8],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// 实时协议类型别名层：把 provider 包的 V4 类型统一改名为不带版本号的对外名。',
          '// 只做类型转发，不引入运行时代码。',
          '// ============================================================================',
        ],
      },
      {
        at: 15,
        expect: 'export type RealtimeFactory = RealtimeFactoryV4;',
        lines: [
          '// 工厂负责按 provider 配置创建模型或换取 token，',
          '// 是浏览器侧无需暴露 API key 的关键抽象。',
        ],
      },
      {
        at: 21,
        expect: 'export type RealtimeModel = RealtimeModelV4;',
        lines: [
          '// 模型接口包含 createTransport / getWebRTCConfig / capabilities，',
          '// 会话层据此决定四条物理链路中的哪一条。',
        ],
      },
    ],
  },
  {
    name: 'model/as-language-model-v4.ts',
    want: [49, 54],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// asLanguageModelV4：把 v2/v3 语言模型适配为 v4 的代理层',
          '// 链路位置：resolve-model 与 as-provider-v4 在模型解析末端调用；',
          '// 转换策略是「先升到 v3，再用 Proxy 把 v3 协议按需包成 v4」。',
          '// [权衡] 用 Proxy 而非逐方法复制，新增方法可自动透传。',
          '// ============================================================================',
        ],
      },
      {
        at: 20,
        expect: 'export function asLanguageModelV4(',
        lines: [
          '// v4 直接返回；v2 先经 asLanguageModelV3 升到 v3，',
          '// 因此本函数只需处理「v3 → v4」这一种差异。',
          '// [事务] 适配是纯包装，不复制模型对象，providerOptions 等透传。',
        ],
      },
      {
        at: 31,
        expect: 'return new Proxy(v3Model, {',
        lines: [
          '// 只重写 specificationVersion / doGenerate / doStream，',
          '// 其余属性原样返回，保证 v3 的可选能力不丢失。',
          '// [资源] Proxy 不持有额外资源，生命周期与目标模型一致。',
        ],
      },
      {
        at: 36,
        expect: "case 'doGenerate':",
        lines: [
          '// 调用前把 v4 prompt 降为 v3，调用后把 content 升回 v4；',
          '// 错误不捕获，原样上抛给生成链路。',
        ],
      },
      {
        at: 48,
        expect: "case 'doStream':",
        lines: [
          '// 流式路径不缓冲整个结果，而是在 TransformStream 中逐块转换，',
          '// 保持首 token 延迟不变。',
        ],
      },
      {
        at: 60,
        expect: 'default:',
        lines: [
          '// 未重写的属性直接读目标对象；方法保持原 this 绑定由调用方负责。',
        ],
      },
      {
        at: 67,
        expect: 'function convertV4PromptToV3(',
        lines: [
          '// prompt 降级只处理两种 v4 新增形状：file 的 data 结构与 tool-result',
          '// 的 output 结构；system 消息与其余 part 直接透传。',
          '// [事务] 采用不可变 map，不修改调用方传入的 prompt。',
        ],
      },
      {
        at: 78,
        expect: 'switch (part.type) {',
        lines: [
          '// 逐 part 分派：file 降 data，tool-result 降 output，其余原样。',
        ],
      },
      {
        at: 97,
        expect: 'function convertV4FileDataToV3(',
        lines: [
          '// v4 的 file data 是带 type 的联合：data 取内联值，url 取地址；',
          '// reference/text 在 v3 无对应形状，按原样透传并标注为兼容处理。',
        ],
      },
      {
        at: 112,
        expect: 'function convertV4ToolResultOutputToV3(',
        lines: [
          '// 只转换 content 型输出；其他 output 类型在 v3 已存在，直接返回。',
          '// [资源] Uint8Array 统一转 base64，避免 v3 侧不接受二进制。',
        ],
      },
      {
        at: 157,
        expect: 'function convertV3ContentToV4(',
        lines: [
          '// 反向升级：v3 的 file content 只有裸 data，v4 要求 {type:data,data}；',
          '// 其余 content 类型直接返回同一引用。',
        ],
      },
      {
        at: 168,
        expect: 'function convertV3StreamToV4(',
        lines: [
          '// 流式升级用 pipeThrough 逐块包装，背压由 TransformStream 自动传导；',
          '// 不改变 chunk 顺序，也不缓存跨块状态。',
          '// [资源] 下游取消会通过 pipe 传导到上游 reader。',
        ],
      },
      {
        at: 23,
        expect: "if (model.specificationVersion === 'v4') {",
        lines: [
          '// 已是 v4 时零成本返回：适配层不做无谓包装，保留原对象身份。',
        ],
      },
      {
        at: 37,
        expect: 'return async (options: LanguageModelV4CallOptions) => {',
        lines: [
          '// [事务] 入参转换与结果转换必须成对出现：',
          '// 只降 prompt 不升 content 会让上层收到 v3 形状。',
          '// providerOptions 与其他字段通过展开原样透传。',
        ],
      },
      {
        at: 43,
        expect: 'return {',
        lines: [
          '// content 逐项升级；其余字段（usage/finishReason/warnings）直接展开。',
        ],
      },
      {
        at: 49,
        expect: 'return async (options: LanguageModelV4CallOptions) => {',
        lines: [
          '// 流式路径同样先降 prompt，再把 v3 流接到 v4 转换流上；',
          '// 错误发生在流内部时由下游 reader 感知，不在此处捕获。',
        ],
      },
      {
        at: 55,
        expect: 'return {',
        lines: [
          '// stream 之外的所有字段原样返回，保持 v3 的响应元数据。',
        ],
      },
      {
        at: 71,
        expect: "if (message.role === 'system') {",
        lines: [
          '// system 消息在 v3/v4 同形，直接返回同一引用，避免无谓复制。',
          '// 非 system 走下面的逐 part 转换。',
        ],
      },
      {
        at: 100,
        expect: 'switch (data.type) {',
        lines: [
          '// data 直接取内联内容，url 保留地址；',
          '// reference/text 是 v4 新增形状，v3 无法表达，按原样透传。',
          '// [权衡] 不做有损降级：宁可让下游类型不匹配暴露问题，也不静默丢内容。',
        ],
      },
      {
        at: 115,
        expect: "if (output.type !== 'content') {",
        lines: [
          '// 非 content 输出在 v3 已存在，直接返回同一对象。',
        ],
      },
      {
        at: 126,
        expect: 'switch (part.data.type) {',
        lines: [
          '// file part 的四种 data 形状逐一映射到 v3 的 file-data/url/id；',
          '// text 形状无对应类型，原样透传。',
          '// 这里只改 data，不触碰 mediaType 等描述字段。',
        ],
      },
      {
        at: 160,
        expect: "return content.type === 'file'",
        lines: [
          '// v3 file content 的裸 data 包成 v4 的 {type:data,data} 结构，',
          '// 其他 content 类型直接返回。',
        ],
      },
      {
        at: 28,
        expect: 'const v3Model =',
        lines: [
          '// [事务] 先归一化到 v3 再统一包装，避免在 v4 层写两套 v2/v3 分支。',
        ],
      },
      {
        at: 84,
        expect: "case 'tool-result':",
        lines: [
          '// 工具结果只改写 output 字段，toolCallId/toolName 等原样保留。',
        ],
      },
    ],
  },
  {
    name: 'model/as-provider-v4.ts',
    want: [12, 13],
    blocks: [
      {
        at: 1,
        expect: "import type { ProviderV2, ProviderV3, ProviderV4 } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// asProviderV4：把 v2/v3 provider 适配成 v4 形状',
          '// 做法是返回新对象，每个模型工厂再用对应的 asXxxV4 包装；',
          '// 可选模型（转写/语音/重排）在源 provider 缺失时保持 undefined。',
          '// ============================================================================',
        ],
      },
      {
        at: 10,
        expect: 'export function asProviderV4(',
        lines: [
          '// v4 直接返回；没有 specificationVersion 的旧对象先升到 v3，',
          '// 这样下面的包装只需面对 v3 的工厂签名。',
          '// [事务] 返回的是新对象而非 Proxy，因为 provider 只有少量固定方法。',
        ],
      },
      {
        at: 13,
        expect: 'if (',
        lines: [
          '// 用 in 判断而非直接读属性，兼容没有 specificationVersion 的 v2 对象。',
        ],
      },
      {
        at: 21,
        expect: 'const v3Provider: ProviderV3 =',
        lines: [
          '// 只有明确标记 v3 的才跳过升级；其余一律走 asProviderV3。',
        ],
      },
      {
        at: 27,
        expect: 'return {',
        lines: [
          '// 六个模型工厂逐个包装；可选模型用条件表达式，缺失时保持 undefined，',
          '// 让上层能按能力判断而不是拿到一个调用即抛错的假实现。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (
    f.name === 'realtime/validate-realtime-setup.ts' ||
    f.name === 'realtime/encode-realtime-frame.ts' ||
    f.name === 'realtime/index.ts' ||
    f.name === 'types/realtime-model.ts'
  ) {
    console.log('SKIP already inserted', f.name);
    continue;
  }
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
