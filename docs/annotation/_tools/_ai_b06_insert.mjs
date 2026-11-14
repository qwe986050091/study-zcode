// AI-deep-b06：UI 协议 chunk 定义、收尾处理与读取器。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

const plan = [
  {
    rel: 'packages/ai/src/ui-message-stream/ui-message-chunks.ts',
    edits: [
      {
        at: 1,
        expect: 'import {',
        text: [
          '// UI 消息协议（UIMessageChunk）的运行时校验与 TypeScript 类型定义。',
          '//',
          '// 链路位置：服务端 toUIChunk 产出该协议 → SSE 序列化 → 浏览器解析，',
          '// 客户端 useChat 与 readUIMessageStream 都依赖这里的形状与校验。',
          '// 同一份定义出现两次是刻意的：zod 负责运行时校验（跨版本兼容检查），',
          '// TS 联合类型负责编译期窄化。改动时必须两边同步，否则校验与类型会漂移。',
          '//',
          '// INV-01：所有对象都用 looseObject：允许未知字段透传，',
          '// 这样新增字段不会让旧客户端整条消息解析失败。',
          '// INV-02：data-* 的 type 用自定义校验强制前缀，',
          '// 否则业务自定义 chunk 会与协议内建 chunk 混淆。',
          '// INV-03：finishReason 的枚举必须与 FinishReason 类型逐一对应，',
          '// satisfies 会在新增枚举值时让这里编译失败。',
        ],
      },
      {
        at: 21,
        expect: 'const toolMetadataSchema',
        text: [
          '// 工具展示元数据只允许 JSON 值：它要经过网络传输，',
          '// 函数、undefined、循环引用都会在序列化时静默丢失或抛错。',
          '// 用 record + optional value 而不是 z.any()，把限制前移到校验阶段。',
        ],
      },
      {
        at: 26,
        expect: 'export const uiMessageChunkSchema',
        text: [
          '// 联合校验器：按 type 字面量逐一匹配。',
          '// lazySchema 延迟构造：zod schema 的构建有成本，很多场景只用类型不做校验。',
          '// 顺序有意义：zod 按联合顺序尝试，常见类型放前面可略降低平均匹配成本。',
          '// 每个分支都带 type 字面量：这是区分联合的唯一依据，缺了就无法判定。',
          '// 校验失败应被当作协议错误上抛，而不是尽力修复：',
          '// 带着半个 chunk 继续解析会让客户端的消息状态机进入不可预测状态。',
        ],
      },
      {
        at: 29,
        expect: 'z.looseObject({',
        text: [
          '// 文本三段式：start 建立 part，delta 增量追加，end 收尾。',
          '// id 必须由服务端生成且在消息内唯一，客户端据此归并并发文本段。',
        ],
      },
      {
        at: 34,
        expect: 'z.looseObject({',
        text: [
          '// delta 而非 text：明确这是增量，客户端应追加而不是覆盖。',
        ],
      },
      {
        at: 40,
        expect: 'z.looseObject({',
        text: [
          '// citations 只在 end 出现：引用依赖完整文本，提前下发没有意义。',
        ],
      },
      {
        at: 46,
        expect: 'z.looseObject({',
        text: [
          '// 错误只带 errorText：原始错误对象不外发，避免泄漏堆栈与内部字段。',
        ],
      },
      {
        at: 50,
        expect: 'z.looseObject({',
        text: [
          '// 工具调用的四段式：start（身份）→ delta（增量输入）→ available/error（终态）。',
          '// inputEncoding 决定客户端如何拼接增量：text 直接连接，json 需要额外解析。',
          '// dynamic 表示工具定义不在客户端本地表里，客户端应放宽参数校验。',
        ],
      },
      {
        at: 61,
        expect: 'z.looseObject({',
        text: [
          '// 增量只带文本，不带工具名：客户端按 toolCallId 归并到 start 建立的 part。',
        ],
      },
      {
        at: 66,
        expect: 'z.looseObject({',
        text: [
          '// available 是"参数完整且校验通过"的终态，客户端可据此执行本地工具。',
          '// input 用 z.unknown：参数结构由工具 schema 决定，协议层不做二次校验。',
          '// toolMetadata 供 UI 展示（图标、标题等），不参与执行逻辑。',
        ],
      },
      {
        at: 77,
        expect: 'z.looseObject({',
        text: [
          '// error 仍带 input：UI 需要展示模型给出的原始参数，帮助用户修正。',
          '// errorText 是给人看的说明，客户端不应尝试从中解析结构化信息。',
        ],
      },
      {
        at: 89,
        expect: 'z.looseObject({',
        text: [
          '// 审批请求只带 id 关联，不重复调用的参数（客户端已从 available 拿到）。',
          '// inputSchemaInput 是 schema 规范化后的输入，供审批界面展示"实际将执行什么"。',
          '// signature / isAutomatic 支持自动审批与防篡改校验，缺省表示人工审批。',
        ],
      },
      {
        at: 99,
        expect: 'z.looseObject({',
        text: [
          '// 审批结论：approved + 可选 reason，providerExecuted 用于 provider 侧审批。',
        ],
      },
      {
        at: 107,
        expect: 'z.looseObject({',
        text: [
          '// output 必填但允许 null：无返回值的工具也必须让客户端看到该键。',
          '// preliminary 表示中间结果，客户端应覆盖展示而不是追加。',
          '// providerExecuted 区分本地执行与 provider 执行，影响客户端是否展示工具卡片。',
        ],
      },
      {
        at: 117,
        expect: 'z.looseObject({',
        text: [
          '// 工具错误与输出分开：客户端可以只对错误做特殊样式，而不污染正常结果。',
        ],
      },
      {
        at: 126,
        expect: 'z.looseObject({',
        text: [
          '// 拒绝是终态：客户端收到后不再等待该调用的输出。',
        ],
      },
      {
        at: 130,
        expect: 'z.looseObject({',
        text: [
          '// 推理三段式与文本同构：客户端可以复用同一套增量渲染逻辑。',
          '// 是否下发由服务端的 sendReasoning 控制，协议本身不设开关。',
          '// reasoning-file 走 file 分支而非这里：它是产物，不是增量文本。',
        ],
      },
      {
        at: 146,
        expect: 'z.looseObject({',
        text: [
          '// custom 的 kind 用 transform 强制 "namespace.name" 两段式，',
          '// 客户端据此路由到对应组件；格式错误在校验期就会被拒绝。',
        ],
      },
      {
        at: 151,
        expect: 'z.looseObject({',
        text: [
          '// 两类来源分开定义：URL 来源有 url 字段，文档来源有 mediaType/filename。',
          '// sourceId 用于客户端去重与引用跳转，必须在消息内唯一。',
          '// title 可选是因为部分 provider 不返回标题，UI 需自行降级展示。',
        ],
      },
      {
        at: 158,
        expect: 'z.looseObject({',
        text: [
          '// 文档来源的 title 必填：没有 URL 可点击，标题是唯一的识别信息。',
        ],
      },
      {
        at: 166,
        expect: 'z.looseObject({',
        text: [
          '// 文件统一用 url 表达（通常是 data URL）：协议不假设客户端能访问服务端存储。',
          '// [资源] data URL 会放大约 33%，大文件传输成本高，需在应用层控制。',
        ],
      },
      {
        at: 172,
        expect: 'z.looseObject({',
        text: [
          '// reasoning-file 单独成类型：客户端可以整体隐藏推理产物而不影响普通文件。',
        ],
      },
      {
        at: 178,
        expect: 'z.looseObject({',
        text: [
          '// steering 消息内嵌自己的 parts 数组，而不是拆成多条 chunk：',
          '// 它是一条完整的用户消息，必须原子地插入到模型输出流中。',
          '// 只允许 text / file：steering 语义上就是用户输入，不应包含工具或推理。',
          '// id 沿用消息自身 id，客户端据此与服务端历史对齐。',
        ],
      },
      {
        at: 199,
        expect: 'z.looseObject({',
        text: [
          '// 业务自定义数据块：type 必须以 data- 开头（见 INV-02），其余字段由业务定义。',
          '// transient 表示只用于 UI 提示（如进度条），不写入持久化消息。',
        ],
      },
      {
        at: 209,
        expect: 'z.looseObject({',
        text: [
          '// step 边界：start-step 与 finish-step 成对出现，',
          '// 多步 agent 的 UI 据此分段渲染，或在 finish-step 时做快照与持久化。',
        ],
      },
      {
        at: 215,
        expect: 'z.looseObject({',
        text: [
          '// reset-step 是重试时的回滚信号：客户端应丢弃当前 step 已渲染的 parts。',
          '// 它比"发一条新消息"轻量，能保留消息身份与历史。',
        ],
      },
      {
        at: 218,
        expect: 'z.looseObject({',
        text: [
          '// start / finish 是消息级边界，携带消息元数据；step 级边界不带负载。',
          '// messageId 可选：续写已有消息时由服务端决定，新消息交给客户端生成。',
        ],
      },
      {
        at: 223,
        expect: 'z.looseObject({',
        text: [
          '// finishReason 的枚举顺序无关，但必须覆盖所有 FinishReason（见 INV-03）。',
          '// error 表示生成过程中出错；interrupted 表示被用户或系统中止。',
          '// 两者都算"结束"，客户端不应继续等待更多内容。',
        ],
      },
      {
        at: 238,
        expect: 'z.looseObject({',
        text: [
          '// abort 是传输层的中止信号，reason 仅用于日志，不应展示给最终用户。',
        ],
      },
      {
        at: 242,
        expect: 'z.looseObject({',
        text: [
          '// 元数据可以独立于 start/finish 更新：长回复中用量、耗时等信息会变化。',
          '// 客户端按到达顺序覆盖，最后一次为准。',
        ],
      },
      {
        at: 250,
        expect: 'export type DataUIMessageChunk',
        text: [
          '// 业务数据类型映射成 chunk 联合：DATA_TYPES 的每个键生成一个 data-<key> 类型。',
          '// 用 ValueOf 取联合而不是映射对象，客户端可据此做穷举处理。',
          '// 这里的 type 模板字符串与运行时校验的 startsWith("data-") 对应。',
        ],
      },
      {
        at: 259,
        expect: 'export type UIMessageChunk<',
        text: [
          '// 面向使用者的类型：两个泛型分别是消息元数据类型与业务数据类型。',
          '// 与上方 zod schema 一一对应，schema 是运行时的事实来源。',
          '// 字段注释只在语义不明显处保留：协议本身的形状已由名字表达。',
          '// 新增成员时必须同时更新 schema，否则校验会拒绝合法数据。',
        ],
      },
      {
        at: 263,
        expect: '| {',
        text: [
          '// 文本三段与 schema 完全对应；providerMetadata 用于透传 provider 专有字段。',
        ],
      },
      {
        at: 305,
        expect: '| {',
        text: [
          '// tool-input-* 的 available 与 error 共享大部分字段，只有终态不同。',
        ],
      },
      {
        at: 328,
        expect: '| {',
        text: [
          '// 审批相关类型不带 providerMetadata：审批属于应用层交互，不来自 provider。',
        ],
      },
      {
        at: 346,
        expect: '| {',
        text: [
          '// 工具输出与错误的字段差异只在 output/errorText，便于客户端用同一组件渲染。',
          '// toolMetadata 让客户端能在没有本地工具定义时仍展示工具信息。',
        ],
      },
      {
        at: 369,
        expect: '| {',
        text: [
          '// inputEncoding 缺省按 JSON 处理：这是绝大多数 provider 的行为。',
        ],
      },
      {
        at: 386,
        expect: '| {',
        text: [
          '// 来源与文件的类型较简单，注释省略；语义同 schema 段。',
        ],
      },
      {
        at: 401,
        expect: '| {',
        text: [
          '// 文件与推理文件共用 url/mediaType 结构，仅 type 不同。',
          '// 客户端可据此决定是否把推理产物收进折叠面板。',
        ],
      },
      {
        at: 413,
        expect: '| DataUIMessageChunk<DATA_TYPES>',
        text: [
          '// 业务数据块插在这里：它是开放的并集成员，顺序不影响判别。',
        ],
      },
      {
        at: 422,
        expect: '| {',
        text: [
          '// 三个 step 级控制块不带负载，客户端只需按类型切换状态。',
        ],
      },
      {
        at: 434,
        expect: '| {',
        text: [
          '// start/finish 的 METADATA 泛型来自 UIMessage 的 metadata 字段，',
          '// 这样业务定义的元数据类型会自动流到协议层，无需重复声明。',
        ],
      },
      {
        at: 444,
        expect: '| {',
        text: [
          '// abort 与 message-metadata 是消息级控制块，前者终止、后者更新。',
        ],
      },
      {
        at: 453,
        expect: 'export function isDataUIMessageChunk(',
        text: [
          '// 前缀判断即类型守卫：业务数据块的唯一共同特征就是 data- 前缀，',
          '// 不需要遍历已知键，因此对任意新数据块都成立。',
        ],
      },
      {
        at: 459,
        expect: 'export type InferUIMessageChunk<T extends UIMessage>',
        text: [
          '// 从 UIMessage 反推它对应的 chunk 类型：',
          '// 让 useChat / handleUIMessageStreamFinish 等 API 能按消息类型自动约束 chunk。',
          '// 两个 Infer 分别提取 metadata 与 data，缺一都会让业务自定义块丢失类型。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/ui-message-stream/handle-ui-message-stream-finish.ts',
    edits: [
      {
        at: 15,
        expect: 'export function handleUIMessageStreamFinish',
        text: [
          '// UI 消息流的收尾层：注入 messageId、维护累积状态、触发 step/整条消息回调。',
          '//',
          '// 链路位置：toUIMessageStream 的最后一步；下游直接交给 SSE 序列化。',
          '// 回调只有在配置了才会构建状态机——没有回调时整层退化为纯透传（见下方早返回）。',
          '//',
          '// INV-01：onEnd 至多执行一次（finishCalled），flush 与 cancel 可能都触发。',
          '// INV-02：处理失败必须覆盖流自报的 outcome：数据都没解析成功，不能算成功。',
          '// INV-03：续写时沿用原消息 id，并让 messages 用新消息替换最后一条，',
          '// 否则调用方会看到重复的 assistant 消息。',
        ],
      },
      {
        at: 65,
        expect: '// last message is only relevant for assistant messages',
        text: [
          '// 只有最后一条是 assistant 才算续写：用户消息结尾意味着这是一次新回复。',
          '// 续写时强制复用原 id（覆盖调用方传入的 messageId），保证客户端按 id 归并。',
        ],
      },
      {
        at: 75,
        expect: 'let isAborted = false;',
        text: [
          '// 三个状态分开记录：isAborted 来自协议，hasProcessingFailure 来自本地处理，',
          '// processingError 保留原始错误对象供 onEnd 判断。',
          '// 不能合并成一个布尔值：失败与中止在 onEnd 里的优先级不同（见 callOnEnd）。',
        ],
      },
      {
        at: 84,
        expect: 'const idInjectedStream = stream.pipeThrough(',
        text: [
          '// id 注入必须在状态机之前：后续按 chunk 累积消息时依赖 messageId 正确。',
          '// 只改 start chunk，其余 chunk 不携带消息 id。',
        ],
      },
      {
        at: 96,
        expect: "if (chunk.type === 'start') {",
        text: [
          '// 只在缺失时注入：服务端自己给了 messageId 时以它为准。',
          '// 展开新对象而不是原地修改：chunk 可能被上游复用或冻结。',
          '// 类型断言是必要的：泛型 chunk 无法在这里静态窄化到 start。',
        ],
      },
      {
        at: 123,
        expect: 'if (resolvedOnEnd == null && resolvedOnStepEnd == null) {',
        text: [
          '// 无回调时直接返回注入流：不建状态机、不 structuredClone，',
          '// 这是流式场景的常见路径，跳过可以显著降低每 chunk 的开销。',
          '// [权衡] 因此"是否需要消息状态"完全由回调是否存在决定，文档需说明这一点。',
        ],
      },
      {
        at: 127,
        expect: 'const state = createStreamingUIMessageState',
        text: [
          '// 用 structuredClone 复制最后一条消息：状态机会原地修改它，',
          '// 不能污染调用方传入的 originalMessages（可能还要用于其他请求）。',
          '// messageId 先给空串，真正的 id 由流里的 start chunk 覆盖。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/ui-message-stream/read-ui-message-stream.ts',
    edits: [
      {
        at: 15,
        expect: 'function createUIMessageSnapshot<UI_MESSAGE extends UIMessage>(',
        text: [
          '// 快照策略：先把 text 字段摘出来， clone 结构，再把文本填回。',
          '// 原因是长文本 structuredClone 代价高，而文本是追加式变化的；',
          '// 摘出后 clone 的只是结构，最后按原值还原，避免每次 emit 都复制全文。',
          '// 注意这是浅层优化：文本本身仍按引用共享，调用方不应修改快照的文本。',
        ],
      },
      {
        at: 66,
        expect: 'let controller',
        text: [
          '// 状态标记与 AbortController 配合：取消后不再 enqueue，',
          '// 并把中止信号传给消费循环，尽快释放上游资源。',
        ],
      },
      {
        at: 71,
        expect: 'const outputStream = new ReadableStream<UI_MESSAGE>({',
        text: [
          '// 输出流只暴露 cancel：所有写入都来自 processUIMessageStream 的 write 回调。',
          '// cancel 里主动 abort，确保停止读取时上游也停止生成。',
        ],
      },
      {
        at: 86,
        expect: 'const handleError = (error: unknown) => {',
        text: [
          '// terminateOnError=false 时只上报不终止：适合"部分内容可用"的 UI 场景。',
          '// hasErrored 保证 controller.error 只调用一次：重复 error 会抛 InvalidStateError。',
        ],
      },
      {
        at: 95,
        expect: 'consumeStream({',
        text: [
          '// resetStateOnMessageIdChange=true：读到新的 start 且 id 变化时重建状态，',
          '// 支持在一个流里连续读取多条消息（例如消息列表的批量回放）。',
          '// write 回调只在未取消时入队快照，避免取消后仍产生垃圾数据。',
        ],
      },
      {
        at: 118,
        expect: '}).finally(() => {',
        text: [
          '// 只有"既没出错也没被取消"时才正常关闭：',
          '// error 与 cancel 都已经让 controller 进入终态，再 close 会抛错。',
          '// 用 finally 而不是 then：即使消费循环提前结束也要走到这里。',
        ],
      },
    ],
  },
];

let totalAdded = 0;
for (const { rel, edits } of plan) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  let added = 0;
  for (const e of sorted) {
    const idx = e.at - 1;
    if (!lines[idx] || !lines[idx].includes(e.expect)) {
      console.error(`MISS ${rel} ${e.at} :: ${e.expect}`);
      console.error('  actual: ' + JSON.stringify(lines[idx]));
      process.exit(1);
    }
    lines.splice(idx, 0, ...e.text);
    added += e.text.length;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`ADDED ${rel} +${added}`);
  totalAdded += added;
}
console.log('TOTAL ' + totalAdded);
