// B23 insert: telemetry dispatcher + tracing channel publisher + event filter
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/telemetry/';
const files = [
  {
    name: 'create-telemetry-dispatcher.ts',
    want: [40, 42],
    blocks: [
      {
        at: 1,
        expect: "import { asArray, type Context } from '@ai-sdk/provider-utils';",
        lines: [
          '// ============================================================================',
          '// createTelemetryDispatcher：把一次调用的遥测配置解析成统一分发器',
          '// 负责三件事：选择 integrations、把回调合并成单回调、给事件补元数据并脱敏。',
          '// 所有模型/工具/嵌入等生命周期回调都从这里扇出。',
        ],
      },
      {
        at: 28,
        expect: 'type TelemetryCallbackKey = Exclude<',
        lines: [
          '// 只在编译期挑出值是 Callback 的键，排除 executeLanguageModelCall 等执行包装器；',
          '// 这样 mergeTelemetryCallback 的 key 不会误接受非回调字段。',
        ],
      },
      {
        at: 47,
        expect: 'function augmentEvent<EVENT>(',
        lines: [
          '// 事件增强不改原对象：保留原型后浅拷贝，调用方仍可安全复用原事件。',
          '// 注入的四个字段是集成侧最常读的元数据，统一在这里补，避免每个回调各写一遍。',
          '// recordInputs/recordOutputs 同时供下游 filterTelemetryEvent 判定是否脱敏。',
          '// [事务] aiVersion 固定取构建期常量，保证同一次调用内版本一致。',
        ],
      },
      {
        at: 59,
        expect: 'const augmentedEvent = Object.assign(',
        lines: [
          '// Object.create 保留原型，instanceof 与自定义 getter 在副本上仍然成立；',
          '// 只复制自有可枚举属性，不递归、不深拷贝，事件体量大时也不产生额外开销。',
        ],
      },
      {
        at: 70,
        expect: 'if (',
        lines: [
          '// 只有显式要求过滤上下文时才处理 runtimeContext，避免无谓遍历；',
          '// includeRuntimeContext 为假时 filterIncludedContext 会输出空占位。',
        ],
      },
      {
        at: 82,
        expect: "if (filterContext && event != null && typeof event === 'object') {",
        lines: [
          '// toolsContext 是批量工具上下文，优先处理；',
          '// toolContext 只属于单个工具事件，必须能从 toolCall.toolName 反查白名单。',
        ],
      },
      {
        at: 104,
        expect: 'return filterTelemetryEvent(augmentedEvent, telemetry);',
        lines: [
          '// 统一出口再做一次输入/输出脱敏，保证任何路径都不会漏掉敏感字段。',
        ],
      },
      {
        at: 120,
        expect: 'export function createTelemetryDispatcher({',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 禁用优先：isEnabled=false 直接返回空分发器，不读取任何 integration。',
          '// INV-02 每次调用的 integrations 覆盖全局注册，未提供才回退全局。',
          '// INV-03 回调必须先 bind 到所属 integration，再合并，this 不能丢。',
          '// INV-04 所有事件在离开分发器前都经过 augmentEvent 与脱敏。',
          '// 守住位置：INV-01 在入口，INV-02 在 integrations 赋值处，',
          '// INV-03 在 mergeTelemetryCallback，INV-04 在执行包装与 start 回调。',
        ],
      },
      {
        at: 128,
        expect: 'if (telemetry?.isEnabled === false) {',
        lines: [
          '// 空对象表示「没有遥测」：工具执行不会被包装，调用方无需分支判断。',
        ],
      },
      {
        at: 132,
        expect: 'const localIntegrations = telemetry?.integrations;',
        lines: [
          '// 单次调用的 integrations 可以是单个对象或数组，先归一为数组。',
          '// 全局注册只在本次未提供时读取，避免覆盖用户显式配置。',
        ],
      },
      {
        at: 146,
        expect: 'const recordResult =',
        lines: [
          '// [权衡] 输入与输出任一关闭都不记录原始结果，宁可少采样也不泄露。',
        ],
      },
      {
        at: 149,
        expect: 'const mergeTelemetryCallback = <KEY extends TelemetryCallbackKey>(',
        lines: [
          '// deprecatedKey 让旧回调名继续生效：新名优先，旧名兜底；',
          '// 绑定发生在合并之前，保证每个 integration 的 this 指向自身；',
          '// 没有可用回调时返回 undefined，分发器相应字段保持缺失。',
        ],
      },
      {
        at: 180,
        expect: 'return async (event: TelemetryEvent<KEY>) => {',
        lines: [
          '// 外层 await 保证合并后的回调串行完成，调用方可在 onEnd 后安全收尾。',
        ],
      },
      {
        at: 188,
        expect: 'const executeLanguageModelCallWrappers = integrations',
        lines: [
          '// 执行包装器同样先 bind，再按集成顺序由内向外组合。',
        ],
      },
      {
        at: 199,
        expect: 'runInTracingChannelSpan: async ({ type, event, execute }) =>',
        lines: [
          '// [资源] 每次调用都重新读取 tracing channel，订阅者可随时增减。',
        ],
      },
      {
        at: 209,
        expect: 'startTracingChannelContext: ({ type, event, completion }) =>',
        lines: [
          '// 长生命周期上下文用于流式场景：start 现在发，asyncEnd 等 completion。',
        ],
      },
      {
        at: 227,
        expect: '// Fan out step-end events to both the new `onStepEnd` callback and the',
        lines: [
          '// 兼容窗口内 onStepEnd 同时扇出到旧 onStepFinish，',
          '// 两者都为空时才返回 undefined，避免制造空回调。',
        ],
      },
      {
        at: 272,
        expect: 'executeLanguageModelCall: async ({ execute, ...event }) => {',
        lines: [
          '// 包装器按数组顺序由内向外嵌套：后加入的包住先加入的。',
        ],
      },
      {
        at: 295,
        expect: 'executeTool: async ({ execute, ...event }) => {',
        lines: [
          '// 工具执行与模型调用同构，但不额外开 tracing span；',
          '// span 由上层工具循环统一创建，避免重复计时。',
        ],
      },
    ],
  },
  {
    name: 'tracing-channel-publisher.ts',
    want: [34, 38],
    blocks: [
      {
        at: 1,
        expect: "import type * as diagnosticsChannelModule from 'node:diagnostics_channel';",
        lines: [
          '// ============================================================================',
          '// tracing-channel-publisher：把 SDK 生命周期发布到 Node diagnostics_channel',
          '// 设计原则是 fail-open：运行时不支持或订阅者不存在时，业务调用必须原样通过。',
          '// 本文件只做桥接，不改变模型/工具的返回值与错误语义。',
        ],
      },
      {
        at: 26,
        expect: 'async function loadDiagnosticsChannel(): Promise<',
        lines: [
          '// 非 Node 运行时直接返回 undefined，调用方走直通路径；',
          '// 加载失败同样静默，遥测问题不能升级成用户代码故障；',
          '// 模块级 promise 由上层缓存，这里只负责返回同一次加载结果。',
        ],
      },
      {
        at: 42,
        expect: 'function loadBuiltinModule<T>(id: string): T | undefined {',
        lines: [
          '// [权衡] 用 process.getBuiltinModule 动态取内置模块，',
          '// 避免打包器把 node:diagnostics_channel 静态打进浏览器产物；',
          '// 取不到或抛错都按不可用处理。',
        ],
      },
      {
        at: 66,
        expect: 'export async function runWithTracingChannelSpan<T>(',
        lines: [
          '// 无 diagnostics channel、无 tracingChannel 或无订阅者时完全直通。',
          '// 有订阅者时用 tracePromise 包住执行，但结果以本地记录为准：',
          '// tracePromise 的返回值可能被 recordResult 改写，不能直接透传。',
          '// [失败路径] 订阅者抛错不能吞掉业务错误，也不能让业务成功变成失败。',
          '// 因此这里额外记录 executePromise，保证任何分支都不重复执行。',
        ],
      },
      {
        at: 76,
        expect: 'if (tracingChannel == null || tracingChannel.hasSubscribers === false) {',
        lines: [
          '// hasSubscribers 是热路径判断：没有订阅者时连状态变量都不创建。',
        ],
      },
      {
        at: 80,
        expect: 'let executePromise: Promise<T> | undefined;',
        lines: [
          '// 结果、错误与两个存在标记分开保存，才能区分 undefined 结果与未完成。',
          '// executePromise 只创建一次，兜底分支直接复用它。',
        ],
      },
      {
        at: 86,
        expect: 'const tracedExecute = () => {',
        lines: [
          '// 同步抛错也转成 rejected promise，后续逻辑只需处理一种形态。',
        ],
      },
      {
        at: 108,
        expect: 'return recordResult',
        lines: [
          '// 不记录结果时仍要保留完成信号，但不把真实值交给 tracing；',
          '// 失败统一替换为固定文案，避免原始错误进入订阅者。',
        ],
      },
      {
        at: 118,
        expect: 'try {',
        lines: [
          '// tracePromise 正常返回不代表业务成功，仍以记录的结果为准；',
          '// 它抛错时可能是订阅者故障，此时优先还原真实业务错误；',
          '// 业务已成功则直接返回记录结果，兜底才等待 executePromise。',
        ],
      },
      {
        at: 142,
        expect: 'export function openTelemetryChannelSpanContext({',
        lines: [
          '// 长生命周期上下文：start/end 立即发布，asyncEnd 等 completion 落定。',
          '// 返回的 run 让调用方在不改变流建立时序的前提下重新进入异步上下文。',
        ],
      },
      {
        at: 164,
        expect: 'if (',
        lines: [
          '// 能力缺失时仍消费 completion 的拒绝，避免未处理拒绝告警。',
        ],
      },
      {
        at: 180,
        expect: 'const safePublish = (publish: () => void) => {',
        lines: [
          '// [失败路径] 订阅者异常不得影响 SDK 流行为，所有 publish 都包一层。',
        ],
      },
      {
        at: 188,
        expect: 'const publishAsyncEnd = ({',
        lines: [
          '// 幂等：completion 与兜底路径都可能触发，只允许发布一次 asyncEnd。',
          '// 有错误先发 error；recordResult 为假时不把真实结果写进上下文。',
          '// [事务] error 与 result 互斥地写入同一个 message 对象。',
        ],
      },
      {
        at: 215,
        expect: 'safePublish(() => {',
        lines: [
          '// 顺序固定：start 建立 AsyncResource，end 标记启动完成，',
          '// asyncEnd 在 completion 后发布，三者共同构成订阅者看到的时间线。',
        ],
      },
      {
        at: 227,
        expect: 'return {',
        lines: [
          '// run 是唯一的重入入口：没有 AsyncResource 时退化为直接执行。',
        ],
      },
    ],
  },
  {
    name: 'filter-telemetry-event.ts',
    want: [42, 45],
    blocks: [
      {
        at: 1,
        expect: "import type { TelemetryOptions } from './telemetry-options';",
        lines: [
          '// ============================================================================',
          '// filterTelemetryEvent：按 recordInputs/recordOutputs 对事件副本脱敏',
          '// 只处理 SDK 自有字段，用户上下文由 filter-included-context 单独负责。',
          '// 设计目标是「默认零拷贝」：两个开关都未关闭时原样返回。',
          '// 该函数是遥测链路的最后一道闸门，所有集成都依赖它。',
        ],
      },
      {
        at: 7,
        expect: 'export function filterTelemetryEvent<EVENT>(',
        lines: [
          '// 递归入口：steps 与 finalStep 会再次进入本函数。',
          '// 只有需要隐藏输入或输出时才创建副本，未开启记录时没有额外成本。',
          '// [事务] 永不修改调用方传入的事件对象。',
          '// 副本保留原型，订阅者仍可使用 instanceof 与自定义 getter。',
          '// 递归调用共享同一 telemetry 配置，保证子步与顶层策略一致。',
        ],
      },
      {
        at: 11,
        expect: 'const hideInputs = telemetry.recordInputs === false;',
        lines: [
          '// 只有显式 false 才隐藏；undefined 表示未配置，按允许记录处理。',
        ],
      },
      {
        at: 13,
        expect: 'if (',
        lines: [
          '// 快路径：无需隐藏或事件不是对象时直接返回，不分配副本。',
          '// null 与原始值不参与脱敏，避免为不存在的内容构造包装。',
        ],
      },
      {
        at: 21,
        expect: 'const filtered = Object.assign(',
        lines: [
          '// 浅拷贝自有属性并保留原型，后续只改副本上的字段。',
        ],
      },
      {
        at: 25,
        expect: 'const replace = (fields: Record<string, unknown>) => {',
        lines: [
          '// 只替换事件本来就有的键，避免脱敏时凭空新增字段改变事件形状；',
          '// 值用 undefined 与空容器区分「字段不存在」和「存在但被清空」。',
          '// 这里用原事件做 hasOwn 判定，而不是已被修改的副本。',
        ],
      },
      {
        at: 33,
        expect: "const isSpeech = filtered.operationId === 'ai.generateSpeech';",
        lines: [
          '// 语音合成的 text 是输入而非输出，需按 operationId 单独处理。',
        ],
      },
      {
        at: 34,
        expect: 'if (hideInputs) {',
        lines: [
          '// 输入字段按 SDK 事件协议穷举；未列出的自定义字段保持原样。',
          '// state 有数组/字符串/对象三种形状，清空时必须保持原形状。',
          '// toolCall/toolOutput 的 input 单独处理，因为它们是嵌套对象。',
          '// text 只在语音合成时清空，普通生成的 text 属于输出侧。',
        ],
      },
      {
        at: 61,
        expect: 'if (filtered.toolCall != null) {',
        lines: [
          '// 工具调用只清 input，保留 toolName/toolCallId 供集成做维度聚合。',
        ],
      },
      {
        at: 67,
        expect: 'if (Array.isArray(filtered.ranking)) {',
        lines: [
          '// 排序结果中的 document 可能是字符串或对象，清空时保持原类型。',
        ],
      },
      {
        at: 76,
        expect: 'if (hideOutputs) {',
        lines: [
          '// 输出字段同样穷举；语音场景保留 text，因为它是输入侧内容。',
          '// 各类 toolCalls/toolResults 的静态与动态变体都要清空，',
          '// 否则某一个变体会成为绕过脱敏的缺口。',
          '// reasoning 只在数组形态时清空，字符串形态直接置 undefined。',
        ],
      },
      {
        at: 100,
        expect: 'if (filtered.toolOutput != null) {',
        lines: [
          '// 工具输出同时含 output 与 error，两者都可能泄露结果。',
        ],
      },
      {
        at: 109,
        expect: '// Raw provider payloads and errors can contain either inputs or outputs.',
        lines: [
          '// providerMetadata 与 error 无法判断属于输入还是输出，始终脱敏；',
          '// 错误统一替换为固定文案，保留「发生过错误」这一事实。',
          '// 该 replace 不受两个开关影响，属于兜底不变量。',
          '// 空 error（null/undefined）保持原值，避免把「无错误」变成错误。',
        ],
      },
      {
        at: 117,
        expect: "for (const key of ['toolCall', 'toolOutput'] as const) {",
        lines: [
          '// 嵌套工具事件需要重建对象：只清 providerMetadata 与 error，',
          '// 其余字段（名称、id、状态）保留，保证订阅者仍能关联调用。',
          '// 重建而非原地修改，避免污染原事件中的嵌套引用。',
        ],
      },
      {
        at: 134,
        expect: "for (const key of ['request', 'response'] as const) {",
        lines: [
          '// body 无论开关都删除：原始请求/响应体是最大的泄露面；',
          '// request 按输入策略清 messages/instructions，response 按输出策略；',
          '// metadata 可能是单个对象或数组，两种形状都要递归处理。',
          '// 先展开再 delete，保证不修改原始 metadata。',
        ],
      },
      {
        at: 156,
        expect: 'if (Array.isArray(filtered.steps)) {',
        lines: [
          '// 多步结果逐项递归，复用同一套开关，避免顶层脱敏而子步泄露。',
          '// map 返回新数组，原 steps 引用不被替换。',
        ],
      },
      {
        at: 161,
        expect: "if (Object.hasOwn(event, 'finalStep')) {",
        lines: [
          '// 用原事件判断 finalStep 是否存在，防止 replace 阶段新增该键；',
          '// finalStep 可能为 undefined，递归入口会原样返回。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (f.name === 'create-telemetry-dispatcher.ts' || f.name === 'tracing-channel-publisher.ts') {
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
