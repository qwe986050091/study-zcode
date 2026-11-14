import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/ui/convert-to-model-messages.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    at: 0,
    expect: 'import {',
    text: [
      '// 【职责】把 useChat 持有的 UI 消息（面向渲染，含流式状态与审批信息）',
      '//   转换为模型侧 ModelMessage（面向 provider，只含已确定的语义）。',
      '//',
      '// 【在链路中的位置】上游是 Chat 状态机（ui/chat.ts）：它把流式 chunk 归并成',
      '//   UIMessage[]；下游是 streamText / generateText 的 prompt 组装',
      '//   （prompt/convert-to-language-model-prompt.ts）。本文件是两者的唯一桥。',
      '//   因此这里任何"多带一点信息"或"少带一点信息"的改动，都会直接改变',
      '//   发给模型的报文，而不会在 UI 上体现，排查时极易被忽略。',
      '//',
      '// 【不变量】',
      '//   INV-01 工具调用与其结果必须成对出现，且顺序为 call 在前、result 在后。',
      '//     守住位置：assistant 分支的 content.push 与后面的 tool 消息构造。',
      '//   INV-02 每个 assistant 块（block）内的 part 顺序原样保留，不得重排。',
      '//     守住位置：processBlock 内对 block 的 for 循环。',
      '//   INV-03 被过滤掉的 part 不对应任何模型侧片段，也不会被"补一个空片段"。',
      '//     守住位置：函数开头的 messages.map 过滤。',
      '//   INV-04 providerExecuted 的工具结果只出现在 assistant content，',
      '//     不得再进 tool 消息，否则 provider 侧会出现孤儿 function_call_output。',
      '//     守住位置：toolParts 循环中的 providerExecuted 提前 continue。',
      '//   INV-05 data-* part 只有调用方提供 convertDataPart 时才进入模型报文。',
      '//     守住位置：user 分支与 processBlock 中的 isDataUIPart 分支。',
      '//',
      '// 【坑】这个函数是 async 的，但绝大多数分支不 await；唯一真正异步的是',
      '//   createModelOutput（内部可能触发工具的 output schema 转换）。',
      '//   因此"块内顺序"依赖 for-await 串行，不能改成 Promise.all 并行 push。',
    ],
  },
  {
    find: 'export async function convertToModelMessages<UI_MESSAGE extends UIMessage>(',
    text: [
      '// STEP-1 入口：先做一次整体告警扫描，再决定是否裁剪未完成的工具调用；',
      '//   两步都在任何转换之前完成，保证后面各分支看到的是同一个快照。',
    ],
  },
  {
    find: 'const modelMessages: ModelMessage[] = [];',
    text: [
      '// 输出是"一条 UI 消息可能裂成多条模型消息"的结构：assistant 块会被切成',
      '//   若干 assistant + tool 消息对，因此这里只能累加，不能按输入下标对应。',
      '// 该数组是唯一输出，函数内不再回读，避免中途修改已产出的片段。',
    ],
  },
  {
    find: 'warnIfUIMessageHasDeprecatedRawInput(messages);',
    text: [
      '// 只告警不修改：rawInput 仍可被后续兜底逻辑读取（见 output-error 分支），',
      '//   在此处清理会丢失降级展示所需的原始文本。',
    ],
  },
  {
    find: 'const lastUserMessageIndex = messages.reduce(',
    text: [
      '// 先定位"最后一条用户消息"，它是一条边界：该边界之前未决的审批请求视为',
      '//   已被用户放弃（继续追问即代表放弃），必须丢弃而不是留给模型。',
      '// 用 reduce 而非 findLastIndex，是为了在旧运行时上也能工作，且一次遍历。',
      '// 边界是 -1 表示没有用户消息，此时不做任何审批裁剪。',
    ],
  },
  {
    find: 'if (options?.ignoreIncompleteToolCalls || lastUserMessageIndex > 0) {',
    text: [
      '// 两个开关在此合并成一次过滤，语义要分开看：',
      '//   1) 审批请求：只保留"位于最后用户消息及其之后"的，其余丢弃；',
      '//   2) ignoreIncompleteToolCalls：只保留已进入终态的工具调用，',
      '//      preliminary 的输出视为未完成，也要排除。',
      '// 过滤是浅拷贝 message，parts 换新数组，原始输入不被修改。',
      '// 注意 messageIndex >= lastUserMessageIndex 用的是 >=，',
      '//   即最后一条用户消息自身的审批请求仍然保留。',
      '// 顺序断言依赖 isToolUIPart 的类型收窄，不能先 map 再 filter。',
      '// 若两个开关都为假，整个裁剪跳过，避免无意义的数组复制。',
      '// 这里不做"补一个占位 part"，因为模型不需要知道 UI 上有未决状态。',
      '// 被丢弃的审批请求若已被服务端记录，需由服务端自行清理，本层无责。',
    ],
  },
  {
    find: 'async function createModelOutput({',
    text: [
      '// 工具输出在模型侧有两种形态：结构化输出或错误文本，由 errorMode 决定。',
      '// "工具已下线"是一个特殊兜底：仅当不是错误模式且确实找不到工具时，',
      '//   才用一段说明文本代替原输出，避免把未知结构塞给 provider。',
      '// 其余情况全部委托 createToolModelOutput，本文件不重复其判定逻辑。',
      '// 该函数是块内唯一的异步点，调用处必须 await，否则顺序会乱。',
    ],
  },
  {
    find: 'for (const message of messages) {',
    text: [
      '// 逐条消息串行转换；assistant 分支内部还会再切块并可能产出多条消息。',
      '// 不支持的角色走 default 抛错，而不是静默跳过，避免消息丢失难以定位。',
    ],
  },
  {
    find: "case 'system': {",
    text: [
      '// system 消息把所有 text part 拼成一个字符串：模型协议不支持分段 system。',
      '// providerMetadata 跨 part 合并，后出现的键覆盖先出现的，',
      '//   这是唯一允许"覆盖"的位置，因 system 只有一份内容。',
    ],
  },
  {
    find: "case 'user': {",
    text: [
      '// user 消息保留分段结构（文本与文件可交错），因此用数组 content。',
      '// 无法识别的 part（如 reasoning、tool）直接丢弃：用户侧不应出现这些，',
      '//   但历史数据可能残留，静默丢弃比抛错更利于容错。',
      '// data part 需要调用方显式提供转换函数，否则不进入模型报文。',
    ],
  },
  {
    find: "case 'assistant': {",
    text: [
      '// assistant 是唯一需要"切块"的角色：step-start 与 steering-message',
      '//   是块边界，一个 block 产出一组 assistant + tool 消息。',
      '// 切块的目的是让每一步的工具调用/结果紧随其对应的 assistant 片段，',
      '//   而不是把整轮内容压成一条消息。',
      '// message.parts 为 null 时整条消息被跳过（类型上允许，历史数据常见）。',
    ],
  },
  {
    find: 'async function processBlock() {',
    text: [
      '// STEP-2 收口一个块：先把块内 part 转成 assistant content 并 push，',
      '//   再单独收集需要结果的工具调用，生成一条 tool 消息。',
      '// 为什么分两次遍历：assistant 消息必须先于 tool 消息入列，',
      '//   且 tool 消息只包含"需要本地回填结果"的调用。',
      '// 空块直接返回，不产出空消息，避免 provider 收到 content: []。',
      '// 结束时清空 block，是本函数唯一的副作用；调用方负责在边界处调用。',
      '// 该函数闭包捕获 modelMessages，因此不能并发调用（会打乱顺序）。',
      '// content.length 为 0 时仍可能产出 tool 消息（例如全是 tool part），',
      '//   两个 push 是独立的，不要合并判断。',
      '// 若某 part 类型不在白名单内，由循环后的 never 检查兜底报错。',
    ],
  },
  {
    find: 'const content: AssistantContent = [];',
    text: [
      '// content 是本次块产出的 assistant 内容，元素顺序即 part 顺序（INV-02）。',
      '// 此处不做合并/去重：相邻 text part 保持分离，provider 侧会自行拼接。',
    ],
  },
  {
    find: '} else if (isToolUIPart(part)) {',
    text: [
      '// 工具调用是转换中最容易出错的片段，规则如下：',
      '//   1) input-streaming 的调用不发给模型：参数不完整，发了只会引发解析错误；',
      '//   2) output-error 时 input 可能缺失，回退到 rawInput（原始文本），',
      '//      这是唯一允许把字符串当 input 的地方，兼容历史数据；',
      '//   3) callProviderMetadata 优先用调用阶段的元数据，',
      '//      仅 output-error 时回退到结果阶段元数据（错误来自 provider 侧）；',
      '//   4) 审批信息紧跟 tool-call 之后发出，保证模型能按 approvalId 关联；',
      '//   5) providerExecuted 的终态结果直接附在 assistant content，',
      '//      不再另发 tool 消息（INV-04）。',
      '// 这些分支的判断顺序有意义：先判 state 再判 providerExecuted，',
      '//   否则 approval-responded 会被误当成已完成而重复输出结果。',
      '// 不要为了"简洁"把 1) 与 5) 合并，二者边界不同（前者是入参，后者是出参）。',
    ],
  },
  {
    find: 'if (part.approval != null) {',
    text: [
      '// 审批请求是独立片段，不带工具结果；它的存在意味着该调用被挂起。',
      '// inputSchemaInput 用 hasOwnProperty 判断而非 != null：',
      '//   null 也是有效值，表示"显式重建为 null"，不能被当成缺省丢弃。',
      '// requestReason 映射为 reason，字段名在模型侧统一为 reason。',
    ],
  },
  {
    find: 'part.providerExecuted === true &&',
    text: [
      '// provider 侧已执行的工具，其输出必须由 provider 自己回传，',
      '//   本地只做"透传"：把已有输出作为 tool-result 附在 assistant content。',
      '// 三个条件缺一不可：已执行、不是待审批、已到终态。',
      '// 元数据优先取 resultProviderMetadata，回退到 callProviderMetadata，',
      '//   与下面的 tool 消息分支保持一致，避免同一次调用出现两套元数据。',
      '// 该分支不写 tool 消息，因此不会与 INV-04 冲突。',
    ],
  },
  {
    find: 'const toolParts = block.filter(',
    text: [
      '// 需要生成 tool 消息的调用：本地执行的（providerExecuted 不为 true），',
      '//   或虽有审批但已明确批准/拒绝的（此时结果语义由本地补齐）。',
      '// 只在此处判定"是否属于 tool 消息"，后续 switch 不再重复该判断。',
      '// 注意审批响应本身也要写进 tool 消息，故不能只按 state 过滤。',
      '// 过滤结果保留块内顺序，tool 结果顺序与调用顺序一致（INV-01）。',
    ],
  },
  {
    find: 'if (toolParts.length > 0) {',
    text: [
      '// 一个块最多产出一条 tool 消息，所有结果/审批响应都塞进同一 content 数组。',
      '// 分开成多条 tool 消息会改变部分 provider 的配对语义，不要"按调用拆分"。',
      '// 若 content 最终为空（例如全部被 providerExecuted 跳过），则不 push。',
    ],
  },
  {
    find: 'switch (toolPart.state) {',
    text: [
      '// 终态到模型输出的映射：拒绝执行也必须有结果，否则调用会悬空。',
      '// output-denied 生成 error-text 而非结构化输出，是刻意保留的降级路径。',
    ],
  },
  {
    find: 'for (const part of message.parts) {',
    text: [
      '// STEP-3 切块驱动：白名单 part 进当前块，边界 part 触发收口。',
      '// steering-message 是"两步之间插入的用户发言"，因此先收口当前块，',
      '//   再把它自己作为一条 user 消息插入，最后继续后续块。',
      '// 顺序不能反：先插入 user 消息会把上一块的工具结果排到它后面。',
      '// 循环结束后必须再调用一次 processBlock，处理最后一个块。',
      '// 未识别的 part 类型被忽略（不 push 也不报错），这是容错而非遗漏。',
      '// 块内只做收集，不做转换，转换统一在 processBlock 中完成。',
    ],
  },
  {
    find: 'function convertUserContentUIPart(',
    text: [
      '// 用户侧 part 的映射被抽出来，供 user 分支与 steering-message 共用。',
      '// 文件优先用 providerReference（provider 已托管），否则转成 URL 对象；',
      '//   URL 构造失败会抛错，这是有意的：非法 url 不该进入模型报文。',
      '// 与 assistant 侧文件处理不同的是：这里不支持 reasoning-file。',
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
