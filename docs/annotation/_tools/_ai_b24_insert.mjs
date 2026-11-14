// B24 insert: prompt content schemas + file data conversion + tool prep
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/prompt/';
const files = [
  {
    name: 'content-part.ts',
    want: [12, 12],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// content-part：prompt 内容部件的 zod 校验层',
          '// 这里定义的 schema 同时服务用户输入校验与模型消息回放，形状必须与协议一致。',
          '// 大多数 schema 带 @internal，仅通过 message.ts 的联合类型对外暴露。',
        ],
      },
      {
        at: 22,
        expect: 'const fileInlineDataSchema: ZodType<DataContent> = z.union([',
        lines: [
          '// 内联文件支持 string（base64）、Uint8Array、ArrayBuffer、Buffer 四种形态；',
          '// Buffer 是 Uint8Array 子类，校验顺序保证先命中更具体的判定。',
        ],
      },
      {
        at: 34,
        expect: 'export const textPartSchema: ZodType<TextPart> = z.object({',
        lines: [
          '// 文本部件是唯一无附加载荷的部件，providerOptions 仍可透传。',
        ],
      },
      {
        at: 45,
        expect: 'export const imagePartSchema: ZodType<ImagePart> = z.object({',
        lines: [
          '// 图像部件已废弃，统一改用 mediaType 为 image 的 file 部件；',
          '// 仍接受内联数据、URL 与 provider reference 三种旧形态。',
        ],
      },
      {
        at: 56,
        expect: "const taggedFileDataSchema = z.discriminatedUnion('type', [",
        lines: [
          '// 带 type 标签的文件数据按判别联合校验，避免多个分支互相误匹配；',
          '// text 形态只属于普通文件，reasoning 文件另用更窄的 schema。',
        ],
      },
      {
        at: 74,
        expect: 'export const filePartSchema: ZodType<FilePart> = z.object({',
        lines: [
          '// 文件部件同时接受 tagged 新形态与裸数据/URL/reference 旧形态。',
        ],
      },
    ],
  },
  {
    name: 'file-part-data.ts',
    want: [32, 32],
    blocks: [
      {
        at: 1,
        expect: "import { convertDataContentToUint8Array } from './data-content';",
        lines: [
          '// ============================================================================',
          '// file-part-data：把 prompt 里的文件数据统一成 v4 provider 的 tagged 形状',
          '// 输入可能是 tagged 对象、URL、字符串、二进制或 provider reference；',
          '// 输出固定为 { data, mediaType }，data URL 会顺带解析出 mediaType。',
          '// 所有歧义都在这里收敛，provider 侧不再处理旧格式。',
          '// 无法识别的值按内联数据兜底，保持与旧版本兼容。',
        ],
      },
      {
        at: 17,
        expect: 'function isTaggedFileData(value: unknown): value is TaggedFileData {',
        lines: [
          '// 只做形状判定，不校验内部字段是否合法；四种 type 与 FilePart 定义一致。',
          '// 非对象或 null 直接否定，避免后续属性访问抛错。',
        ],
      },
      {
        at: 30,
        expect: 'function convertUrlToFilePartData(',
        lines: [
          '// data: URL 不是普通地址，必须拆出 mediaType 与 base64 内容；',
          '// 拆分失败抛 InvalidDataContentError，而不是静默当普通 URL；',
          '// [事务] 普通 URL 原样保留，并用 originalUrl 记住规范化前的字符串。',
          '// 返回值中的 mediaType 只有 data URL 才能推断，其余为 undefined。',
        ],
      },
      {
        at: 53,
        expect: 'function convertUrlStringToFilePartData(content: string): ConvertResult {',
        lines: [
          '// new URL 可能对字符串做规范化（编码、尾斜杠等），',
          '// 一旦结果与原串不同就通过 originalUrl 保留原文；',
          '// 解析失败由调用方 catch 后按内联数据处理。',
        ],
      },
      {
        at: 63,
        expect: 'function convertInlineDataToFilePartData(content: DataContent): ConvertResult {',
        lines: [
          '// ArrayBuffer 与 Uint8Array 统一走 convertDataContentToUint8Array；',
          '// Buffer 先复制成独立 Uint8Array，避免与调用方共享可变视图；',
          '// string 按 base64 原样保留，不在这一层解码。',
          '// 内联数据无法推断 mediaType，必须由 FilePart.mediaType 提供。',
        ],
      },
      {
        at: 89,
        expect: 'export function convertToLanguageModelV4FilePart(',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 tagged 形态优先，命中后不再尝试其它解释。',
          '// INV-02 URL 实例直接转 url；字符串先尝试 URL，失败才当内联数据。',
          '// INV-03 二进制只走 data 形态，provider reference 只走 reference 形态。',
          '// INV-04 data URL 不允许作为内联字符串传入，必须显式用 url 形态。',
          '// INV-05 返回值总是带 mediaType 字段，哪怕值为 undefined。',
          '// 守住位置：INV-01 在入口 switch，INV-02/03 在后续分支，INV-04 在 data 分支。',
        ],
      },
      {
        at: 92,
        expect: 'if (isTaggedFileData(content)) {',
        lines: [
          '// switch 对四种 type 穷尽处理，没有 default，新增类型会编译期暴露。',
        ],
      },
      {
        at: 125,
        expect: "if (typeof content === 'string') {",
        lines: [
          '// 字符串有双重语义：可能是 URL，也可能是 base64 内联数据；',
          '// 先按 URL 解析，失败再退回内联，顺序不能反；',
          '// data: 字符串在这里会被 URL 分支接住并正确解析 mediaType。',
        ],
      },
      {
        at: 133,
        expect: 'if (isUint8Array(content) || isArrayBuffer(content)) {',
        lines: [
          '// 二进制走内联分支，最终统一为 Uint8Array。',
        ],
      },
      {
        at: 144,
        expect: 'return convertInlineDataToFilePartData(content as DataContent);',
        lines: [
          '// 兜底按 DataContent 处理：Buffer 与未知字符串在此收敛。',
        ],
      },
    ],
  },
  {
    name: 'prepare-tools.ts',
    want: [37, 37],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// prepare-tools：把用户 ToolSet 转成 provider 可发送的工具定义数组',
          '// 负责顺序、描述求值、schema 序列化与 function/provider 两类分派。',
          '// 该函数在每次模型调用前执行，输出必须稳定且可缓存无关。',
          '// 空工具集返回 undefined，让 provider 省略 tools 字段。',
        ],
      },
      {
        at: 15,
        expect: 'export async function prepareTools<TOOLS extends ToolSet>({',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 只有非空 ToolSet 才产生数组，空对象与 undefined 都返回 undefined。',
          '// INV-02 顺序由 toolOrder 决定：列出的按给定次序，其余按名称升序。',
          '// INV-03 function tool 必须把 inputSchema 异步转成 JSON Schema。',
          '// INV-04 provider tool 原样转发 id/args，不序列化 schema。',
          '// INV-05 输出数组顺序必须确定，不能依赖对象键的遍历差异。',
          '// 守住位置：INV-01 在入口，INV-02 在 orderToolEntries，INV-03/04 在 switch。',
        ],
      },
      {
        at: 28,
        expect: 'if (!isNonEmptyObject(tools)) {',
        lines: [
          '// 空工具对象视为未配置，避免向 provider 发送空数组改变请求语义。',
        ],
      },
      {
        at: 35,
        expect: 'for (const [name, tool] of orderToolEntries({ tools, toolOrder })) {',
        lines: [
          '// 键名就是模型看到的工具名，后续描述与 context 都按该名字查找。',
        ],
      },
      {
        at: 38,
        expect: 'switch (toolType) {',
        lines: [
          '// undefined、dynamic、function 三种写法在协议层都归一为 function tool；',
          '// provider 类型保留供应商自己的 id 与参数，不做通用化。',
          '// default 用 never 保证新增类型必须在此显式处理。',
          '// 未知类型不会被静默丢弃，而是直接抛错让调用方尽早发现。',
        ],
      },
      {
        at: 42,
        expect: 'const description = resolveToolDescription({',
        lines: [
          '// 描述允许是函数，因此必须在每次请求时求值；',
          '// 函数形式可读取该工具的 context 与 sandbox 会话。',
          '// 返回 undefined 时不会写入 description 字段。',
        ],
      },
      {
        at: 52,
        expect: 'languageModelTools.push({',
        lines: [
          '// inputSchema 通过 asSchema 异步转 JSON Schema，是唯一 await 点；',
          '// 可选字段用条件展开，保证 undefined 不改变输出形状；',
          '// strict 原样透传，是否支持由 provider 决定。',
          '// 工具名与 schema 一一对应，不做别名或去重。',
        ],
      },
      {
        at: 63,
        expect: "case 'provider': {",
        lines: [
          '// provider tool 的 args 已是供应商协议，不能再套 JSON Schema。',
        ],
      },
      {
        at: 72,
        expect: 'default: {',
        lines: [
          '// 穷举保护：tool.type 新增取值时这里会编译失败，而不是运行期静默跳过。',
        ],
      },
      {
        at: 82,
        expect: 'function orderToolEntries<TOOLS extends ToolSet>({',
        lines: [
          '// 显式顺序优先，未列出的工具按名称排序后追加；',
          '// 该规则保证相同输入总得到相同数组，便于快照测试与提示缓存。',
          '// toolOrder 只影响顺序，不会引入不存在的工具。',
          '// 两段排序都基于同一个 Object.entries 快照，不会漏项。',
        ],
      },
      {
        at: 89,
        expect: 'if (toolOrder == null) {',
        lines: [
          '// 未指定顺序时保留对象自身插入顺序。',
        ],
      },
      {
        at: 95,
        expect: 'const orderedTools = toolEntries',
        lines: [
          '// includes 是 O(n) 判定，但工具数量通常很小，换取实现直观。',
        ],
      },
      {
        at: 101,
        expect: 'const unorderedTools = toolEntries',
        lines: [
          '// 未排序工具用字典序，避免依赖对象键的跨引擎差异。',
        ],
      },
      {
        at: 108,
        expect: 'export function resolveToolDescription<TOOLS extends ToolSet>({',
        lines: [
          '// 静态字符串直接返回；函数形式以工具名为键取 context；',
          '// sandbox 会话只透传，不在此处判断可用性。',
          '// context 缺失时传入 undefined，由工具描述函数自行兜底。',
        ],
      },
    ],
  },
  {
    name: 'normalize-stream-provider-error.ts',
    want: [31, 31],
    blocks: [
      {
        at: 1,
        expect: "import { AISDKError } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// normalize-stream-provider-error：把供应商流式错误归一成 StreamProviderError',
          '// 只处理带 message 的对象，已有 Error 与未知值原样返回。',
          '// 归一结果保留原始载荷，便于上层做重试与上报。',
          '// 函数本身不抛错：任何无法识别的输入都原样返回。',
        ],
      },
      {
        at: 9,
        expect: 'export function normalizeStreamProviderError(error: unknown): unknown {',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 已经是 Error/AISDKError/StreamProviderError 时绝不二次包装。',
          '// INV-02 只有 details.message 是字符串才构造新错误，否则原样返回。',
          '// INV-03 状态码与可重试性按「显式字段 → 文案推断 → 状态码」优先级取值。',
          '// INV-04 原始错误始终放入 data，归一不得丢失排障信息。',
          '// INV-05 文案推断与状态码规则只作为显式字段的补充，不覆盖显式值。',
        ],
      },
      {
        at: 10,
        expect: 'if (',
        lines: [
          '// 跨 realm 的 Error 由 isError 用 toString 兜底识别。',
        ],
      },
      {
        at: 18,
        expect: 'const outer = asRecord(error);',
        lines: [
          '// 非对象（字符串、数字、null）无法提取字段，直接放行。',
        ],
      },
      {
        at: 23,
        expect: 'const providerStreamError = isProviderStreamError(error);',
        lines: [
          '// 已是 provider 流错误时字段就在外层；否则依次尝试 response.error、',
          '// error、外层对象，兼容不同供应商的包装层级。',
          '// providerStreamError 的 data 需要保留，因此分支单独处理。',
          '// isProviderStreamError 只认自家标记，不会误吞供应商原始错误。',
        ],
      },
      {
        at: 30,
        expect: "if (typeof details.message !== 'string') {",
        lines: [
          '// 没有可读 message 说明不是可识别的供应商错误，保持原值最安全。',
        ],
      },
      {
        at: 34,
        expect: 'const type = getString(details.type) ?? getString(outer.type);',
        lines: [
          '// type/code 允许出现在内层或外层，内层优先。',
        ],
      },
      {
        at: 36,
        expect: 'const explicitStatusCode =',
        lines: [
          '// 供应商对状态码的命名不统一，按 statusCode/status_code/status/code 回退；',
          '// getHttpStatusCode 只接受 400-599，避免把业务码误当 HTTP 状态。',
          '// 显式值缺失时才用文案推断的结果。',
          '// status_code 等写法来自不同供应商，全部收敛到同一数值字段。',
        ],
      },
      {
        at: 45,
        expect: 'const messageMetadata = inferExactMessageMetadata(details.message);',
        lines: [
          '// 文案推断只覆盖少数精确匹配，作为显式字段缺失时的补充。',
        ],
      },
      {
        at: 47,
        expect: 'const explicitRetryability =',
        lines: [
          '// isRetryable/is_retryable 两种命名都接受，内层优先。',
        ],
      },
      {
        at: 53,
        expect: 'return new StreamProviderError({',
        lines: [
          '// 可重试性优先级：显式字段 → 文案推断 → 状态码规则；',
          '// data 保存原始错误，providerStreamError 时只保留其 data 以免重复包裹。',
          '// 新错误不修改原对象，调用方可继续读取原始字段。',
        ],
      },
      {
        at: 66,
        expect: 'function inferExactMessageMetadata(',
        lines: [
          '// 只匹配整句文案，不做包含判断，避免把含 overloaded 的正常文本误判；',
          '// 返回固定 statusCode 与 isRetryable，供无状态码的供应商兜底。',
          '// 该推断只用于流式错误，普通错误不走这条路径。',
        ],
      },
    ],
  },
  {
    name: 'message.ts',
    want: [21, 21],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// message：四种 role 的 ModelMessage 校验入口',
          '// 每个 role 允许的内容部件不同，顶层用 role 判别联合分流。',
          '// 该 schema 同时用于用户输入与内部消息回放。',
          '// 新增部件时必须同步更新对应 role 的联合，否则会被静默拒绝。',
          '// 校验失败会抛出带路径的 zod 错误，定位到具体部件。',
        ],
      },
      {
        at: 23,
        expect: 'export const systemModelMessageSchema: ZodType<SystemModelMessage> = z.object({',
        lines: [
          '// system 消息只能是纯字符串，不支持多部件或附件。',
          '// 该限制与多数供应商的 system 通道一致。',
        ],
      },
      {
        at: 29,
        expect: 'export const userModelMessageSchema: ZodType<UserModelMessage> = z.object({',
        lines: [
          '// 用户消息接受字符串或 text/image/file 三种部件；',
          '// tool 相关部件不允许出现在 user 侧，避免伪造工具结果。',
          '// imagePartSchema 仅为兼容旧输入保留。',
        ],
      },
      {
        at: 38,
        expect: 'export const assistantModelMessageSchema: ZodType<AssistantModelMessage> =',
        lines: [
          '// assistant 是允许部件最宽的 role：文本、推理、文件、工具调用与审批请求；',
          '// 部件靠各自的 type 字面量判别，联合顺序不影响匹配结果；',
          '// tool-approval-request 由 assistant 发起，response 则在 tool 消息中返回。',
          '// 缺少任一合法部件都会导致整条消息校验失败。',
        ],
      },
      {
        at: 59,
        expect: 'export const toolModelMessageSchema: ZodType<ToolModelMessage> = z.object({',
        lines: [
          '// tool 消息只承载工具结果与审批响应，不包含普通文本；',
          '// 两种部件的 toolCallId/approvalId 用于与 assistant 侧配对。',
          '// 缺少配对 id 的部件会被 schema 直接拒绝。',
        ],
      },
      {
        at: 65,
        expect: 'export const modelMessageSchema: ZodType<ModelMessage> = z.union([',
        lines: [
          '// 顶层联合按 role 分流，顺序只影响报错信息，不影响正确输入的匹配；',
          '// 所有 role 都必须在此注册，否则该 role 会被当作非法消息。',
          '// 该 schema 是 prompt 校验的最后一道入口。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (f.name === 'content-part.ts' || f.name === 'file-part-data.ts' || f.name === 'prepare-tools.ts' || f.name === 'normalize-stream-provider-error.ts') {
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
