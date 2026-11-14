import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/prompt/convert-to-language-model-prompt.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  { at: 0, expect: 'import type {', text: [
    '// 【职责】把 StandardizedPrompt（ModelMessage 形态）转换成 provider 可消费的',
    '//   LanguageModelV4Prompt：角色映射、内容片段归一化、远程资源下载与内联、',
    '//   工具调用/结果的形状转换，并在此阶段校验调用与结果是否配对。',
    '//',
    '// 【在链路中的位置】上游是 generateText/streamText 的 prompt 标准化；',
    '//   下游是 provider 的 doGenerate/doStream。所有 provider 共享这一份转换，',
    '//   因此这里的行为等价于 SDK 的协议语义。',
    '//',
    '// 【不变量】',
    '//   INV-01 每个未被 provider 执行的 tool-call 必须有对应的 tool-result。',
    '//     守住位置：toolCallIds 集合的增删与末尾的 MissingToolResultsError。',
    '//   INV-02 连续的 tool 消息必须合并成一条，否则部分 provider 会拒绝。',
    '//     守住位置：combine consecutive tool messages 的循环。',
    '//   INV-03 文件片段最终必须带 mediaType，缺失即抛错。',
    '//     守住位置：convertPartToLanguageModelPart 末尾的 mediaType 判空。',
    '//   INV-04 下载失败或 URL 不受支持时不得让请求静默变形。',
    '//     守住位置：convertPartToLanguageModelPart 的 url 分支与 mediaType 回填。',
    '//   INV-05 providerExecuted 的工具结果不参与配对校验，也不产生本地回填。',
    '//     守住位置：assistant 分支里的 providerExecuted 判断。',
  ] },
  { at: 35, expect: 'export async function convertToLanguageModelPrompt({', text: [
    '// STEP-1 预下载：只针对 user 消息与工具结果内容里的远程文件，',
    '//   按 provider 的 supportedUrls 决定哪些需要下载。',
    '// STEP-2 组装消息数组：instructions 统一转成 system 消息，且排在最前。',
    '// STEP-3 合并连续 tool 消息（INV-02）。',
    '// STEP-4 配对校验：遇到 user/system 边界时，之前未闭合的调用即视为缺失。',
    '// STEP-5 过滤空的 tool 消息（审批响应被移除后可能为空）。',
    '// provider 参数只为兼容已废弃的 file-id 系类型，新代码不应依赖它。',
  ] },
  { at: 50, expect: 'const downloadedAssets = await downloadAssets(', text: [
    '// 未提供 download 时用默认实现：平台支持时走 provider 的 URL 直传，',
    '//   否则下载为字节。abortSignal 透传，保证取消能中断下载。',
    '// 返回 URL 字符串到 {data, mediaType} 的映射，后续按字符串精确查找。',
    '// 预下载发生在消息转换之前，因此转换阶段不再有任何网络请求。',
    '// 这一步失败会让整个请求失败，而不是退化成不带该文件。',
  ] },
  { at: 56, expect: 'const messages = [', text: [
    '// instructions 有两种形态：单个字符串或消息数组（可带 providerOptions）。',
    '// 用展开语法把它们统一放在 prompt.messages 之前，保证 system 在最前。',
    '// 逐条转换是同步的：远程资源已在 STEP-1 落地。',
    '// 这里不合并相邻 system 消息，provider 侧通常自行处理。',
    '// 转换函数可能就地修改 providerOptions（见合并逻辑），因此 messages 是新数组。',
  ] },
  { at: 71, expect: '// combine consecutive tool messages into a single tool message', text: [
    '// 合并规则：连续 tool 消息的 content 直接拼接，providerOptions 取后者覆盖前者。',
    '// 为什么需要：一次 assistant 回复可能产生多个工具调用，模型消息里会裂成',
    '//   多条 tool 消息；多数 provider 要求它们是一条消息的多个 content。',
    '// providerOptions 的合并顺序容易被误读：目的是让最后一段携带整条消息的元数据，',
    '//   因为 provider 通常只读这一份。',
    '// 最后一段为空时退化为消息级合并，避免丢元数据。',
    '// 该循环不改变消息顺序，只压缩相邻同类项。',
  ] },
  { at: 105, expect: 'const toolCallIds = new Set<string>();', text: [
    '// 用集合追踪已发出但未见到结果的调用 id，而非计数：',
    '//   同一 id 重复出现时集合语义更符合配对的含义。',
    '// providerExecuted 的调用不入集合：结果由 provider 侧持有（INV-05）。',
    '// 结果出现即删除；删除不存在的 id 是空操作，容忍重复结果。',
    '// 集合的最终状态决定是否抛错。',
  ] },
  { at: 107, expect: 'for (const message of combinedMessages) {', text: [
    '// 顺序扫描而非两遍：一旦遇到 user/system 就检查当前未闭合集合，',
    '//   这样错误能指向缺结果的那一段，而不是笼统地在末尾报错。',
    '// assistant 只增集合，tool 只删集合，二者不对称是有意的。',
    '// 末尾再检查一次，覆盖最后一条就是 tool 缺失的情况。',
  ] },
  { at: 109, expect: "case 'assistant': {", text: [
    '// 只登记本地执行的调用；providerExecuted 的结果不由客户端提供。',
    '// 这里不校验工具名是否存在于工具集：转换层不做业务校验。',
    '// 同一 assistant 消息内可能有多个调用，按 content 顺序登记。',
  ] },
  { at: 117, expect: "case 'tool': {", text: [
    '// 结果一到即删除对应 id；审批响应等非 result 片段不影响配对。',
    '// 结果没有对应调用（id 不存在）时静默忽略，由 provider 决定是否报错。',
  ] },
  { at: 136, expect: 'if (toolCallIds.size > 0) {', text: [
    '// 收尾检查覆盖最后一条消息是 assistant（没有后续 tool 消息）的情况。',
    '// 错误里带完整 id 列表，便于调用方定位是哪几次调用缺结果。',
  ] },
  { at: 140, expect: 'return combinedMessages.filter(', text: [
    '// 过滤空的 tool 消息：审批响应在非 providerExecuted 时会被移除，',
    '//   此时消息可能变成 content: []，部分 provider 会直接拒绝。',
    '// 只过滤 tool 角色；空 assistant 消息保留（它可能承载 providerOptions）。',
    '// 返回新数组，原 combinedMessages 不被修改。',
  ] },
  { at: 156, expect: 'export function convertToLanguageModelMessage({', text: [
    '// 单条消息转换：按角色分派，返回全新的 LanguageModelV4Message。',
    '// system 直接透传；user/assistant/tool 需要逐片段转换。',
    '// user 会额外把已废弃的 image 片段改写为 file（见 convertImagePartToFilePart）。',
    '// assistant 会丢弃 tool-approval-request（它只对 UI 有意义）。',
    '// tool 只在 providerExecuted 时保留 tool-approval-response。',
    '// 所有废弃用法都会 push 到 warnings，最后由调用方统一记录。',
    '// default 分支用 never 兜底，新增角色时编译期失败。',
  ] },
  { at: 170, expect: 'const warnings: Warning[] = [];', text: [
    '// warnings 是本次消息转换的局部集合：可能为空，非空时在返回前统一 log。',
    '// 用局部数组而非全局单例，避免并发转换互相污染。',
    '// logWarnings 是副作用，转换函数本身仍保持同步。',
  ] },
  { at: 173, expect: 'switch (role) {', text: [
    '// 角色分派是穷尽的：ModelMessage 只有 system/user/assistant/tool 四种。',
    '// 不用 if 链是为了让 TypeScript 在 default 处收窄为 never。',
  ] },
  { at: 174, expect: "case 'system': {", text: [
    '// system 不做片段级转换：它的 content 本来就是字符串。',
    '// providerOptions 原样透传，由 provider 决定是否识别。',
    '// 这里不校验 content 非空：空 system 由调用方负责避免。',
  ] },
  { at: 182, expect: "case 'user': {", text: [
    '// 字符串形态直接包成一个 text 片段，省去逐片段处理。',
    '// 数组形态先统一成 file（兼容废弃 image），再转 provider 片段。',
    '// 最后过滤空 text：空的用户文本片段对模型无意义，且部分 provider 会报错。',
    '// 注意空 text 的 providerOptions 也会一起丢失——这是既有行为，不要试图修复。',
  ] },
  { at: 191, expect: 'const converted = {', text: [
    '// 先 map 成 file，再 map 成 provider 片段：两步分开是为了让类型收窄清晰。',
    '// 空 text 过滤放在最后，避免影响 file 片段。',
    '// warnings 可能在此累积，返回前统一记录。',
  ] },
  { at: 215, expect: "case 'assistant': {", text: [
    '// 先删空 text（既无文本也无 providerOptions 的片段），再删审批请求片段。',
    '// 两个 filter 顺序不能换：审批请求片段可能带 providerOptions，',
    '//   先删空 text 不会误删它，反之则可能让空 text 留下来。',
    '// 剩余片段逐个按 type 映射，switch 无 default：类型收敛后自然穷尽。',
    '// reasoning-file 只接受 data/url 两种 data 形态，reference 会抛错。',
    '// 工具结果在这里也会做 mapToolResultOutput，因此结果既可挂',
    '//   assistant 消息也可挂 tool 消息，两条路径必须保持一致。',
  ] },
  { at: 224, expect: 'const converted = {', text: [
    '// 逐片段转换是同步的，但 mapToolResultOutput 可能 push warnings。',
    '// 返回前统一记录 warnings，避免每个分支各写一次 log。',
    '// content 类型由 switch 的返回值联合自动推导，无需显式标注。',
  ] },
  { at: 333, expect: "case 'tool': {", text: [
    '// tool 消息只保留两类片段：tool-result 与（providerExecuted 的）审批响应。',
    '// 非 providerExecuted 的审批响应在这里被丢弃：它属于本地执行流程，',
    '//   不应出现在发给模型的报文里。',
    '// 结果同样走 mapToolResultOutput，与 assistant 分支共用实现。',
  ] },
  { at: 376, expect: 'default: {', text: [
    '// 编译期兜底：新增角色时此处赋值 never 失败，强制实现者补分支。',
    '// 运行时抛 InvalidMessageRoleError，便于区分未知角色与其它错误。',
  ] },
  { at: 390, expect: 'function convertImagePartToFilePart(', text: [
    '// 兼容层：把废弃的 image 片段改写成 file，默认 mediaType 为顶层类型 image。',
    '// 用默认值而非推断：调用方可能已显式传了更具体的 image/png。',
    '// 该函数在两个地方使用：消息转换与下载收集，保证两处口径一致。',
  ] },
  { at: 407, expect: 'export async function downloadAssets(', text: [
    '// 下载规划：只收集指向远程 URL 的文件，内联数据无需下载。',
    '// supportedUrls 用于判断 provider 能否直传 URL：能直传的仍会请求 download，',
    '//   由下载实现决定是跳过还是透传 URL，本层不替它决定。',
    '// 三个来源都要覆盖：user 消息、tool 消息的结果内容、assistant 消息的结果内容。',
    '// 后两者结构相同但角色不同，分别遍历而不是合并，保持可读性。',
    '// 返回以 URL 字符串为键，转换阶段用同一个字符串查找。',
    '// 下载是并行的，结果顺序与 plannedDownloads 对齐。',
    '// 返回 null 的条目表示下载实现选择不处理，最终被过滤掉。',
  ] },
  { at: 423, expect: 'const downloadableFiles: FilePart[] = [];', text: [
    '// 收集阶段只存 FilePart，不存 URL：归一化在后续 map 中完成。',
    '// 同一 URL 出现多次会重复收集，最终由 Object.fromEntries 去重（后者覆盖）。',
  ] },
  { at: 425, expect: 'for (const message of messages) {', text: [
    '// user 消息直接遍历 content；字符串形态没有文件，跳过。',
    '// 每进入一个分支都先做角色与数组判断，避免对字符串调用 for...of。',
    '// 只处理 content 型工具输出：json/text 型输出里没有文件。',
  ] },
  { at: 475, expect: 'const plannedDownloads = downloadableFiles', text: [
    '// 三步流水：归一化 data → 只留 url 型 → 构造下载计划。',
    '// isUrlSupportedByModel 需要 mediaType：缺失时一律视为不支持，走下载。',
    '// 计划里保留 url 对象而非字符串，供下载实现做平台特化处理。',
    '// mediaType 为顶层类型（如 image）时也可能被判为支持，由 isUrlSupported 决定。',
    '// 该数组的下标与下载结果一一对应，最后用下标回填 URL。',
    '// 不要在此处去重：重复下载由 download 实现自行优化。',
  ] },
  { at: 492, expect: '// download in parallel:', text: [
    '// 并行下载所有计划项；download 实现负责并发上限与重试。',
    '// 下载结果可能含 null（表示跳过），因此需要按下标过滤。',
    '// 失败会抛出而不是降级：缺文件会让模型看到不完整的输入。',
  ] },
  { at: 495, expect: 'return Object.fromEntries(', text: [
    '// 用 URL 字符串作键：转换阶段的查找也用它，保证同一资源能命中。',
    '// 先 map 出 [key, value] 或 null，再过滤 null，避免 undefined 键。',
    '// 后出现的同名 URL 覆盖先出现的：内容相同，覆盖无副作用。',
    '// Object.fromEntries 要求键为字符串，因此统一 toString。',
  ] },
  { at: 516, expect: 'function getDownloadableFilePart(', text: [
    '// 把工具结果里的内容片段归一成 FilePart，供统一下载与转换。',
    '// file-url 的 mediaType 可缺省，此时从 URL 扩展名推断（见 getMediaTypeFromUrl）。',
    '// image-url 固定 mediaType 为顶层 image，与废弃语义保持一致。',
    '// 其余类型（text/json 等）返回 undefined，表示不需要下载。',
  ] },
  { at: 547, expect: 'function resolveDownloadedFile({', text: [
    '// 统一处理下载过则用字节、否则保留 URL 的逻辑。',
    '// originalUrl 仅在 URL 规范化改变字符串时附带，便于 provider 还原原始地址。',
    '// 返回值只取 data 与 mediaType，其余字段由调用方补充。',
    '// 这里让 URL 片段走一遍完整的转换，因此 mediaType 推断与普通文件一致。',
  ] },
  { at: 585, expect: 'function convertPartToLanguageModelPart(', text: [
    '// user 侧片段的最终转换：text 直接透传，file 需要归一化 data 与 mediaType。',
    '// mediaType 优先级：data URL 自带 > 片段声明 > 下载结果 > 字节嗅探。',
    '// 下载命中时把 url 换成 data，避免 provider 再次拉取。',
    '// 仅当现有 mediaType 不是完整类型时才用下载结果覆盖，',
    '//   防止把调用方显式的 image/png 降级成 image。',
    '// 字节嗅探只针对 data 形态，且只在能识别出 image 子类型时生效。',
    '// 最终 mediaType 仍为空则抛错（INV-03）：provider 无法处理无类型文件。',
    '// 该函数不修改入参，返回全新片段。',
  ] },
  { at: 606, expect: "if (data.type === 'url') {", text: [
    '// 只有 url 形态才可能命中下载缓存；data/reference 无需处理。',
    '// 命中后替换为 data 型，原始 url 不再出现在报文里。',
    '// 未命中说明 provider 支持直传，或下载实现选择跳过。',
    '// mediaType 的回填条件刻意保守，见上一条注释。',
  ] },
  { at: 619, expect: 'if (', text: [
    '// 字节嗅探：仅对可读的字节或 base64 字符串尝试，避免无谓开销。',
    '// topLevelType 限定为 image，保证不会把 PDF 误判成图片。',
    '// 嗅探结果优先于调用方声明：它能纠正错误的 image 顶层类型。',
    '// 嗅探失败不报错，保留原 mediaType。',
  ] },
  { at: 632, expect: 'if (mediaType == null) {', text: [
    '// 走到这里说明既没声明、也没下载信息、也嗅探不出来：只能报错。',
    '// 错误文案不含具体片段，避免把文件内容带进日志。',
  ] },
  { at: 645, expect: 'export function mapToolResultOutput({', text: [
    '// 工具结果的输出转换：只处理 content 型，其余类型原样返回。',
    '// content 型的每个元素都按 type 映射，并统一把废弃类型转成 file。',
    '// 与消息片段转换的区别：这里还要处理 file-id/image-file-id 这类',
    '//   provider 引用型，需要 provider 名称才能构造 reference。',
    '// 所有废弃类型都会 push 一条 deprecated warning，包含迁移建议。',
    '// default 分支原样返回：未知类型交给 provider 决定，不在本层报错。',
    '// 该函数被 assistant 与 tool 两条路径共用，必须保持无状态。',
    '// warnings 由调用方注入，便于聚合后统一记录。',
  ] },
  { at: 669, expect: "case 'file': {", text: [
    '// 新式 file 片段走完整归一化；结果必然是 file，否则说明输入有误。',
    '// 类型断言后的检查是防御性的：转换函数对 text 才返回 text。',
  ] },
  { at: 697, expect: "case 'file-url': {", text: [
    '// file-url 缺 mediaType 时要额外提示已从 URL 推断，并区分推断失败的情况。',
    '// 该提示只在缺省时拼接，显式声明 mediaType 时不打扰调用方。',
    '// 下载命中则内联，否则保留 URL 供 provider 直取。',
  ] },
  { at: 724, expect: "case 'file-id': {", text: [
    '// file-id 属于 provider 托管引用：转成 reference 型，mediaType 用顶层 application。',
    '// 字符串 id 需要 provider 名称才能包成 map，缺失时由 helper 抛错。',
  ] },
  { at: 774, expect: "case 'image-url': {", text: [
    '// image-url 固定 mediaType 为顶层 image，不做扩展名推断（历史语义如此）。',
    '// 其余路径与 file-url 一致，共用 resolveDownloadedFile。',
  ] },
  { at: 827, expect: 'default:', text: [
    '// 未知内容类型原样返回，保持向前兼容。',
  ] },
  { at: 834, expect: 'function convertFileIdToProviderReference({', text: [
    '// fileId 有两种形态：已是映射（多 provider 共享）或单字符串（旧式）。',
    '// 单字符串必须能确定 provider，否则无法构造引用，直接抛错。',
    '// 错误信息给出两条迁移路径，便于调用方自助修复。',
    '// 返回新对象，不修改入参。',
  ] },
  { at: 855, expect: '// Temporary private helper (see below).', text: [
    '// 扩展名到 mediaType 的静态映射，只覆盖常见类型。',
    '// 这是尽力而为的兜底，不追求完整 IANA 表；未命中时回退 octet-stream。',
  ] },
  { at: 883, expect: 'function getMediaTypeFromUrl(', text: [
    '// 从 URL 的 pathname 取最后一段的扩展名，忽略查询串与 fragment。',
    '// Object.hasOwn 而非 in：避免命中原型链上的同名键。',
    '// 解析失败或扩展名未知都返回 fallback，不抛错——',
    '//   该函数服务于废弃类型的兼容路径，不应让请求失败。',
  ] },
];

for (const a of anchors) {
  if (!lines[a.at].includes(a.expect)) {
    console.error(`EXPECT FAIL at ${a.at}: ${lines[a.at]}`);
    process.exit(1);
  }
}

for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
  lines.splice(a.at, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
