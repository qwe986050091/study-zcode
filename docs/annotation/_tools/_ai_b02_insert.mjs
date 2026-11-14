// AI-deep-b02 注释插入：内容转换 / 消息回灌 / 消息裁剪 / 结果聚合。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

const jobs = {
  'packages/ai/src/generate-text/convert-language-model-content.ts': [
    {
      at: 18,
      expect: 'export async function convertLanguageModelContent<TOOLS extends ToolSet>({',
      text: [
        '// 只做"翻译 + 配对"，不做校验与执行：所有输入都已由上游解析/执行过，',
        '// 这里若再引入一套校验，会出现两套规则、错误归属不清的问题。',
        '// 参数分成三组：provider 内容、已解析/已执行的 SDK 侧产物、文件读取所需的缓存与取消信号。',
      ],
    },
    {
      at: 1,
      expect: "import type { LanguageModelV4Content } from '@ai-sdk/provider';",
      text: [
        '// provider 内容 → SDK 内容 part 的转换器：把 provider 返回的原始内容数组',
        '// 按 toolCalls / toolOutputs / 审批事件重新编排成上层可消费的 ContentPart 序列。',
        '//',
        '// 链路位置：generateText / streamText 在拿到 model 响应后调用；上游是 provider 的',
        '// LanguageModelV4Content，下游是 responseMessages 组装与 UI 流的 part 序列。',
        '//',
        '// INV-01：content 的顺序是权威顺序，不得为了配对而重排；provider 可能依赖顺序',
        '// 还原多模态输入（例如 reasoning 必须紧跟它解释的文本）。',
        '// （守住它的位置：第一个 for 循环与最终返回值的前半段）',
        '// INV-02：tool-call part 必须能找到同一 id 的已解析 toolCall；找不到说明解析阶段',
        '// 漏项，直接抛错而不是丢掉该 part（丢 part 会让消息历史缺一条调用）。',
        '// INV-03：tool-result 缺少对应 tool-call 时，只有 provider 声明',
        '// supportsDeferredResults 才允许保留为"延迟结果"，否则视为协议错误。',
        '// INV-04：带审批响应的工具结果必须排在审批响应之后，且排在其它工具结果之后，',
        '// 保证"请求 → 决定 → 结果"的因果顺序在消息历史中成立。',
      ],
    },
    {
      at: 37,
      expect: '  const contentParts: Array<ContentPart<TOOLS>> = [];',
      text: [
        '  // 三类输出分开收集：content 原样映射的部分、无审批响应的工具输出、',
        '  // 有审批响应的工具输出（后者必须排在审批事件之后，见 INV-04）。',
      ],
    },
    {
      at: 40,
      expect: '  const toolCallIdsWithApprovalResponses = new Set(',
      text: ['  // 先建"哪些 toolCall 已有审批响应"的索引：后面只按 id 判断，避免在循环里反复扫描。'],
    },
    {
      at: 46,
      expect: '  for (const part of content) {',
      text: [
        '  // 遍历 provider 内容并逐项映射。这里不改变顺序，tool 相关的配对信息通过查找补齐，',
        '  // 因此 provider 的原始顺序就是最终顺序（见 INV-01）。',
      ],
    },
    {
      at: 48,
      expect: "      case 'text':",
      text: [
        '      // 纯内容 part 直接透传：text / reasoning / custom / source 的字段在 SDK 侧',
        '      // 与 provider 侧同名同义，无需重建对象，避免无谓的字段丢失。',
      ],
    },
    {
      at: 55,
      expect: "      case 'file':",
      text: [
        '      // [资源] 文件数据可能是 base64、URL 或惰性可读的流：统一走 resolveGeneratedFileData，',
        '      // 由它负责按需读取与缓存；这里必须 await，否则会把未解析的句柄塞进消息。',
        '      // DefaultGeneratedFile 包装后，上层拿到的始终是可直接取 base64 的对象。',
      ],
    },
    {
      at: 74,
      expect: "      case 'tool-call': {",
      text: [
        '      // tool-call 用 id 关联到解析阶段产出的 TypedToolCall：解析阶段已经完成 schema 校验、',
        '      // 修复与 refinement，直接使用它可避免二次解析出不同结果。',
      ],
    },
    {
      at: 79,
      expect: '        if (toolCall == null) {',
      text: [
        '        // [失败路径] 找不到对应 toolCall 说明解析阶段漏项，属于内部一致性错误：',
        '        // 抛错让整次生成失败，好过静默丢失一条调用（后续消息会缺配对结果）。',
      ],
    },
    {
      at: 87,
      expect: "      case 'tool-result': {",
      text: [
        '      // provider 自己执行的工具结果（如代码解释器）：需要补齐 input 等字段，',
        '      // 因为它们不会走本地 executeToolCall。',
      ],
    },
    {
      at: 96,
      expect: '        if (toolCall == null) {',
      text: [
        '        // 延迟结果：服务端工具触发的客户端工具，结果可能落到后续 turn，',
        '        // 当前响应里没有对应 tool-call 是合法状态，但只有声明 supportsDeferredResults 的',
        '        // provider 工具才允许（见 INV-03）。',
      ],
    },
    {
      at: 106,
      expect: '          if (part.isError) {',
      text: [
        '          // 延迟的错误结果同样要保留 providerMetadata 与工具元数据：',
        '          // 下游要靠它们判断是哪个服务端工具产生的结果。',
      ],
    },
    {
      at: 142,
      expect: '        if (part.isError) {',
      text: [
        '        // 有 tool-call 的普通结果：input 取自已解析调用，保证与执行时看到的一致；',
        '        // error 与正常输出在这里分流成两种 part，但共用同一套元数据。',
      ],
    },
    {
      at: 178,
      expect: "      case 'tool-approval-request': {",
      text: ['      // 审批请求必须能反查到 toolCall：否则用户批准后也无法执行，属于历史不一致。'],
    },
    {
      at: 183,
      expect: '        if (toolCall == null) {',
      text: [
        '        // [失败路径] 用专门的 ToolCallNotFoundForApprovalError：调用方可以据此区分',
        '        // "工具不存在"与"审批引用的调用不存在"，前者可修复，后者只能报错。',
      ],
    },
    {
      at: 200,
      expect: '  for (const toolOutput of toolOutputs) {',
      text: [
        '  // 工具输出按"是否已有审批响应"分成两段：有审批的必须排在审批事件之后，',
        '  // 无审批的紧跟在内容后面，保持 provider 看到的历史顺序自然。',
      ],
    },
    {
      at: 208,
      expect: '  return [',
      text: [
        '  // 最终顺序：内容 → 无审批工具输出 → 审批请求 → 审批响应 → 有审批工具输出。',
        '  // 这个顺序是下游消息组装与 provider 回灌的共同契约；改动它会让',
        '  // "先有决定、后有结果"的因果链断裂（见 INV-04）。',
        '  // 不要为了"看起来更整齐"把审批事件提前到内容之前：部分 provider 要求',
        '  // tool-call 必须先于它的审批事件出现。',
      ],
    },
  ],

  'packages/ai/src/generate-text/to-response-messages.ts': [
    {
      at: 1,
      expect: 'import type {',
      text: [
        '// 把一次生成的内容 part 还原成可回灌给模型的消息历史（assistant + tool 两条消息）。',
        '//',
        '// 链路位置：generateText / streamText 每步结束后调用；上游是 convertLanguageModelContent',
        '// 产出的 ContentPart，下游是下一次请求的 messages 与结果对象上的 responseMessages。',
        '//',
        '// INV-01：source part 永远不回灌：它是 provider 返回的引用信息，多数 provider 不接受',
        '// 把它作为输入，写回会直接 400。',
        '// INV-02：非 provider 执行的 tool-result / tool-error 必须放进 tool 消息，不能混进',
        '// assistant 内容；混进去会让 provider 看到"assistant 自己给自己结果"。',
        '// INV-03：tool 消息内的结果顺序必须与 assistant 中 tool-call 的出现顺序一致：',
        '// 部分 provider 按位置而非 id 配对，乱序会被判为消息不完整。',
        '// INV-04：被拒绝的审批必须补一条 execution-denied 的 tool-result，',
        '// 否则该 tool-call 永远缺结果，历史无法继续。',
        '// INV-05：空文本只有在带 providerMetadata 时才保留：某些 provider 用空文本承载',
        '// 缓存/签名等元数据，丢掉会破坏后续请求。',
      ],
    },
    {
      at: 24,
      expect: '  const responseMessages: Array<AssistantModelMessage | ToolModelMessage> = [];',
      text: ['  // 两条消息分别累积：assistant 内容（模型说了什么）与 tool 内容（工具返回了什么）。'],
    },
    {
      at: 25,
      expect: '  const toolCallOrder = new Map<string, number>();',
      text: ['  // tool-call 的首次出现顺序：用于给 tool 结果排序，保证 INV-03。'],
    },
    {
      at: 27,
      expect: '  const content: AssistantContent = [];',
      text: [
        '  // 第一遍只处理 assistant 侧内容，跳过三类不应回灌的 part；',
        '  // 显式标注 AssistantContent 类型，保证每个 case 产出都符合协议形状。',
      ],
    },
    {
      at: 28,
      expect: '  for (const part of inputContent) {',
      text: ['  // 第一遍只处理 assistant 侧内容，跳过三类不应回灌的 part。'],
    },
    {
      at: 30,
      expect: "    if (part.type === 'source') {",
      text: ['    // source 是响应专属内容：保留在结果对象里给 UI 用，但不进入下一次请求。'],
    },
    {
      at: 35,
      expect: '    if (',
      text: [
        '    // 本地执行的工具结果单独收集到 tool 消息；provider 执行的结果留在 assistant 内容里，',
        '    // 因为对 provider 来说那是它自己产出的一部分。',
      ],
    },
    {
      at: 43,
      expect: '    if (',
      text: ['    // 空文本默认丢弃（多数 provider 不接受空 text part），但带 providerMetadata 时必须保留。'],
    },
    {
      at: 51,
      expect: '    switch (part.type) {',
      text: [
        '    // 逐类映射到 AssistantContent：字段名从 SDK 的 providerMetadata 改为',
        '    // 消息协议的 providerOptions，这是两套结构的唯一差异。',
      ],
    },
    {
      at: 53,
      expect: "      case 'text':",
      text: [
        '      // 文本原样保留，只改字段名；不要做 trim 或合并，',
        '      // 空白在部分 provider 的模板里是有语义的。',
      ],
    },
    {
      at: 59,
      expect: "      case 'custom':",
      text: ['      // custom part 保留 kind：provider 用它区分自定义内容的种类，丢了就无法还原。'],
    },
    {
      at: 66,
      expect: "      case 'reasoning':",
      text: ['      // reasoning 只有文本，没有 file 形态；带文件的走下一个分支。'],
    },
    {
      at: 73,
      expect: "      case 'file':",
      text: [
        '      // [资源] 文件以 base64 回灌：消息协议不接受流或 URL，',
        '      // 因此这里必须已经完成数据解析（由 convertLanguageModelContent 保证）。',
      ],
    },
    {
      at: 81,
      expect: "      case 'reasoning-file':",
      text: ['      // reasoning-file 与 file 结构相同但语义不同：provider 靠 type 区分，不能合并。'],
    },
    {
      at: 89,
      expect: "      case 'tool-call':",
      text: ['      // tool-call 记录首次出现顺序；同一 id 重复出现时保留最早的位置。'],
    },
    {
      at: 90,
      expect: '        if (!toolCallOrder.has(part.toolCallId)) {',
      text: ['        // 只记第一次：修复/重试可能让同一调用出现多次，顺序以最早一次为准。'],
    },
    {
      at: 97,
      expect: '          input:',
      text: [
        '          // invalid 且 input 不是对象时回填 {}：provider 的消息协议要求 input 是对象，',
        '          // 而校验失败时我们可能只有一个原始字符串，直接写回会让下一次请求本身失败。',
      ],
    },
    {
      at: 103,
      expect: "      case 'tool-result': {",
      text: [
        '      // provider 执行的 tool-result：错误也以 result 形式回灌（errorMode: none），',
        '      // 因为 provider 已经知道这是错误结果，不需要再套一层错误结构。',
      ],
    },
    {
      at: 120,
      expect: "      case 'tool-error': {",
      text: [
        '      // 本地工具错误回灌成 tool-result（而非 tool-error）：消息协议里没有独立的错误 part，',
        '      // 用 errorMode: json 把错误序列化成结构化输出。',
      ],
    },
    {
      at: 137,
      expect: "      case 'tool-approval-request':",
      text: [
        '      // 审批请求要带上 schema 原始输入：当修复/转换改变了 input 时，',
        '      // 把原始值一并回灌，provider 才能对齐它自己发出的参数。',
      ],
    },
    {
      at: 155,
      expect: '  if (content.length > 0) {',
      text: ['  // assistant 消息只在有内容时创建：空 assistant 消息会被部分 provider 拒绝。'],
    },
    {
      at: 162,
      expect: '  const toolResultContent: ToolContent = [];',
      text: ['  // 第二遍收集 tool 侧内容，顺序与 assistant 的 tool-call 不同步，最后统一排序。'],
    },
    {
      at: 164,
      expect: '    if (',
      text: ['    // 只关心审批响应与本地工具结果/错误；其它 part 已经在第一遍处理过。'],
    },
    {
      at: 172,
      expect: "    if (part.type === 'tool-approval-response') {",
      text: ['    // 审批响应本身就是一条 tool 内容；拒绝时还要补 execution-denied 结果（见 INV-04）。'],
    },
    {
      at: 181,
      expect: '      // when the tool approval is denied,',
      text: [
        '      // 被拒绝的调用不会执行，因此没有任何工具结果可写；补一条 execution-denied',
        '      // 让消息历史保持"每个 tool-call 都有结果"的闭合性。',
      ],
    },
    {
      at: 198,
      expect: '    if (part.providerExecuted) {',
      text: ['    // provider 执行的结果在第一遍已经写进 assistant 内容，这里跳过避免重复。'],
    },
    {
      at: 202,
      expect: '    const output = await createToolModelOutput({',
      text: [
        '    // 本地执行的正常结果与错误统一走 createToolModelOutput：',
        '    // 它负责按工具声明把任意 output 序列化成 provider 可接受的结构。',
      ],
    },
    {
      at: 221,
      expect: '  if (toolResultContent.length > 0) {',
      text: ['  // tool 消息只在有内容时创建；空 tool 消息同样会被 provider 拒绝。'],
    },
    {
      at: 234,
      expect: 'function sortToolResultContentByToolCallOrder({',
      text: [
        '// 按 tool-call 在 assistant 中出现的顺序重排 tool 结果（INV-03）。',
        '// 审批响应等非 tool-result part 保持原位，只替换 tool-result 的槽位，',
        '// 这样既有顺序保证，又不会把审批事件挤到错误位置。',
      ],
    },
    {
      at: 241,
      expect: '  const sortedToolResults = toolResultContent',
      text: [
        '  // 先抽出所有 tool-result 并记住原始下标：排序后按槽位回填，',
        '  // 非 tool-result part 的位置因此完全不变。',
      ],
    },
    {
      at: 248,
      expect: '      if (aOrder == null && bOrder == null) {',
      text: ['      // 找不到顺序号的（例如延迟结果）排到最后；两者都没有时退回原始下标，保证稳定排序。'],
    },
    {
      at: 264,
      expect: '  let toolResultIndex = 0;',
      text: ['  // 回填：按原数组顺序遇到 tool-result 就取下一个已排序项，其余 part 原样输出。'],
    },
  ],

  'packages/ai/src/generate-text/prune-messages.ts': [
    {
      at: 1,
      expect: 'import type {',
      text: [
        '// 消息裁剪：按配置移除历史中的 reasoning 与 tool 相关内容，控制上下文长度。',
        '//',
        '// 链路位置：prompt 组装前、请求发出之前调用；上游是用户传入的 messages，',
        '// 下游是 convertToLanguageModelPrompt。它只删不增，且必须保持 tool-call 与',
        '// tool-result 的配对关系。',
        '//',
        '// INV-01：任何被保留的 tool-result 都必须有对应的 tool-call，反之亦然；',
        '// 裁剪后出现孤立 part 会让 provider 直接拒绝请求。',
        '// INV-02：tool 名解析必须跨消息全局建表：审批响应与请求分属不同消息，',
        '// 按单条消息解析会留下孤立的审批响应。',
        '// INV-03：连续 reasoning part 视为一个整体：只删掉其中一部分会破坏 provider 的',
        '// reasoning item 边界。',
      ],
    },
    {
      at: 36,
      expect: '  // filter reasoning parts:',
      text: ['  // 第一步处理 reasoning：这一步独立于 tool 裁剪，先做可以简化后续的下标判断。'],
    },
    {
      at: 37,
      expect: "  if (reasoning === 'all' || reasoning === 'before-last-message') {",
      text: ['  // before-last-message 只看最后一条消息是否保留；all 则全量删除。'],
    },
    {
      at: 48,
      expect: '      return {',
      text: ['      // 重建消息而不是原地修改：调用方的 messages 数组必须保持不变（可能被复用）。'],
    },
    {
      at: 57,
      expect: '  // filter tool calls, results, errors, and approvals:',
      text: ['  // 第二步处理 tool 相关内容：先把多种写法（字符串/数组）归一成数组，后续只处理一种形态。'],
    },
    {
      at: 68,
      expect: '  for (const toolCall of toolCalls) {',
      text: ['  // 每一组 tool 裁剪规则独立执行；规则之间可能重叠，但最终以 keepParts 的并集为准。'],
    },
    {
      at: 70,
      expect: '    const keepLastMessagesCount =',
      text: [
        '    // 解析"保留最后 N 条消息"：all 表示不保留（undefined），',
        '    // before-last-N-messages 从字符串中截出 N。',
      ],
    },
    {
      at: 81,
      expect: '    // scan kept messages to identify tool calls and approvals that need to be kept:',
      text: [
        '    // 先扫描需要保留的区间，收集其中的 toolCallId 与 approvalId：',
        '    // 这些 id 对应的 part 无论规则如何都必须留下。',
      ],
    },
    {
      at: 85,
      expect: '    if (keepLastMessagesCount != null && keepLastMessagesCount !== 0) {',
      text: ['    // 注意 0 与 undefined 的区别：0 表示"不保留任何尾部消息"，不能被当成 falsy 跳过。'],
    },
    {
      at: 105,
      expect: '    // Build global maps from tool call id and approval id to tool name.',
      text: ['    // 全局 id → toolName 映射：审批响应与请求分属不同消息，只有跨消息建表才能解析（见 INV-02）。'],
    },
    {
      at: 126,
      expect: '    const approvalIdToToolCallId = new Map<string, string>();',
      text: ['    // approvalId → toolCallId 的映射用于"审批保留则其调用也必须保留"的传递闭包。'],
    },
    {
      at: 146,
      expect: '    // Approval requests depend on their originating tool call. When an',
      text: [
        '    // 审批与调用是配对关系：保留审批响应时必须把它的 tool-call 一起留下，',
        '    // 否则会出现"批准了一个不存在的调用"。',
      ],
    },
    {
      at: 149,
      expect: '    for (const approvalId of keptApprovalIds) {',
      text: ['    // 一轮闭包即可：toolCallId 不会反向依赖 approvalId，不存在多级传递。'],
    },
    {
      at: 156,
      expect: '    messages = messages.map((message, messageIndex) => {',
      text: ['    // 对每条消息逐 part 计算去留：先按 id 保留，再按工具名规则过滤。'],
    },
    {
      at: 166,
      expect: '      const keepParts = message.content.map(part => {',
      text: ['      // keepParts 与 content 一一对应；最后统一 filter，避免边遍历边修改数组。'],
    },
    {
      at: 177,
      expect: '        // keep parts that are associated with a tool call or approval that needs to be kept:',
      text: ['        // 与保留集合关联的 part 直接留下：这是 INV-01 的配对保证。'],
    },
    {
      at: 188,
      expect: '        // keep parts that are not associated with a tool that should be removed:',
      text: [
        '        // 工具名无法解析（例如孤立的审批响应）时保守保留：',
        '        // 宁可多留一条，也不制造会让请求失败的孤立 part。',
      ],
    },
    {
      at: 201,
      expect: '      // Consecutive reasoning parts can belong to the same provider item.',
      text: [
        '      // reasoning 组处理：连续 reasoning part 属于同一个 provider item，',
        '      // 若它们后面的内容全部被裁掉，这组 reasoning 也必须一起删除（见 INV-03）。',
      ],
    },
    {
      at: 226,
      expect: '          let followingPartIndex = reasoningEndIndex;',
      text: ['          // 找这组 reasoning 之后、下一组 reasoning 之前的所有 part，判断是否还有被保留的内容。'],
    },
    {
      at: 244,
      expect: '          if (hasFollowingPart && !hasKeptFollowingPart) {',
      text: [
        '          // 整组后面都没有保留内容：把整组 reasoning 标记为删除，',
        '          // 避免残留半组导致 provider 解析失败。',
      ],
    },
    {
      at: 254,
      expect: '          reasoningIndex = followingPartIndex - 1;',
      text: ['          // 跳过已处理过的 reasoning 组，从下一组起点继续。'],
    },
    {
      at: 265,
      expect: "  if (emptyMessages === 'remove') {",
      text: ['  // 最后按配置清理空消息：content 被裁空的消息留着会让部分 provider 报错。'],
    },
  ],

  'packages/ai/src/generate-text/default-generate-text-result.ts': [
    {
      at: 1,
      expect: 'import type { Context, ToolSet } from',
      text: [
        '// generateText 的默认结果对象：把多步 step 结果聚合成一个只读视图。',
        '//',
        '// 链路位置：generate-text.ts 在完成全部 step 后构造并返回给调用方；',
        '// 它不持有流、不做计算，只做字段聚合。所有 getter 都是惰性的，',
        '// 调用方按需取用，避免一次性物化大数组。',
        '//',
        '// INV-01：finalStep 恒等于 steps 的最后一项，且 steps 至少有一项；',
        '// 构造方必须保证这一点（守住它的位置：finalStep getter 的非空断言）。',
      ],
    },
    {
      at: 15,
      expect: '  readonly steps: GenerateTextResult<TOOLS, RUNTIME_CONTEXT, OUTPUT>',
      text: [
        '  // steps 与 totalUsage 在构造时固定：结果对象对外是只读快照，',
        '  // 不应在返回后被上游继续修改。',
      ],
    },
    {
      at: 33,
      expect: '  get finalStep() {',
      text: [
        '  // [失败路径] 非空断言依赖构造契约：steps 为空说明上层在没有任何 step 时就构造结果，',
        '  // 这是实现错误，宁可在这里抛 TypeError 也不要返回 undefined 让调用方在远处崩溃。',
      ],
    },
    {
      at: 37,
      expect: '  get content() {',
      text: ['  // 跨 step 聚合：content 是所有步骤的内容拼接，顺序即执行顺序。'],
    },
    {
      at: 41,
      expect: '  get text() {',
      text: [
        '  // 单步字段只取最后一步：text / reasoning / finishReason 等描述的是"最终产出"，',
        '  // 把多步文本拼起来会得到重复或中间草稿。',
      ],
    },
    {
      at: 45,
      expect: '  get files() {',
      text: ['  // files 跨 step 聚合：每个 step 都可能产生文件（图片、音频），全部保留。'],
    },
    {
      at: 49,
      expect: '  get reasoningText() {',
      text: ['  // reasoning 在返回前做一次格式转换：内部保留结构化 reasoning，对外暴露稳定的 ReasoningOutput 形状。'],
    },
    {
      at: 57,
      expect: '  get toolCalls() {',
      text: ['  // 工具调用与结果按 step 顺序聚合：下游按 toolCallId 关联，不依赖数组全局唯一。'],
    },
    {
      at: 69,
      expect: '  get toolResults() {',
      text: ['  // 静态/动态工具分开聚合，便于调用方按类型窄化；两者都来自各 step 的同类字段。'],
    },
    {
      at: 81,
      expect: '  get sources() {',
      text: ['  // source 只来自模型响应，跨 step 聚合后仍保持原始出现顺序。'],
    },
    {
      at: 85,
      expect: '  get finishReason() {',
      text: ['  // finishReason / rawFinishReason 取最后一步：它们描述整次生成如何结束。'],
    },
    {
      at: 93,
      expect: '  get warnings() {',
      text: ['  // warnings 跨 step 聚合，缺失时用空数组兜底：调用方不应处理 undefined。'],
    },
    {
      at: 97,
      expect: '  get providerMetadata() {',
      text: ['  // providerMetadata 取最后一步：多数 provider 只在最后一次响应里给最终元数据。'],
    },
    {
      at: 101,
      expect: '  get response() {',
      text: ['  // response 取最后一步的原始响应，供需要 provider 原始字段的高级用法读取。'],
    },
    {
      at: 105,
      expect: '  get responseMessages() {',
      text: [
        '  // responseMessages 是"初始消息 + 每个 step 新增消息"：这正是下一轮请求要回灌的历史，',
        '  // 少了 initialResponseMessages 会丢掉调用方自己传入的上下文。',
      ],
    },
    {
      at: 112,
      expect: '  get request() {',
      text: ['  // request 取最后一步：它对应最终生效的那次请求参数。'],
    },
    {
      at: 116,
      expect: '  get usage() {',
      text: ['  // usage 返回累计值而不是最后一步：计费与配额判断都需要整次生成的总量。'],
    },
    {
      at: 120,
      expect: '  get output() {',
      text: [
        '  // [失败路径] output 未生成时抛 NoOutputGeneratedError，而不是返回 undefined：',
        '  // 让"忘了配置 output"在读取点立刻暴露，避免 undefined 流到业务层。',
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
