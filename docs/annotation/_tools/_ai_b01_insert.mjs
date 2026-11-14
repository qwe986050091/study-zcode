// AI-deep-b01 注释插入：按基线行号（自下而上）插入整行 // 注释，锚点必须匹配。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';
const NL = '\r\n';

const jobs = {
  'packages/ai/src/generate-text/parse-tool-call.ts': [
    {
      at: 1,
      expect: "import type { LanguageModelV4ToolCall } from '@ai-sdk/provider';",
      text: [
        '// 工具调用解析入口：把 provider 产出的原始 tool call（JSON 字符串）转成带类型、带校验的 TypedToolCall。',
        '//',
        '// 链路位置：generateText / streamText 在模型响应收口后，经由本文件把 provider 的',
        '// LanguageModelV4ToolCall 变成上层可直接执行或回灌给模型的 tool-call part；',
        '// 下游是 executeToolCall（执行）与 toResponseMessages（回灌消息历史）。',
        '//',
        '// INV-01：任何来自外部输入（模型输出、消息历史）的 tool call，input 必须经过 schema 校验；',
        '// 只有 providerExecuted && dynamic 的调用允许跳过本地 schema，因为它没有本地工具定义。',
        '// （守住它的位置：doParseToolCall / parseProviderExecutedDynamicToolCall）',
        '// INV-02：解析失败不得直接抛给调用方，而是降级为 invalid:true 的 tool-call part，',
        '// 让上层把错误写回消息历史、由模型在下一轮自行纠正参数。',
        '// （守住它的位置：parseToolCall 最外层 catch）',
        '// INV-03：repairToolCall 只对 NoSuchToolError / InvalidToolInputError 触发；abort 与其它错误',
        '// 必须原样上抛，否则用户取消会被伪装成"模型参数错误"并触发一次多余的修复请求。',
        '// INV-04：refinement 之后若输入被改写，必须同步更新记录下来的 schema 原始值，',
        '// 否则序列化回消息历史时用的是改写前的数据，与执行时看到的不一致。',
        '// （守住它的位置：setToolCallInputSchemaInput）',
      ],
    },
    {
      at: 42,
      expect: '    if (tools == null) {',
      text: [
        '    // tools 未配置时只有一种合法情形：provider 自己执行的 dynamic tool（本地没有工具表）。',
        '    // 其余情况说明模型幻觉了一个不存在的工具，抛 NoSuchToolError 让上层决定修复还是回灌。',
      ],
    },
    {
      at: 54,
      expect: '    try {',
      text: [
        '    // 正常路径：先按本地 schema 解析，再跑用户自定义的 input refinement。',
        '    // refinement 放在 schema 之后，保证它拿到的是已校验、已补默认值的结构化输入，',
        '    // 而不是模型可能写错的原始 JSON。',
      ],
    },
    {
      at: 59,
      expect: '    } catch (error) {',
      text: [
        '      // 只有"工具不存在"或"参数非法"才值得让模型重新生成；',
        '      // 其它异常（网络、用户 abort、实现 bug）直接上抛，避免被修复逻辑吞掉后',
        '      // 变成一次看似成功的工具调用。',
      ],
    },
    {
      at: 70,
      expect: '      let repairedToolCall: LanguageModelV4ToolCall | null = null;',
      text: ['      // 修复函数可能返回 null 表示放弃修复；此时保留下方原始 error 的语义。'],
    },
    {
      at: 73,
      expect: '        abortSignal?.throwIfAborted();',
      text: ['        // [资源] 修复调用同样受外部 abort 控制：先检查一次，避免已经取消还去发一次模型请求。'],
    },
    {
      at: 78,
      expect: '            inputSchema: async ({ toolName }) => {',
      text: [
        '            // 懒加载：只有修复函数真的要用 schema 时才做 asSchema 转换，',
        '            // 避免为一次修复把整个工具集的 schema 都求值一遍。',
      ],
    },
    {
      at: 90,
      expect: '      } catch (repairError) {',
      text: [
        '        // [失败路径] 修复本身失败要与"原始解析失败"区分：包装成 ToolCallRepairError 并保留',
        '        // cause 与 originalError，上层可据 cause 判断是取消、网络错误还是实现异常。',
      ],
    },
    {
      at: 99,
      expect: '      if (repairedToolCall == null) {',
      text: ['      // 修复函数明确返回 null：按原始错误处理，不构造 repaired part，也不再把 repairedToolCall 往下传。'],
    },
    {
      at: 103,
      expect: '      const parsedRepairedToolCall = await refineParsedToolCallInput({',
      text: [
        '      // 修复后的 tool call 必须重新走完整解析：不能信任修复函数返回的内容，',
        '      // 它同样来自模型或用户代码，schema 校验与 refinement 一步都不能省。',
      ],
    },
    {
      at: 108,
      expect: '      abortSignal?.throwIfAborted();',
      text: [
        '      // [并发] 竞态窗口：修复期间外部可能已 abort（Promise 已 resolve 但取消信号后到），',
        '      // 这里再查一次，保证不会把已取消请求的结果交给执行层。',
      ],
    },
    {
      at: 112,
      expect: '  } catch (error) {',
      text: [
        '  // [失败路径] 兜底降级：任何解析/修复/refinement 错误都收敛成 invalid tool-call part。',
        '  // 这里刻意不 rethrow：工具执行层需要看到这条 part 才能把错误写回消息历史，',
        '  // 让模型在下一轮自行纠正参数；直接抛会让整次生成失败。',
        '  // abort 必须在降级前抛，否则用户取消会被伪装成"工具参数无效"（见 INV-03）。',
      ],
    },
    {
      at: 116,
      expect: '    const parsedInput = await safeParseJSON({ text: toolCall.input });',
      text: [
        '    // 尽力保留可读输入：JSON 能解析就给出结构化值，否则原样返回字符串，',
        '    // 便于 UI 展示，也便于下一轮 prompt 原样复述错误现场。',
      ],
    },
    {
      at: 118,
      expect: '    const tool = getOwn(tools, toolCall.toolName);',
      text: [
        '    // 工具可能根本不存在（NoSuchToolError），因此 tool 允许 undefined；',
        '    // title/metadata 只在确实声明了对应工具时补，避免给幻觉工具编造元数据。',
      ],
    },
    {
      at: 120,
      expect: '    // TODO AI SDK 6: special invalid tool call parts',
      text: [
        '    // 降级 part 固定标 dynamic:true + invalid:true：dynamic 表示工具名不保证在 TOOLS 中，',
        '    // invalid 让执行层跳过它；两者一起保证这条错误记录能安全穿过消息组装。',
        '    // 同时保留 providerMetadata：provider 侧的缓存/计费语义不能因为本地校验失败而丢失。',
      ],
    },
    {
      at: 137,
      expect: 'async function waitForPromiseWithAbortSignal<T>({',
      text: [
        '// [并发] 把一个可能不响应 abort 的 Promise 包成可取消等待。',
        '// Promise 本身没有取消语义：这里只保证外层尽快 reject，底层工作仍会跑完，',
        '// 因此调用方不能依赖它释放资源（例如 repairToolCall 内部自建的请求）。',
      ],
    },
    {
      at: 144,
      expect: '  if (abortSignal == null) {',
      text: ['  // 快路径：没有取消信号时不做额外包装，避免每次工具调用都多一层微任务。'],
    },
    {
      at: 149,
      expect: '    const cleanup = () => {',
      text: [
        '    // [资源] 两个出口（resolve / reject）都必须移除监听器，否则长生命周期的',
        '    // AbortSignal 会持有 Promise 闭包，重复调用下形成内存泄漏。',
      ],
    },
    {
      at: 169,
      expect: '    if (abortSignal.aborted) {',
      text: [
        '    // [并发] 监听器注册与初次检查之间存在窗口：注册后立刻补查一次，',
        '    // 覆盖"信号在注册前就已 abort"的情况（addEventListener 不会补发历史事件）。',
      ],
    },
    {
      at: 175,
      expect: 'export async function refineParsedToolCallInput<TOOLS extends ToolSet>({',
      text: [
        '// 对已解析的 toolCall 应用可选的 input refinement（用户自定义的输入改写/补全）。',
        '// 该函数在"直接解析成功"与"修复成功"两条路径都必须执行：refinement 是语义的一部分，',
        '// 不是可选装饰，漏掉会让两条路径产出的 tool-call 形状不一致。',
      ],
    },
    {
      at: 182,
      expect: '  const refine = getOwn(refineToolInput, toolCall.toolName);',
      text: ['  // 按工具名取 refinement；用 getOwn 而不是直接索引，避免命中原型链上的同名属性。'],
    },
    {
      at: 188,
      expect: '  const refinedToolCall = {',
      text: ['  // refinement 可能返回全新的输入对象；只替换 input，toolCall 的 id / 元数据保持不变。'],
    },
    {
      at: 193,
      expect: '  const inputSchemaInput = getToolCallInputSchemaInput(toolCall);',
      text: [
        '  // refinement 改变了 input 之后，之前记录的"schema 解析原始值"可能已过期；',
        '  // 若存在则按新 input 重新挂载，保证下游序列化的是同一份数据（见 INV-04）。',
      ],
    },
    {
      at: 199,
      expect: 'async function parseProviderExecutedDynamicToolCall(',
      text: [
        '// provider 已执行的 dynamic tool：本地没有它的 schema，只剩"能否解析成 JSON"这一条约束。',
        '// 空字符串按空对象处理：多数模型对无参工具会给 ""，而不是 "{}"。',
      ],
    },
    {
      at: 207,
      expect: '  if (parseResult.success === false) {',
      text: [
        '  // [失败路径] 这里抛 InvalidToolInputError 而不是直接返回 invalid part，',
        '  // 是为了让外层 repairToolCall 有机会修复；外层 catch 仍会兜底降级。',
      ],
    },
    {
      at: 226,
      expect: 'async function doParseToolCall<TOOLS extends ToolSet>({',
      text: [
        '// 真正的解析：工具必须存在，input 必须通过该工具的 schema。',
        '// 与 provider 执行路径的区别在于这里能拿到 inputSchema，因此可以做类型校验与默认值填充。',
      ],
    },
    {
      at: 237,
      expect: '  if (tool == null) {',
      text: ['  // 工具不存在：provider 执行的 dynamic 调用是合法例外，其余一律 NoSuchToolError（带上可用工具列表）。'],
    },
    {
      at: 249,
      expect: '  const schema = asSchema(tool.inputSchema);',
      text: ['  // asSchema 同时接受 zod schema 与 JSON schema；这里只求值一次，后面两条分支共用。'],
    },
    {
      at: 251,
      expect: '  // when the tool call has no arguments, we try passing an empty object to the schema',
      text: [
        '  // 空输入走 safeValidateTypes({}) 而不是 JSON.parse("{}")：让 schema 的 required/default 逻辑',
        '  // 决定结果，避免绕过校验直接执行一个缺参数的调用。',
      ],
    },
    {
      at: 258,
      expect: '  if (parseResult.success === false) {',
      text: [
        '  // [失败路径] 参数不合法交给 InvalidToolInputError，携带原始文本与 cause，',
        '  // 上层据此决定是否触发 repairToolCall。',
      ],
    },
    {
      at: 266,
      expect: '  return setToolCallInputSchemaInput(',
      text: [
        '  // 区分 dynamic 与非 dynamic 的返回形状：dynamic 工具名可能不在 TOOLS 的 key 里，',
        '  // 因此保留原始 toolName 并显式标 dynamic:true，供下游按字符串分发。',
      ],
    },
  ],

  'packages/ai/src/generate-text/execute-tools-from-stream.ts': [
    {
      at: 1,
      expect: 'import type {',
      text: [
        '// 工具执行流：收集模型流里的 tool-call part，在 model-call-end 时按并发度执行，',
        '// 并把结果（流式 preliminary 输出、审批事件、错误）继续以流的形式下发。',
        '//',
        '// 链路位置：streamText / generateText 的 model call 之后、tool loop 的消息组装之前。',
        '// 上游是 stream-language-model-call 产出的 part 流；下游是工具执行结果的消息归并与 UI 流。',
        '//',
        '// INV-01：所有输入 part 必须先原样 enqueue，再决定是否执行；执行是旁路，',
        '// 不得改写或延迟透传，否则 UI 看到的 token 顺序会与模型输出不一致。',
        '// （守住它的位置：transform 开头的 controller.enqueue(chunk)）',
        '// INV-02：只有 finishReason 允许工具执行时才批量执行；被截断的响应可能带着',
        '// 不完整的 tool-call，执行它等于用半截参数调用用户代码。',
        '// （守住它的位置：model-call-end 分支的 isToolExecutionAllowedFinishReason）',
        '// INV-03：providerExecuted 的调用绝不能本地执行：它已经由 provider 侧完成。',
        '// INV-04：需要审批的调用在拿到决定前不得进入执行队列；已拒绝的调用必须产生',
        '// tool-output-denied，否则下一轮消息历史里会出现没有结果的 tool-call。',
        '// INV-05：重试边界必须清空累积队列：上一次 attempt 的 tool-call 不能和本轮混在一起执行。',
      ],
    },
    {
      at: 43,
      expect: 'type ExecuteToolsInputStreamPart<TOOLS extends ToolSet> =',
      text: [
        '// 输入流只允许两类 part：语言模型的流 part 与重试边界。',
        '// 输出流在此之上增加"拒绝输出"与"执行结束"两类本地事件，类型层面就禁止它们回流到输入。',
      ],
    },
    {
      at: 47,
      expect: 'export function executeToolsFromStream<',
      text: [
        '// 参数分成四组：流与工具定义、调用上下文（callId/messages/abortSignal）、',
        '// 审批与沙箱配置、遥测与回调。分组对应四个生命周期阶段，便于审计时按阶段排查。',
        '// 返回值是惰性管道：只有下游开始拉取时才会触发 transform，进而执行工具。',
      ],
    },
    {
      at: 89,
      expect: '  const toolCallsToExecute: Array<TypedToolCall<TOOLS>> = [];',
      text: [
        '  // [并发] 待执行队列：transform 串行写入，model-call-end 时一次性读走并并发执行；',
        '  // 之所以不边收边执行，是因为 finishReason 要到最后才知道（见 INV-02）。',
      ],
    },
    {
      at: 92,
      expect: '  return stream.pipeThrough(',
      text: [
        '  // [资源] pipeThrough 返回的流被下游取消时会向 TransformStream 发 cancel；',
        '  // 这里不额外持有 reader，中断传播依赖上游 abortSignal 与流自身的 cancel。',
      ],
    },
    {
      at: 97,
      expect: '      async transform(',
      text: [
        '      // [并发] transform 对每个 chunk 串行调用：await 审批判定会阻塞后续 chunk 的透传。',
        '      // 因此这里只做轻量决策，真正的工具执行推迟到 model-call-end 之后并发跑。',
      ],
    },
    {
      at: 104,
      expect: '        controller.enqueue(chunk);',
      text: [
        '        // 先透传再处理：保证调用方看到的 part 顺序与模型输出一致，',
        '        // 也避免后面的 await 改变 part 的到达时机。',
      ],
    },
    {
      at: 106,
      expect: '        if (isStreamRetryAttemptBoundaryPart(chunk)) {',
      text: [
        '        // [失败路径] 重试边界代表上一次 attempt 作废：清空待执行队列，',
        '        // 否则重试后会把已作废的 tool-call 执行一次（重复副作用）。',
      ],
    },
    {
      at: 111,
      expect: '        const chunkType = chunk.type;',
      text: ['        // switch 只关心两类事件：单个工具调用的审批决策，以及整轮模型调用的收口。'],
    },
    {
      at: 114,
      expect: "          case 'tool-call': {",
      text: [
        '          // tool-call 可能来自 provider 执行、可能是修复失败的 invalid 产物、',
        '          // 也可能指向本地不存在的工具；这三种都不进入本地执行队列。',
      ],
    },
    {
      at: 119,
      expect: '            const tool = getOwn(tools, chunk.toolName);',
      text: ['            // 用 getOwn 取工具，避免工具名为 toString / constructor 时命中原型链。'],
    },
    {
      at: 127,
      expect: '            const toolApprovalStatus = await resolveToolApproval({',
      text: [
        '            // 审批判定是异步的（可能跑用户策略）：它只做判定不做执行，',
        '            // 保证同一 chunk 的审批事件一定排在工具结果之前。',
      ],
    },
    {
      at: 140,
      expect: "            if (toolApprovalStatus.type === 'not-applicable') {",
      text: [
        '            // 不需要审批的调用不消耗 approvalId：调用方可能依赖 id 序列的可预测性',
        '            // （例如把 approvalId 当幂等键），无谓地生成会让序列漂移。',
      ],
    },
    {
      at: 148,
      expect: '            const approvalId = generateId();',
      text: [
        '            // 从这里进入"有审批语义"的路径：统一分配 approvalId 并签名，',
        '            // 三种决定（user-approval / denied / approved）共用同一个 id 与签名。',
      ],
    },
    {
      at: 149,
      expect: '            const signature = await maybeSignApproval({',
      text: [
        '            // [失败路径] 签名失败不阻断审批流程：maybeSignApproval 返回 null 时',
        '            // 只是不附带签名，由下游决定是否接受未签名审批。',
      ],
    },
    {
      at: 157,
      expect: '            switch (toolApprovalStatus.type) {',
      text: [
        '            // 三种决定都先补齐 request 事件，再决定是否执行：',
        '            // 消息历史里"请求 → 响应"必须成对，重组请求时才能还原审批语义。',
      ],
    },
    {
      at: 158,
      expect: "              case 'user-approval': {",
      text: [
        '              // 需要用户交互：只发出审批请求就返回，工具执行必须等下一轮消息',
        '              // 带回 tool-approval-response 后再走 approved 分支。',
      ],
    },
    {
      at: 172,
      expect: "              case 'denied': {",
      text: [
        '              // [事务] 自动拒绝是三事件原子序列：request → response(false) → output-denied。',
        '              // 三者必须同批下发；缺 output-denied 会让历史里出现没有结果的 tool-call，',
        '              // 下一轮请求会被 provider 判为消息不完整。',
      ],
    },
    {
      at: 197,
      expect: "              case 'approved': {",
      text: [
        '              // 自动批准同样先补 request/response 事件对，保持消息历史的因果完整，',
        '              // 然后 break 进入下面的执行入队逻辑。',
      ],
    },
    {
      at: 220,
      expect: '            if (tool.execute != null && chunk.providerExecuted !== true) {',
      text: [
        '            // 只有真正的本地工具（有 execute 且非 provider 执行）才入队；',
        '            // 仅声明 schema 的工具用于约束输出，不产生本地副作用。',
      ],
    },
    {
      at: 227,
      expect: "          case 'model-call-end': {",
      text: [
        '          // 模型调用结束是唯一执行时机：此时 tool-call 参数已完整，',
        '          // finishReason 也能表明响应是否被截断。',
      ],
    },
    {
      at: 232,
      expect: '            await mapWithConcurrency({',
      text: [
        '            // [并发] 并发度由 toolCallConcurrency 控制；结果通过 controller.enqueue 逐条下发，',
        '            // 顺序不保证与调用顺序一致，下游必须按 toolCallId 关联。',
        '            // await 的是整批完成，但每个工具的结果在完成时就已经流出去了，不会攒到最后。',
      ],
    },
    {
      at: 241,
      expect: '                  const result = await executeToolCall({',
      text: [
        '                // 不 await 整批再统一下发，而是每个结果完成即 enqueue：',
        '                // 长时间运行的工具不会阻塞其它工具的结果与 UI 更新。',
      ],
    },
    {
      at: 254,
      expect: '                    onPreliminaryToolResult: result => {',
      text: [
        '                    // [资源] 流式初步结果直接借用 controller：工具实现可以在执行过程中',
        '                    // 多次 yield preliminary，用于进度展示；最终结果仍以 result.output 为准。',
      ],
    },
    {
      at: 258,
      expect: '                  if (result != null) {',
      text: [
        '                  // tool-execution-end 先于结果 part 下发，携带耗时供 UI 展示；',
        '                  // 顺序颠倒会让 UI 在拿到结果时还不知道执行耗时。',
      ],
    },
    {
      at: 266,
      expect: '                } catch (error) {',
      text: [
        '                // [失败路径] 单个工具抛错不终止整条流：包装成 error part 下发，',
        '                // 让上层决定是回灌给模型还是中断；队列中其它工具继续执行。',
      ],
    },
  ],

  'packages/ai/src/generate-text/execute-tool-call.ts': [
    {
      at: 1,
      expect: 'import {',
      text: [
        '// 单个工具调用的执行器：负责生命周期回调、超时/取消合并、流式输出与错误归一化。',
        '//',
        '// 链路位置：execute-tools-from-stream 在 model-call-end 时逐条调用本函数。',
        '// 上游已保证：工具存在、input 已通过 schema 校验、审批已通过（或无需审批）。',
        '//',
        '// INV-01：本函数只处理"可执行工具"（isExecutableTool）。仅声明 schema 的工具返回 undefined，',
        '// 调用方必须把 undefined 当作"没有输出"，而不是失败。',
        '// （守住它的位置：函数开头的 isExecutableTool 分支）',
        '// INV-02：工具抛出的任何错误都必须转成 tool-error part 返回，不得向上抛；',
        '// 否则一个工具失败会中断整批工具与后续消息组装。',
        '// （守住它的位置：catch (error) 分支）',
        '// INV-03：toolExecutionMs 必须在 finally 里结算：提前返回或抛错都要有耗时，',
        '// 它是 tool-execution-end 事件唯一的耗时来源。',
        '// INV-04：超时与外部 abort 合并成同一个 signal 传给工具；合并后不再区分来源，',
        '// 否则会把"超时"误报成"用户取消"。',
        '// INV-05：start / end 回调必须成对触发，且 end 携带的 toolOutput 已是最终形态。',
      ],
    },
    {
      at: 86,
      expect: '  const { toolName, toolCallId, input } = toolCall;',
      text: [
        '  // 解构后不再信任 toolCall 的其它字段：后续所有事件都从这三个值派生，',
        '  // 保证 start / end / 结果三处使用同一份 toolName 与 toolCallId。',
      ],
    },
    {
      at: 89,
      expect: '  if (!isExecutableTool(tool)) {',
      text: [
        '  // [失败路径] 工具不存在或没有 execute 时返回 undefined（不是抛错）：',
        '  // 调用方据此跳过执行，但仍保留模型输出的 tool-call part。',
      ],
    },
    {
      at: 93,
      expect: '  const context = await validateToolContext({',
      text: [
        '  // 上下文校验放在执行之前：schema 不匹配属于配置错误，',
        '  // 不应让工具实现先产生副作用再报错。',
      ],
    },
    {
      at: 99,
      expect: '  const toolExecutionContext = {',
      text: ['  // 回调事件与工具执行共享同一个上下文对象，避免两处各自组装导致字段漂移。'],
    },
    {
      at: 104,
      expect: '  const baseCallbackEvent = {',
      text: [
        '  // callId 区分"同一次 AI SDK 调用内的多个步骤"，toolCallId 区分"同一步内的多个工具"，',
        '  // 两者一起才能唯一定位一次工具执行，日志与遥测都依赖这个组合。',
      ],
    },
    {
      at: 109,
      expect: '  return await runInTracingChannelSpan({',
      text: [
        '  // 整个工具执行包在 tracing span 内：工具内部再调 AI SDK（嵌套生成）时，',
        '  // 会挂到这个 span 下，形成正确的调用树而不是并列的根节点。',
      ],
    },
    {
      at: 115,
      expect: '      await notify({',
      text: [
        '      // [事务] start 回调先于任何用户代码执行；回调抛错会中断本次工具执行，',
        '      // 由外层 catch 归一化成 tool-error，不会静默跳过。',
      ],
    },
    {
      at: 120,
      expect: '      const toolTimeoutMs = getToolTimeoutMs<TOOLS>(timeout, toolName);',
      text: [
        '      // [资源] 超时与外部取消合并成同一个 signal：mergeAbortSignals 负责在超时后主动 abort，',
        '      // 工具实现只需监听传入的 signal，不必自己起 timer，也不会漏掉取消。',
      ],
    },
    {
      at: 123,
      expect: '      let toolExecutionMs = 0;',
      text: [
        '      // 耗时从"进入用户代码"开始算，不含回调与上下文校验，',
        '      // 这样上报的数字对应工具本身的执行时间。',
      ],
    },
    {
      at: 126,
      expect: '        await executeToolInTelemetryContext({',
      text: [
        '        // telemetry 包装层可能改写执行上下文（例如注入 trace 字段）；',
        '        // 这里把执行体作为闭包传入，保证包装层能同时看到开始与结束。',
      ],
    },
    {
      at: 131,
      expect: '            const startTime = now();',
      text: ['            // [资源] startTime 在 try 内取：包装层自身的准备耗时不进入工具耗时。'],
    },
    {
      at: 133,
      expect: '              const stream = executeTool({',
      text: [
        '              // executeTool 返回异步迭代器：preliminary 是过程输出，最后一个非 preliminary',
        '              // 才是最终输出。不要假设一定有 preliminary，也不要假设只有一个最终值。',
      ],
    },
    {
      at: 145,
      expect: '              for await (const part of stream) {',
      text: [
        '              // [并发] 逐个消费工具输出：工具内部可以并发，但这里保持顺序，',
        '              // 保证 preliminary 结果按产生顺序进入流。',
      ],
    },
    {
      at: 157,
      expect: '            } finally {',
      text: [
        '              // [资源] 无论正常结束、抛错还是被 abort，都要结算耗时；',
        '              // 放在 finally 里避免 catch 分支拿到 0。',
      ],
    },
    {
      at: 162,
      expect: '      } catch (error) {',
      text: [
        '      // [失败路径] 工具错误在这里被"数据化"：原始 error 放进 tool-error part，',
        '      // 同时仍然触发 onToolExecutionEnd，让审计与日志看到失败结束事件。',
      ],
    },
    {
      at: 178,
      expect: '        await notify({',
      text: ['        // 失败也要发 end 回调：只发 start 不发 end 会让监听方永远等不到收口。'],
    },
    {
      at: 193,
      expect: '      const toolResult = {',
      text: [
        '      // 成功结果同样带上 providerMetadata / toolMetadata：下游回灌消息时需要这些元数据',
        '      // 还原 provider 侧语义（例如缓存命中、计费归属）。',
      ],
    },
    {
      at: 208,
      expect: '      await notify({',
      text: [
        '      // [事务] 先构造完整结果再发 end 回调：回调里若读取 event.toolOutput，',
        '      // 必须已经是最终形态（含 output 与耗时），不能是半成品。',
      ],
    },
  ],

  'packages/ai/src/generate-text/invoke-tool-callbacks-from-stream.ts': [
    {
      at: 1,
      expect: 'import type {',
      text: [
        '// 工具输入回调流：把 tool-input-start / tool-input-delta / tool-call 三类 part',
        '// 映射到工具定义上的 onInputStart / onInputDelta / onInputAvailable 钩子。',
        '//',
        '// 链路位置：位于模型流解析之后、工具执行之前。它只做通知，不改写 part，',
        '// 也不参与参数校验（校验在 parseToolCall）。下游仍是原有的执行与消息组装链路。',
        '//',
        '// INV-01：所有 part 必须先透传再回调，回调异常不得吞掉 part。',
        '// （守住它的位置：transform 开头的 controller.enqueue）',
        '// INV-02：同一 toolCallId 的工具名只在 tool-input-start 时记录一次；后续 delta',
        '// 必须按 id 查表，因为 delta part 本身不带 toolName。',
        '// INV-03：上下文校验结果按 (toolCallId, toolName) 缓存，避免每个 delta 都跑一次 schema；',
        '// 缓存随 tool-call 或重试边界清理，防止长会话内存增长。',
        '// INV-04：重试边界必须清空 ongoingToolCalls：上一轮 attempt 的半截输入不能与',
        '// 新 attempt 的 delta 拼接，否则两次生成的参数会被混成一条。',
      ],
    },
    {
      at: 32,
      expect: '  if (tools == null) return stream;',
      text: [
        '  // 没有工具时零开销直通：不建立 TransformStream，也不申请任何缓存表，',
        '  // 避免为空工具集白白增加一层背压。',
      ],
    },
    {
      at: 34,
      expect: '  let ongoingToolCalls: Record<',
      text: [
        '  // [资源] 按 toolCallId 记录进行中的调用；createIdMap 创建无原型对象，',
        '  // 防止 id 为 toString / __proto__ 时命中原型链。',
      ],
    },
    {
      at: 42,
      expect: '  const getValidatedContext = ({',
      text: [
        '  // 上下文校验是异步且可能抛错的：缓存 Promise 而不是结果，',
        '  // 保证同一 toolCall 的并发 delta 只触发一次校验，也不会看到半完成状态。',
      ],
    },
    {
      at: 51,
      expect: '    const validatedContext = ongoingToolCall?.validatedContexts[toolName];',
      text: [
        '    // 同一调用内按工具名再分一层：一个 toolCallId 通常只对应一个工具，',
        '    // 但重试或修复可能让同一 id 先后出现不同 toolName。',
      ],
    },
    {
      at: 56,
      expect: '    const tool = getOwn(tools, toolName);',
      text: [
        '    // 工具可能已被移除（动态工具集）：schema 缺失时按"无上下文约束"处理，',
        '    // 由 validateToolContext 决定是放行还是报错。',
      ],
    },
    {
      at: 63,
      expect: '    if (ongoingToolCall != null) {',
      text: [
        '    // 只给已知的进行中调用写缓存；不在表中的 id 说明 start 未到或已被清理，',
        '    // 此时不制造悬挂条目。',
      ],
    },
    {
      at: 70,
      expect: '  return stream.pipeThrough(',
      text: [
        '  // [并发] transform 串行执行；await 回调会阻塞后续 part 的透传。',
        '  // 这是有意的：onInputDelta 的调用顺序必须与 delta 到达顺序一致。',
      ],
    },
    {
      at: 81,
      expect: "          case 'tool-input-start': {",
      text: [
        '          // start 是唯一能拿到 toolName 的时机：先建表再回调，',
        '          // 保证回调内部同步触发的 delta 也能查到工具名。',
      ],
    },
    {
      at: 87,
      expect: '            const tool = getOwn(tools, chunk.toolName);',
      text: ['            // 回调可选：未声明 onInputStart 的工具只建表，不产生额外开销。'],
    },
    {
      at: 103,
      expect: "          case 'tool-input-delta': {",
      text: [
        '          // delta 只带 id 与增量文本：工具名必须从表中取；',
        '          // 查不到说明是重试后的残留或 provider 乱序，按无工具处理。',
      ],
    },
    {
      at: 123,
      expect: "          case 'tool-call': {",
      text: [
        '          // tool-call 是收口事件：无论是否 invalid、是否有回调，',
        '          // 都必须删除表项，否则该 toolCallId 的上下文缓存会一直驻留。',
      ],
    },
    {
      at: 127,
      expect: '            if (!chunk.invalid && tool?.onInputAvailable != null) {',
      text: [
        '            // invalid 的调用不触发 onInputAvailable：input 未通过校验，',
        '            // 把它交给用户回调等于给业务代码喂不可信数据。',
      ],
    },
    {
      at: 133,
      expect: '              delete ongoingToolCalls[chunk.toolCallId];',
      text: [
        '              // 先取走校验 Promise 的引用再删除表项：删除后仍要 await 它，',
        '              // 保证回调拿到的 context 与之前 delta 使用的是同一份。',
      ],
    },
    {
      at: 142,
      expect: '            } else {',
      text: [
        '            // 没有回调或调用非法：同样清理表项。这里不能省，',
        '            // 否则大量无效调用会把上下文缓存累积成内存泄漏。',
      ],
    },
  ],

  'packages/ai/src/generate-text/collect-tool-approvals.ts': [
    {
      at: 1,
      expect: 'import type {',
      text: [
        '// 审批结果收集：从消息历史（尤其是最后一条 tool 消息）里还原',
        '// "哪个 tool-call 被批准/拒绝"，并把响应顺序恢复成模型调用顺序。',
        '//',
        '// 链路位置：generateText / streamText 的下一轮开始处，决定哪些 tool-call',
        '// 需要在本轮执行、哪些只需写入 denied 结果。上游是用户代码构造的消息历史，',
        '// 下游是 execute-tools-from-stream 与消息组装。',
        '//',
        '// INV-01：所有按 id 建立的查找表必须无原型（Object.create(null)），否则',
        '// id 命中 toString / constructor 时会绕过 == null 检查，跳过下面的错误校验。',
      ],
    },
    {
      at: 31,
      expect: '  const lastMessage = messages.at(-1);',
      text: [
        '  // 只有最后一条消息是 tool 消息时才可能有新审批：更早的审批已在之前的轮次处理过，',
        '  // 重复处理会导致同一 tool-call 被执行两次。',
      ],
    },
    {
      at: 55,
      expect: '  for (const message of messages) {',
      text: [
        '  // 第一遍：收集全部 assistant tool-call，并记录模型给出的原始顺序。',
        '  // 审批响应可能乱序到达，这个序号是后面恢复执行顺序的唯一依据。',
      ],
    },
    {
      at: 70,
      expect: '  for (const message of messages) {',
      text: [
        '  // 第二遍：收集审批请求，建立 approvalId → request 的映射。',
        '  // 响应里只有 approvalId，必须能反查到它对应的 toolCallId。',
      ],
    },
    {
      at: 83,
      expect: '  for (const part of lastMessage.content) {',
      text: [
        '  // 最后一条 tool 消息里可能已带结果（重放或用户预填）：',
        '  // 这类调用不应再次执行，下面的 existingToolResult 分支据此跳过。',
      ],
    },
  ],
};

let totalAdded = 0;
for (const [rel, edits] of Object.entries(jobs)) {
  const file = REPO + rel;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\r\n');
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  for (const e of sorted) {
    const idx = e.at - 1;
    if (lines[idx] !== e.expect) {
      console.error(`ANCHOR MISMATCH ${rel}:${e.at}`);
      console.error('  expect: ' + JSON.stringify(e.expect));
      console.error('  actual: ' + JSON.stringify(lines[idx]));
      process.exit(1);
    }
    lines.splice(idx, 0, ...e.text);
    totalAdded += e.text.length;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`OK ${rel} +${edits.reduce((n, e) => n + e.text.length, 0)}`);
}
console.log('TOTAL ADDED ' + totalAdded);
