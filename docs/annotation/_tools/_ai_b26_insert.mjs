// B26 insert: ui transport layer and small helpers
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/ui/';
const files = [
  {
    name: 'http-chat-transport.ts',
    want: [26, 28],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// http-chat-transport：useChat 的 HTTP 传输基类',
          '// 统一处理发送消息与断线重连，子类只实现响应流的解码。',
          '// 请求体、头、凭据都支持 Resolvable，可在每次调用时重新求值。',
        ],
      },
      {
        at: 14,
        expect: 'function appendPathToUrl(url: string, path: string): string {',
        lines: [
          '// 路径必须插在 query/fragment 之前，否则会拼出无效 URL；',
          '// 仅当两侧同时有斜杠时去掉一个，避免双斜杠但不改动其它形态。',
          '// [权衡] 不解析 URL 对象，保留调用方传入的相对地址原貌。',
        ],
      },
      {
        at: 24,
        expect: 'export type PrepareSendMessagesRequest<UI_MESSAGE extends UIMessage> = (',
        lines: [
          '// 自定义请求钩子可以完全接管 body/headers/credentials/api，返回同步或异步值。',
        ],
      },
      {
        at: 129,
        expect: 'export abstract class HttpChatTransport<',
        lines: [
          '// 基类只负责请求构造与错误映射，流协议由子类决定；',
          '// 因此换协议无需重写 fetch、鉴权与错误处理。',
        ],
      },
      {
        at: 140,
        expect: 'constructor({',
        lines: [
          '// 默认打到 /api/chat；Resolvable 字段保留原值，调用时再 resolve。',
        ],
      },
      {
        at: 158,
        expect: 'async sendMessages({',
        lines: [
          '// STEP-1 resolve 三类可延迟配置；',
          '// STEP-2 合并全局头与本次头，再交给自定义钩子；',
          '// STEP-3 钩子可覆盖 api/headers/body/credentials；',
          '// STEP-4 POST 并映射错误，最后交给子类解码流。',
        ],
      },
      {
        at: 162,
        expect: 'const resolvedBody = await resolve(this.body);',
        lines: [
          '// 三个 resolve 并行等待，顺序不影响结果。',
        ],
      },
      {
        at: 171,
        expect: 'const preparedRequest = await this.prepareSendMessagesRequest?.({',
        lines: [
          '// 钩子拿到的是已合并的 body 与 headers，可直接改写关键字段；',
          '// 未提供钩子时走默认 body 构造。',
        ],
      },
      {
        at: 183,
        expect: 'const api = preparedRequest?.api ?? this.api;',
        lines: [
          '// api 覆盖优先于默认地址，headers 覆盖会整体替换而不是逐项合并。',
        ],
      },
      {
        at: 201,
        expect: '// avoid caching globalThis.fetch in case it is patched by other libraries',
        lines: [
          '// 每次调用重新取 globalThis.fetch，兼容 polyfill 与测试替换。',
        ],
      },
      {
        at: 215,
        expect: 'if (!response.ok) {',
        lines: [
          '// 非 2xx 统一转成 UIApiCallError，保留响应体与 URL 供排障。',
        ],
      },
      {
        at: 232,
        expect: 'async reconnectToStream(',
        lines: [
          '// 重连使用 GET，默认地址由 chatId 构造；',
          '// 204 表示没有可恢复的流，返回 null 而不是错误。',
        ],
      },
      {
        at: 253,
        expect: 'let api = preparedRequest?.api;',
        lines: [
          '// 自定义钩子给出 api 时完全跳过默认构造；',
          '// chatId 为点段时拒绝，因为 URL 解析会把它规范化掉。',
        ],
      },
      {
        at: 287,
        expect: '// no active stream found, so we do not resume',
        lines: [
          '// [失败路径] 204 是正常语义：调用方据此回到空闲，不触发重试。',
        ],
      },
      {
        at: 309,
        expect: 'protected abstract processResponseStream(',
        lines: [
          '// 子类只决定字节流如何变成 UIMessageChunk，其余逻辑全部复用。',
        ],
      },
    ],
  },
  {
    name: 'call-completion-api.ts',
    want: [50, 50],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// call-completion-api：useCompletion 的单次补全请求实现',
          '// 负责 abort、加载态、错误态、两种流协议与完成回调。',
          '// 核心约束是「只有最新请求能写状态」，旧请求的结果必须丢弃。',
          '// 所有 setter 由调用方注入，本文件不持有 React 状态。',
          '// 该函数可在任意运行时调用，不依赖浏览器全局。',
        ],
      },
      {
        at: 19,
        expect: '// use function to allow for mocking in tests:',
        lines: [
          '// 用函数包一层 fetch，测试可以在导入后替换实现。',
        ],
      },
      {
        at: 22,
        expect: 'export async function callCompletionApi({',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 每次调用新建 AbortController，并登记为当前控制器。',
          '// INV-02 只有 isCurrentRequest 为真时才写 completion/error/loading。',
          '// INV-03 AbortError 静默返回 null，不触发 onError。',
          '// INV-04 无论成功失败，finally 都要在最新请求上复位 loading。',
          '// INV-05 返回值为完整补全文本，失败或取消返回 null/undefined。',
          '// INV-06 流解析失败按错误处理，不会把半截文本当成成功结果。',
          '// 守住位置：INV-01 在入口，INV-02 在每个 setter 前，INV-03/04 在 catch/finally。',
        ],
      },
      {
        at: 53,
        expect: 'const abortController = new AbortController();',
        lines: [
          '// 新请求一创建就接管当前控制器，旧请求随后会被判定为陈旧；',
          '// isCurrentRequest 允许调用方不提供 getter（视为永远最新）。',
          '// [并发] 该判定只比较引用，不依赖序号或时间戳。',
          '// 未提供 getter 时视为单请求场景，所有写入都有效。',
        ],
      },
      {
        at: 57,
        expect: 'try {',
        lines: [
          '// 进入请求生命周期，所有状态变更都在 try 内。',
        ],
      },
      {
        at: 58,
        expect: 'setLoading(true);',
        lines: [
          '// 先清错误再置 loading，避免界面同时显示旧错误与加载态。',
        ],
      },
      {
        at: 61,
        expect: 'setAbortController(abortController);',
        lines: [
          '// 控制器暴露给调用方，useCompletion 的 stop 依赖它。',
        ],
      },
      {
        at: 63,
        expect: '// Empty the completion immediately.',
        lines: [
          '// 立即清空旧文本，防止新请求首包到达前看到上一轮结果。',
        ],
      },
      {
        at: 66,
        expect: 'const response = await fetch(api, {',
        lines: [
          '// body 由 prompt 与用户 body 合并，后者可覆盖 prompt；',
          '// UA 同时带 SDK 版本与运行时环境。',
          '// [失败路径] fetch 本身抛错时直接进入 catch。',
        ],
      },
      {
        at: 82,
        expect: '}).catch(err => {',
        lines: [
          '// 保留 catch 以便未来在此统一转换网络错误，目前原样抛出。',
        ],
      },
      {
        at: 86,
        expect: 'if (!response.ok) {',
        lines: [
          '// 非 2xx 转成带响应体的 UIApiCallError。',
        ],
      },
      {
        at: 94,
        expect: 'if (!response.body) {',
        lines: [
          '// 2xx 但没有 body 属于协议错误，不能当作空补全。',
        ],
      },
      {
        at: 100,
        expect: "let result = '';",
        lines: [
          '// result 是本请求的完整文本，即使中途被更新请求取代也继续累积。',
        ],
      },
      {
        at: 102,
        expect: 'switch (streamProtocol) {',
        lines: [
          '// 两种协议只在解码层不同，累加与状态更新逻辑一致。',
        ],
      },
      {
        at: 103,
        expect: "case 'text': {",
        lines: [
          '// text 协议按原始块追加，不做任何解析；',
          '// 每次追加都检查是否仍为最新请求。',
          '// 该路径不产生结构化错误块。',
          '// reader 由 consumeStream 管理，取消时一并释放。',
        ],
      },
      {
        at: 115,
        expect: "case 'data': {",
        lines: [
          '// data 协议逐条解析 UIMessageChunk 并校验 schema；',
          '// 只消费 text-delta，error 块立即转成 UIMessageStreamError；',
          '// 其它块（start/finish/tool 等）对补全无意义，直接忽略。',
          '// consumeStream 负责把流读完并处理取消。',
          '// 解析失败抛出后由外层 catch 统一回调 onError。',
          '// 只有 text-delta 会修改 result，其它块不改变返回文本。',
        ],
      },
      {
        at: 149,
        expect: 'default: {',
        lines: [
          '// never 穷举：新增协议必须在编译期补齐分支。',
        ],
      },
      {
        at: 159,
        expect: 'if (onFinish) {',
        lines: [
          '// onFinish 只在成功路径触发，携带原始 prompt 与完整文本。',
        ],
      },
      {
        at: 164,
        expect: '} catch (err) {',
        lines: [
          '// 取消是预期行为，静默返回 null，不进入错误回调；',
          '// 其它错误先通知 onError，再仅在最新请求上写 error 状态。',
          '// [失败路径] 陈旧请求的错误不会污染当前请求的界面。',
          '// 错误不写入 completion，保留旧文本由调用方决定是否清空。',
        ],
      },
      {
        at: 179,
        expect: '} finally {',
        lines: [
          '// 只有最新请求才能复位控制器与 loading；',
          '// 否则旧请求结束会把新请求的加载态提前关掉。',
          '// 该复位不依赖成功或失败。',
        ],
      },
    ],
  },
  {
    name: 'index.ts',
    want: [30, 30],
    blocks: [
      {
        at: 1,
        expect: "export { callCompletionApi } from './call-completion-api';",
        lines: [
          '// ============================================================================',
          '// ui/index：聊天与补全能力的公开出口',
          '// 这里只做 re-export，不定义新行为；导出顺序按功能分组。',
          '// 新增公开 API 时必须同步更新此文件，否则消费方无法从主入口导入。',
          '// 类型导出与运行时导出分开书写，便于 tree-shaking。',
          '// 本文件不引入任何副作用，可安全用于客户端组件。',
        ],
      },
      {
        at: 2,
        expect: 'export {',
        lines: [
          '// AbstractChat 是框架无关的聊天状态机，React/Vue/Svelte 绑定都基于它；',
          '// ChatInit 与各类回调类型描述一次聊天会话的配置面。',
          '// ChatTransport 是核心协议，所有传输实现都必须满足该接口。',
          '// 该组导出是 useChat 的公共依赖面。',
        ],
      },
      {
        at: 19,
        expect: "export { convertFileListToFileUIParts } from './convert-file-list-to-file-ui-parts';",
        lines: [
          '// 文件列表转 UI 部件的工具，供输入框粘贴/拖拽场景复用。',
        ],
      },
      {
        at: 26,
        expect: 'export {',
        lines: [
          '// HttpChatTransport 提供 HTTP 请求骨架，子类只实现流解码；',
          '// 两个 Prepare* 类型描述自定义请求钩子的形状。',
          '// 该组是自定义后端接入的主要入口。',
        ],
      },
      {
        at: 32,
        expect: "export { lastAssistantMessageIsCompleteWithApprovalResponses } from './last-assistant-message-is-complete-with-approval-responses';",
        lines: [
          '// 两个完成判定器：一个看工具调用，一个看审批响应；',
          '// 它们决定自动提交是否应继续下一轮。',
          '// 判定器是纯函数，不依赖聊天实例。',
        ],
      },
      {
        at: 35,
        expect: 'export {',
        lines: [
          '// WebSocket 传输与 HTTP 传输共享 ChatTransport 协议；',
          '// 额外导出安全校验结果与请求/响应类型，便于自定义服务端。',
          '// 该组类型较多，但都只在本文件转出。',
          '// WebSocket 传输同样支持断线重连与请求安全校验。',
        ],
      },
      {
        at: 48,
        expect: 'export {',
        lines: [
          '// UI 部件类型与守卫集中导出：',
          '// 守卫用于在渲染前收窄 UIMessagePart，避免到处写 type 判断；',
          '// 类型别名覆盖文本、文件、推理、数据、源、工具等全部部件；',
          '// 新增部件必须同时提供守卫与类型，否则消费方无法安全处理。',
          '// Experimental_ 前缀表示命名仍可能调整。',
        ],
      },
      {
        at: 84,
        expect: 'export {',
        lines: [
          '// 补全相关类型只导出类型，不导出实现。',
        ],
      },
      {
        at: 88,
        expect: 'export {',
        lines: [
          '// 消息校验工具区分抛错版与安全版；',
          '// 安全版返回结果对象，适合在渲染前做容错处理。',
          '// 两者共享同一套 schema。',
        ],
      },
    ],
  },
  {
    name: 'default-chat-transport.ts',
    want: [8, 8],
    blocks: [
      {
        at: 1,
        expect: "import { parseJsonEventStream, type ParseResult } from '@ai-sdk/provider-utils';",
        lines: [
          '// ============================================================================',
          '// default-chat-transport：HttpChatTransport 的默认实现',
          '// 只负责把 JSON 事件流解码成 UIMessageChunk，其余全部继承。',
          '// resumeStreamIsReplay 控制重连语义。',
          '// 该子类不覆盖请求构造与错误映射。',
        ],
      },
      {
        at: 15,
        expect: 'readonly resumeStreamIsReplay: boolean;',
        lines: [
          '// 为真表示服务端会从头重放整段响应，为假表示只续传中断部分。',
        ],
      },
      {
        at: 32,
        expect: 'protected processResponseStream(',
        lines: [
          '// schema 校验失败的块直接抛错，合法块原样下发。',
          '// [失败路径] 抛错会终止整条流，由上层统一转成聊天错误态。',
        ],
      },
    ],
  },
  {
    name: 'last-assistant-message-is-complete-with-tool-calls.ts',
    want: [4, 4],
    blocks: [
      {
        at: 1,
        expect: "import { isToolUIPart, type UIMessage } from './ui-messages';",
        lines: [
          '// 判断最后一条 assistant 消息的工具调用是否都已落地，',
          '// 决定聊天是否应自动发起下一轮请求。',
        ],
      },
      {
        at: 14,
        expect: 'const message = messages[messages.length - 1];',
        lines: [
          '// 只看最后一条消息；空消息或非 assistant 直接判定未完成。',
        ],
      },
      {
        at: 24,
        expect: 'const lastStepStartIndex = message.parts.reduce((lastIndex, part, index) => {',
        lines: [
          '// 以最后一个 step-start 为界，只考察最后一步的工具调用。',
        ],
      },
    ],
  },
  {
    name: 'convert-file-list-to-file-ui-parts.ts',
    want: [9, 11],
    blocks: [
      {
        at: 1,
        expect: "import { UnsupportedFunctionalityError } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// convert-file-list-to-file-ui-parts：把浏览器 FileList 转成 UI 文件部件',
          '// 每个文件通过 FileReader 读取为 data URL。',
          '// 该工具只适用于浏览器环境。',
        ],
      },
      {
        at: 4,
        expect: 'export async function convertFileListToFileUIParts(',
        lines: [
          '// undefined 返回空数组，调用方无需判空。',
          '// 返回的部件可直接拼进 user 消息的 parts。',
        ],
      },
      {
        at: 11,
        expect: "// React-native doesn't have a FileList global:",
        lines: [
          '// 非浏览器环境没有 FileList，抛 UnsupportedFunctionalityError 而不是静默空数组。',
        ],
      },
      {
        at: 19,
        expect: 'return Promise.all(',
        lines: [
          '// 并发读取所有文件，顺序由 Promise.all 保持与输入一致。',
          '// 读取失败会让整个 Promise 拒绝，由调用方统一处理。',
          '// 单个文件读取中断不会取消其它读取，但结果不会被采用。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (f.name === 'http-chat-transport.ts' || f.name === 'call-completion-api.ts' || f.name === 'index.ts' || f.name === 'default-chat-transport.ts' || f.name === 'last-assistant-message-is-complete-with-tool-calls.ts') {
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
