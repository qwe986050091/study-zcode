import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/ui/validate-ui-messages.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    at: 0,
    expect: 'import {',
    text: [
      '// 【职责】UI 消息的运行时校验器：把不受信任的 JSON（来自网络、持久化存储、',
      '//   WebSocket 帧）校验成 UIMessage[]，并按调用方提供的 schema 校验 metadata、',
      '//   data part、工具输入与输出。',
      '//',
      '// 【在链路中的位置】上游是 ChatTransport（http-chat-transport、',
      '//   websocket-chat-transport）与 useChat 的恢复路径；下游是 convert-to-model-messages',
      '//   与 Chat 状态机。它是"外部数据进入 UI 层"的唯一闸门，因此这里放过的错误',
      '//   会在下游以更难定位的形式出现。',
      '//',
      '// 【不变量】',
      '//   INV-01 校验不通过必须返回 error 或抛错，绝不返回"部分通过"的结果。',
      '//     守住位置：safeValidateUIMessagesInternal 的 try/catch 与各 return 分支。',
      '//   INV-02 非 assistant 消息至少有一个 part；assistant 允许空 parts（占位流）。',
      '//     守住位置：uiMessagesSchema 的 superRefine。',
      '//   INV-03 工具 part 的 state 与字段组合必须匹配，不允许"状态为 streaming',
      '//     却带 output"这类跨状态字段。守住位置：z.union 中每个状态各自一个 schema。',
      '//   INV-04 校验通过的对象可能与输入不是同一引用（会就地规范化），调用方不得',
      '//     假设原对象未被改动。守住位置：message.parts[partIdx] 的替换。',
      '//   INV-05 找不到 schema 的终态工具可以降级为 dynamic-tool，但不能静默通过。',
      '//     守住位置：asDynamicToolPart 的两处调用。',
    ],
  },
  {
    find: 'const toolMetadataSchema: ZodType<JSONObject> = z.record(',
    text: [
      '// 工具元数据是 JSON 对象的宽松容器：键任意，值只要求是 JSON 值。',
      '// 用 record 而非 object，是为了允许 provider 自定义字段而不改 schema。',
    ],
  },
  {
    find: 'const providerReferenceSchema = z.record(z.string(), z.string());',
    text: [
      '// provider 托管的文件引用：只允许字符串键值，避免把任意结构透传给 provider。',
    ],
  },
  {
    find: 'function isEmptyObject(value: unknown): value is Record<string, never> {',
    text: [
      '// 用于区分"空对象输入"与"缺失输入"：后者是错误，前者是可降级的终态。',
    ],
  },
  {
    find: 'function asDynamicToolPart(toolPart: ToolUIPart): DynamicToolUIPart {',
    text: [
      '// 把已注册工具的 part 降级为 dynamic-tool：类型前缀 tool- 改为 dynamic-tool，',
      '//   工具名从 type 上切出来（去掉前缀 5 个字符）。',
      '// 降级的语义是"这条历史记录不再声称符合当前静态类型"，而不是"工具不存在"。',
      '// markToolPartAsUnavailable 会打上不可用标记，下游据此隐藏或提示。',
      '// 该函数不做深拷贝，part 的 input/output 仍是原引用，调用方不应再修改它。',
      '// 只在"历史终态工具找不到 schema"时调用，活动调用不允许降级。',
    ],
  },
  {
    find: 'function getToolPartInputSchemaInput(',
    text: [
      '// 审批流程可能携带 inputSchemaInput（用于从审批描述重建输入）。',
      '// 用 hasOwnProperty 判断而不是判空：显式的 null 也是有效取值。',
      '// 返回 undefined 表示"没有重建入口"，调用方应直接校验 part.input。',
      '// 该字段只在 approval 对象上，缺失时不做任何推导。',
    ],
  },
  {
    find: 'const uiMessagesSchema = lazySchema(() => {',
    text: [
      '// 用 lazySchema 延迟构造：这个 schema 很大，且依赖 citation/providerMetadata',
      '//   等模块级 schema，立即构造会拉长模块初始化时间并可能产生循环依赖。',
      '// 构造结果被缓存，多次校验不会重复建 schema。',
      '// 下面 7 个审批子 schema 是"扩展链"，不是并列关系：',
      '//   requested → responded → granted/denied，每层只增字段不改语义。',
      '// 之所以不用 discriminated union，是因为它们最终都嵌入到更大的 union 里，',
      '//   而 zod 的嵌套 discriminated union 报错信息可读性很差。',
    ],
  },
  {
    find: 'const approvalRequestedSchema = z.object({',
    text: [
      '// 请求阶段：approved 与 reason 用 z.never().optional() 显式禁止出现，',
      '//   这样"提前带 approved"会在校验期就失败，而不是被下游误读为已决。',
      '// descriptor/signature/inputSchemaInput 都是可选，provider 实现差异较大。',
      '// isAutomatic 表示该审批由系统自动发起（如策略命中），UI 据此调整文案。',
    ],
  },
  {
    find: 'const approvalRespondedSchema = approvalRequestedSchema.extend({',
    text: [
      '// 响应阶段：approved 变为必填布尔，reason 从禁止变为可选。',
      '// 继承 requested 保证请求期字段（id、signature 等）仍然保留，',
      '//   这样同一条 part 从 requested 迁移到 responded 时不会丢上下文。',
    ],
  },
  {
    find: 'const approvalGrantedSchema = approvalRespondedSchema.extend({',
    text: [
      '// 批准/拒绝两个窄化版本，供 output-available / output-denied 分支使用：',
      '//   终态时 approval.approved 必须与状态一致，防止"已拒绝却带 output"。',
    ],
  },
  {
    find: 'return zodSchema(',
    text: [
      '// 顶层结构：非空消息数组，每条消息 id + role + 可选 metadata + parts 数组。',
      '// role 只有三种：UI 层不产生 tool 角色消息，工具结果挂在 assistant 的 part 上。',
    ],
  },
  {
    at: 95,
    expect: 'z.object({',
    text: [
      '// 文本片段的 state 可选：历史消息没有 state 字段，视为已完成。',
      '// citations 与 providerMetadata 都是可选附加信息，不参与状态判定。',
      '// 注意这里不校验 text 非空：空文本在流式收尾时是合法中间态。',
    ],
  },
  {
    at: 102,
    expect: 'z.object({',
    text: [
      '// 推理片段与文本片段的区别：带可选 id（用于 UI 记忆折叠状态），且没有 citations。',
      '// id 可选是为了兼容早期没有 id 的历史数据。',
    ],
  },
  {
    at: 114,
    expect: 'z.object({',
    text: [
      '// 两种来源片段：url 与 document。它们共用 sourceId 命名空间但 type 不同。',
      '// document 的 title 必填而 filename 可选；url 的 title 可选。',
      '// 这些差异来自上游 provider 的字段供给能力，不是随意设定。',
    ],
  },
  {
    at: 129,
    expect: 'z.object({',
    text: [
      '// 文件片段：url 必有，providerReference 可选（有则优先用引用而非直链）。',
      '// reasoning-file 是同族变体，没有 filename——推理中间产物不面向用户命名。',
    ],
  },
  {
    at: 164,
    expect: 'z.object({',
    text: [
      '// step-start 是无字段的分隔标记，只用于切块，不承载任何数据。',
      '// data-* 用 startsWith 匹配：具体数据名由调用方的 dataSchemas 决定。',
      '// 此处不校验 data 的类型，交给第二阶段的 dataSchemas 校验。',
    ],
  },
  {
    at: 172,
    expect: 'z.object({',
    text: [
      '// dynamic-tool 有 7 个状态，每个状态一个独立 schema。为什么不写成一个',
      '//   "全部字段可选 + refine"：那样错误信息会变成笼统的 invalid_union，',
      '//   而分状态能直接指出"你缺了 output"还是"你不该带 output"。',
      '// 每个状态都显式把不适用的字段声明为 z.never().optional()，',
      '//   例如 input-streaming 不允许 output，output-available 不允许 errorText。',
      '// dynamic: z.literal(false).optional() 是历史兼容字段，新数据不应携带。',
      '// toolName 与 toolCallId 在所有状态下都必填，是跨状态稳定的身份。',
    ],
  },
  {
    at: 283,
    expect: 'z.object({',
    text: [
      '// tool-* 是"已注册工具"的 part，与 dynamic-tool 结构相同，唯一区别是',
      '//   用 z.string().startsWith(tool-) 表达类型，因此校验器无法在此静态得知工具名。',
      '// 这意味着工具名的合法性必须由第二阶段（tools 映射）判定，本层只做形状校验。',
      '// 两组 7 状态必须保持同步：任何字段变更都要在这 14 个 schema 里成对修改，',
      '//   漏改一组会导致同一份数据在 dynamic 与静态工具间表现不一致。',
      '// 不要试图用 z.lazy + 共享对象复用：zod 的 extend 会共享引用，',
      '//   后续对单个状态的字段调整会污染其他状态。',
    ],
  },
  {
    at: 383,
    expect: '.superRefine((message, context) => {',
    text: [
      '// 唯一的结构性约束：非 assistant 消息必须至少有一个 part。',
      '// assistant 允许空 parts，因为流式响应在第一个 chunk 之前就是空占位。',
      '// 错误以 addIssue 形式挂到 parts 路径，保证报错能定位到具体字段。',
      '// 该 refine 在 union 之后执行，因此前提是 parts 已通过逐项校验。',
    ],
  },
  {
    at: 397,
    expect: '.nonempty(',
    text: [
      '// 空消息数组直接拒绝：下游会把空数组当成"没有对话"，掩盖调用方 bug。',
    ],
  },
  {
    find: 'export type SafeValidateUIMessagesResult<UI_MESSAGE extends UIMessage> =',
    text: [
      '// 结果类型是判别联合，不使用异常表达业务性失败。',
      '// 只有真正的编程错误（如 schema 抛错）才会以 throw 形式穿透内部的 try。',
    ],
  },
  {
    find: 'type ValidateUIMessagesOptions<UI_MESSAGE extends UIMessage> = {',
    text: [
      '// 可选 schema 分三类：metadata、data part、tools（含输入/输出 schema）。',
      '// 未提供的类别不做校验——这是刻意的"按需校验"，避免要求调用方重复声明。',
      '// experimental_refineToolInput 用于把 inputSchemaInput 重建后的值再做一次归一化，',
      '//   以便与 part.input 做深比较。它是 experimental 的，语义可能变动。',
    ],
  },
  {
    find: 'async function safeValidateUIMessagesInternal<UI_MESSAGE extends UIMessage>(',
    text: [
      '// 内部实现：分三阶段串行执行，顺序不可交换。',
      '//   STEP-1 形状校验（uiMessagesSchema），失败即返回；',
      '//   STEP-2 metadata 校验，逐条就地写回；',
      '//   STEP-3 data part 与 tool part 校验，可能把 part 替换为 dynamic-tool。',
      '// 必须先用 STEP-1 把未知类型收敛成 UIMessage，STPE-2/3 才能安全按字段访问。',
      '// convertMissingTerminalToolsToDynamic 是唯一的行为开关，由两个导出函数分派。',
      '// 整个函数不修改入参对象本身，只修改校验产出的副本（zod 会复制对象）。',
    ],
  },
  {
    find: 'if (messages == null) {',
    text: [
      '// null/undefined 单独判：交给 schema 校验会得到难以理解的 union 错误。',
      '// 这里返回 InvalidArgumentError，与其它参数错误保持一致的错误类型。',
    ],
  },
  {
    find: 'const validatedMessages = await validateTypes({',
    text: [
      '// 第一阶段产出的是全新对象树，后续阶段可以放心就地改写。',
      '// 随后的告警只检查废弃字段，不改变数据，因此放在写回之前。',
    ],
  },
  {
    find: 'const shouldValidateToolParts =',
    text: [
      '// 只要提供了 tools 或要求降级终态工具，就需要遍历工具 part。',
      '// 两者都为假时整个第二阶段跳过，避免无谓的深遍历。',
    ],
  },
  {
    find: 'if (dataSchemas || shouldValidateToolParts) {',
    text: [
      '// 单次双重循环覆盖所有消息与 part：外层消息、内层 part，均保序。',
      '// 不使用 Promise.all：写回操作是就地赋值，并行会让错误归属难以定位，',
      '//   而且 validateTypes 内部可能触发异步 schema（如 refine），需保持确定性。',
    ],
  },
  {
    find: "if (dataSchemas && part.type.startsWith('data-')) {",
    text: [
      '// data part 必须能找到同名 schema，否则报错而不是跳过：',
      '//   静默跳过会让未声明的数据类型进入下游渲染，问题被推迟到更远处。',
      '// dataName 由 type 去掉 data- 前缀得到，与调用方的 key 一一对应。',
      '// 校验成功后直接把结果写回 part.data，替换原始未校验值。',
    ],
  },
  {
    find: "if (shouldValidateToolParts && part.type.startsWith('tool-')) {",
    text: [
      '// 工具 part 的校验分三种结局，务必区分：',
      '//   1) 终态且工具未注册 → 降级为 dynamic-tool（保留数据，去掉静态类型声明）；',
      '//   2) 非终态且工具未注册 → 报错（活动调用必须有 schema，否则无法执行）；',
      '//   3) 工具已注册 → 校验输入/输出，个别失败场景降级而非报错。',
      '// 工具名从 type 切片得到，与 dynamic-tool 的 toolName 字段不同源，',
      '//   因此两者不会互相覆盖。',
      '// 这里用 getOwn 而非直接下标，避免原型链上的同名工具被误命中。',
    ],
  },
  {
    find: 'const isTerminal =',
    text: [
      '// 终态三选一：有输出、有错误、被拒绝。三者都意味着不会再产生新的 delta。',
      '// 只有终态才允许"找不到工具就降级"，活动调用降级会让参数失去约束。',
    ],
  },
  {
    find: '// TODO support dynamic tools',
    text: [
      '// 未注册工具的非终态 part 属于协议不一致，直接报错而不是猜测其 schema。',
      '// 错误里带上 toolName 与 toolCallId，便于定位是哪一次调用缺声明。',
    ],
  },
  {
    find: 'const inputValidationContext = {',
    text: [
      '// 输入校验有三种输入来源，优先级必须清楚：',
      '//   1) inputSchemaInput 存在 → 校验重建值（用于审批场景的一致性检查）；',
      '//   2) output-error 且 input 缺失 → 跳过输入校验（没有可校验的内容）；',
      '//   3) 其余 → 校验 part.input。',
      '// 重建值还会与 part.input 做深比较（可先经 refineToolInput 归一化），',
      '//   不一致即视为篡改或版本漂移，报错而不是取其一。',
    ],
  },
  {
    find: 'if (convertToDynamic) {',
    text: [
      '// 降级在阶段末统一执行：中途替换会让后续分支读到类型不符的对象。',
      '// 这是本函数唯一改动 part 身份（tool- → dynamic-tool）的位置。',
    ],
  },
  {
    find: 'export async function safeValidateUIMessages<UI_MESSAGE extends UIMessage>(',
    text: [
      '// 对外默认不降级：调用方拿到的工具 part 要么通过校验，要么报错。',
    ],
  },
  {
    find: 'export async function validateUIMessages<UI_MESSAGE extends UIMessage>(',
    text: [
      '// 抛错版本：把安全版本的结果转成异常，方便在 await 串中使用。',
      '// 错误对象原样抛出，不做包装，保证调用方能按类型捕获。',
    ],
  },
  {
    find: 'export async function validateUIMessagesForAgent<UI_MESSAGE extends UIMessage>(',
    text: [
      '// Agent 形态允许工具集动态变化，因此开启"缺失终态工具降级"。',
      '// 背景：agent 可能连过 MCP server 后又断开，历史里仍留有那些工具的调用记录；',
      '//   若按静态工具集严格校验，整段历史都会不可用，只能降级为 dynamic-tool 保留。',
      '// 注意该开关只影响终态，活动调用仍然要求工具在场。',
      '// 失败时同样抛错，不返回部分结果。',
    ],
  },
];

for (const a of anchors) {
  if (a.at !== undefined) {
    if (!lines[a.at].includes(a.expect)) {
      console.error(`EXPECT FAIL at ${a.at}: ${lines[a.at]}`);
      process.exit(1);
    }
    a.idx = a.at;
  } else {
    const hits = lines.reduce((acc, line, i) => (line.includes(a.find) ? [...acc, i] : acc), []);
    if (hits.length !== 1) {
      console.error(`HITS ${hits.length} for: ${a.find}`);
      process.exit(1);
    }
    a.idx = hits[0];
  }
}

for (const a of [...anchors].sort((x, y) => y.idx - x.idx)) {
  lines.splice(a.idx, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
