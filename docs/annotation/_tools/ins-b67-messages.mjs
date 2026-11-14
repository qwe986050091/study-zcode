import fs from 'node:fs'

const file = 'd:/code/claude-code-main/utils/messages.ts'
const raw = fs.readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const sites = [
  [228, 'function getTeammateMailbox', [
    '// 职责：按需加载 teammateMailbox 模块，避免模块图形成环。',
    '// 行为：每次调用都走 require，但 Node 会返回缓存导出，开销可忽略。',
    '// 反直觉：写成 typeof import 只为拿类型，运行时并不使用动态 import。',
    '// 丢失面：循环依赖若真的出现，这里不会报错，只会在首次调用时暴露 undefined。',
  ]],
  [241, 'TOOL_REFERENCE_TURN_BOUNDARY', [
    '// 职责：tool_reference 展开后，用于切分“人类回合”的边界标记文本。',
    '// 行为：原样作为文本块进入上下文，normalizeMessagesForAPI 据此判断回合归属。',
    '// 反直觉：它是模型可见的提示词而非 UI 文案，改动会改变模型对回合的切分。',
    '// 丢失面：一旦与其他文本粘连（缺换行），该边界即失效且难以在后处理中恢复。',
  ]],
  [447, 'function isSyntheticApiErrorMessage', [
    '// 职责：识别本仓库伪造的 API 错误消息。',
    '// 行为：要求 assistant 类型 + isApiErrorMessage 标记 + SYNTHETIC_MODEL 三方同时命中。',
    '// 反直觉：仅凭 isApiErrorMessage 不足以区分，真实服务端错误也可能带该标记。',
    '// 丢失面：模型名被改写的旧 transcript 会漏判，从而被当作真实错误参与统计。',
  ]],
  [487, 'function baseCreateAssistantMessage', [
    '// 职责：assistant 消息的统一工厂，供正常回复、错误消息、虚拟消息共用。',
    '// 行为：补齐 uuid/时间戳，并把 usage 各分项显式初始化为 0。',
    '// 反直觉：usage 不能留空，下游 OTel 与统计会直接读取分项计数，undefined 会传播成 NaN。',
    '// 丢失面：工厂只做形状归一，不校验 content 合法性，空数组会原样产出（由后续步骤修复）。',
  ]],
  [924, 'export function normalizeMessages', [
    '// 职责：把持久化的 Message 列表投影为 UI 消费的 NormalizedMessage 列表。',
    '// 行为：单趟遍历 + 末尾收尾，插入 hook 进度折叠、丢弃重复 api_error 等中间态。',
    '// 反直觉：输出条目数与输入经常不一致，调用方不能用下标跨次定位同一消息。',
    '// 丢失面：被折叠/丢弃的中间态不再存在于返回值，只能通过原始 messages 回查。',
  ]],
  [1228, 'function isHookAttachmentMessage', [
    '// 职责：hook 类附件的类型守卫，供计数与配对逻辑复用。',
    '// 行为：枚举 8 个 hook_* 子类型，命中任一即窄化为 HookAttachment。',
    '// 反直觉：hook_success 也被视为“需要配对”的附件，不能只把它当成功日志。',
    '// 丢失面：新增 hook 子类型若忘记加入此处，会被当作普通附件而跳过计数。',
  ]],
  [1244, 'function getInProgressHookCount', [
    '// 职责：统计某 tool_use 上指定 hook 事件“已启动未落定”的次数。',
    '// 行为：按 type=progress + hook_progress + hookEvent + parentToolUseID 四条件计数。',
    '// 反直觉：这里不去重，因为一条 progress 就代表一次真实启动。',
    '// 丢失面：progress 消息若在 UI 投影中被裁剪，计数会偏小，进而误判 hook 已结束。',
  ]],
  [1259, 'function getResolvedHookCount', [
    '// 职责：统计某 tool_use 上指定 hook 事件“已落定”的次数。',
    '// 行为：先按 toolUseID + hookEvent 过滤 hook 附件，再按 hookName 去重取 size。',
    '// 反直觉：一次 hook 执行可能产出多条附件（success + additional_context），必须去重。',
    '// 丢失面：不同 hook 同名时会被合并，属于已知口径取舍。',
  ]],
  [1793, 'function stripUnavailableToolReferencesFromUserMessage', [
    '// 职责：会话恢复兼容层，剔除指向“已不存在工具”的 tool_reference 块。',
    '// 触发：MCP server 断开/改名/移除后，API 会以 "Tool reference not found" 拒绝请求。',
    '// 行为：先整体探测一次，无命中直接原样返回；命中才重建消息，避免无谓拷贝。',
    '// 丢失面：整条 tool_result 内容都被过滤时替换为占位文本，原引用不可恢复。',
  ]],
  [1872, 'function appendMessageTagToUserMessage', [
    '// 职责：给 API 侧副本追加 [id:xxxxxx] 标签，使模型能用 snip 工具引用历史消息。',
    '// 行为：isMeta 消息直接跳过；字符串与块数组两种内容形状分别处理。',
    '// 反直觉：只改发往 API 的副本，存储与 UI 都不能出现该标签。',
    '// 丢失面：uuid 派生的短 ID 存在理论碰撞，碰撞时 snip 会指向错误消息。',
  ]],
  [2039, 'function contentHasToolReference', [
    '// 职责：判断 user 消息内容里是否存在 ToolSearch 动态加载的 tool_reference。',
    '// 行为：只看 tool_result 块的内部内容，顶层 tool_reference 不计入。',
    '// 反直觉：该判断只影响后续“文本兄弟块搬移”，不参与任何删除决策。',
    '// 丢失面：嵌套更深的引用（若协议扩展）不会被识别。',
  ]],
  [2058, 'function ensureSystemReminderWrap', [
    '// 职责：给附件来源的文本统一套 <system-reminder> 外壳。',
    '// 行为：使前缀成为后续 smoosh 的可信判据，字符串与块数组分别处理。',
    '// 反直觉：幂等是硬要求——重复调用绝不能二次包裹，否则前缀判据失效。',
    '// 丢失面：已有自定义前缀的文本不会被改写，可能逃过终局归并。',
  ]],
  [2096, 'function smooshSystemReminderSiblings', [
    '// 职责：终局归并，把同一 user 消息里 SR 前缀的文本块塞进最后一个 tool_result。',
    '// 行为：按前缀分流，归并失败（tool_reference 约束）时整条消息保持原样。',
    '// 反直觉：只处理 SR 文本；真实用户输入与折叠摘要保持独立在语义上更正确。',
    '// 丢失面：归并后文本块的位置信息消失，无法还原原始块序。',
  ]],
  [2145, 'function sanitizeErrorToolResultContent', [
    '// 职责：读侧兜底，保证 is_error 的 tool_result 只含 text 块。',
    '// 行为：把 text 块以空行拼成单块，非 text 内容丢弃；无 text 时清空 content。',
    '// 反直觉：这是为旧 transcript 准备的兼容层，新写入路径已不再产生该形状。',
    '// 丢失面：被丢弃的图片等块不会重新注入，只能依赖别处的正常回合补回。',
  ]],
  [2194, 'function relocateToolReferenceSiblings', [
    '// 职责：把 tool_reference 消息上的文本兄弟块搬到下一条“纯 tool_result”消息。',
    '// 动机：functions 展开后紧跟文本会形成异常回合模式，模型会学到并提前输出停止序列。',
    '// 行为：正向扫描找源，再向后找第一个不含 tool_reference 的 user 消息作为目标。',
    '// 丢失面：找不到目标时保持原位，尾部场景下这是安全但非最优的降级。',
  ]],
  [2680, 'function isToolResultMessage', [
    '// 职责：判定一条 user 消息是否承载 tool_result。',
    '// 行为：字符串内容一律视为非工具结果，只有块数组才逐块检查。',
    '// 反直觉：类型只看 message.type，不读 message.role，故 user 消息里的工具结果也能命中。',
    '// 丢失面：空块数组返回 false，与“工具结果为空”的语义存在歧义。',
  ]],
  [2738, 'function mergeAdjacentUserMessages', [
    '// 职责：单趟扫描合并相邻 user 消息，满足 API 的 user/assistant 交替要求。',
    '// 行为：结果数组末尾即“前一条”，无需回看原始列表。',
    '// 反直觉：用下标回写而非 .at()，因为 at 返回的是值副本，不能作为左值。',
    '// 丢失面：合并信息量的取舍全部交给 mergeUserMessages，本函数不做额外保留。',
  ]],
  [2757, 'function hoistToolResults', [
    '// 职责：把 tool_result 块整体前移，满足 "tool result must follow tool use" 的顺序要求。',
    '// 行为：一次分组后拼接，非 tool_result 块保持原有相对顺序。',
    '// 反直觉：这会打乱文本与工具结果的原始交错，但 API 只接受工具结果在前。',
    '// 丢失面：原始交错顺序不可恢复，若后续需要还原只能依赖存储的 transcript。',
  ]],
  [2772, 'function normalizeUserTextContent', [
    '// 职责：把 user 内容统一成块数组，简化后续拼接逻辑。',
    '// 行为：字符串包装成单 text 块；数组原样返回，不做深拷贝。',
    '// 反直觉：返回的数组可能是调用方对象的同一引用，调用方不得原地修改。',
    '// 丢失面：无。',
  ]],
  [2792, 'function joinTextAtSeam', [
    '// 职责：在两条内容数组的接缝处补分隔，避免相邻文本被无分隔地粘在一起。',
    '// 行为：仅当尾块与首块都是 text 时，给 a 的尾块补 \\n 再拼接。',
    '// 反直觉：换行只加在 a 侧，保证 b 块的前缀（如 <system-reminder>）不被破坏。',
    '// 丢失面：非 text 接缝不补分隔，依赖块类型自身的边界语义。',
  ]],
  [2821, 'function smooshIntoToolResult', [
    '// 职责：把若干内容块折进一个 tool_result，无法折叠时返回 null。',
    '// 硬约束：tool_reference 不能与其他类型混排，命中即放弃合并。',
    '// 行为：is_error 先滤成纯 text；全 text 且原 content 为字符串时保持字符串形状。',
    '// 丢失面：is_error 结果中的图片会被丢弃（图片仍会以正常用户回合送达）。',
  ]],
  [3492, 'function getPlanModeInstructions', [
    '// 职责：plan 模式提示词分派入口。',
    '// 行为：子代理 > sparse 提醒 > 完整版，三者互斥且按序判定。',
    '// 反直觉：子代理优先于 sparse——sparse 的“见前文”对没有前文的子代理没有意义。',
    '// 丢失面：新增提醒类型若忘记在此分派，会被静默当作完整版处理。',
  ]],
  [3549, 'function getPlanPhase4Section', [
    '// 职责：按实验分组选择 Phase 4 文案，四份常量仅措辞不同。',
    '// 行为：variant 为 null 走对照组；未知值由 satisfies never 在编译期兜底。',
    '// 反直觉：选哪份会改变计划长度与详略，属于提示词实验而非纯展示逻辑。',
    '// 丢失面：实验分组信息不随文案落盘，事后无法从 transcript 反推用了哪份。',
  ]],
  [3566, 'function getPlanModeV2Instructions', [
    '// 职责：plan 模式 v2 的完整指令拼装。',
    '// 行为：子代理返回空；interview 实验开启时整体替换为迭代式工作流。',
    '// 反直觉：返回空数组不是错误，而是“由 sparse/子代理专用版本接管”的信号。',
    '// 丢失面：模板中插值了工具名与 agent 数量，配置变化会直接改变提示词内容。',
  ]],
  [3658, 'function getReadOnlyToolNames', [
    '// 职责：列出当前注册表中的只读工具名，供 plan 模式提示词声明允许动作。',
    '// 行为：实时读取工具注册表并过滤，不使用缓存。',
    '// 反直觉：结果随 MCP/插件动态变化，同一会话内两次调用可能不同。',
    '// 丢失面：工具的自定义只读标记若未登记，会被误判为可写而遗漏。',
  ]],
  [3682, 'function getPlanModeInterviewInstructions', [
    '// 职责：interview 实验分支的 plan 指令。',
    '// 行为：用“提问—澄清—增量写计划”的迭代流程替代固定五阶段。',
    '// 反直觉：它仍复用同一 plan 文件路径，实验切换不影响用户可见的位置。',
    '// 丢失面：实验分支的文案不含阶段编号，事后难以与完整版区分。',
  ]],
  [3744, 'function getPlanModeV2SparseInstructions', [
    '// 职责：plan 模式的 sparse 提醒，每轮注入一句极短状态复述。',
    '// 行为：措辞随 interview 实验切换；正文包进 system-reminder 后作为 meta 消息。',
    '// 反直觉：越短越好——目的是压住上下文增长，而非补充新信息。',
    '// 丢失面：省略了完整约束，模型只能依赖更早的完整版说明。',
  ]],
  [3758, 'function getPlanModeV2SubAgentInstructions', [
    '// 职责：子代理专用的 plan 指令。',
    '// 行为：不要求五阶段，只强调只读、计划文件位置与提问方式。',
    '// 反直觉：子代理没有向用户直接提问的通道，故只保留 AskUserQuestion 的说明。',
    '// 丢失面：子代理不参与计划审批流程，审批语义只存在于主代理侧。',
  ]],
  [3778, 'function getAutoModeInstructions', [
    '// 职责：auto 模式提示词分派，按 reminderType 二选一。',
    '// 行为：sparse 走短提醒，full 走完整行为约束。',
    '// 反直觉：模式提醒不是 UI 提示，而是每轮都会消耗 token 的系统消息。',
    '// 丢失面：sparse 省略了红线条款，仅靠首次 full 提醒约束模型。',
  ]],
  [3787, 'function getAutoModeFullInstructions', [
    '// 职责：auto 模式的完整行为约束。',
    '// 行为：六条原则——立即执行、少打断、多行动、接受纠偏、破坏性操作仍需确认、禁止外泄。',
    '// 反直觉：auto 并非“无限制”，第 5/6 条仍是硬红线。',
    '// 丢失面：红线仅以提示词约束，没有代码级强制，模型仍可能越界。',
  ]],
  [3804, 'function getAutoModeSparseInstructions', [
    '// 职责：auto 模式的短提醒。',
    '// 行为：只复述“自主执行、少打断、行动优先”三条核心。',
    '// 反直觉：短提醒不重复红线，依赖会话早期注入的完整版。',
    '// 丢失面：若早期完整版被上下文压缩挤掉，红线约束会随之减弱。',
  ]],
  [4652, 'function createToolResultMessage', [
    '// 职责：为文件/目录类附件伪造一次工具调用结果，让模型以为“读过”这些内容。',
    '// 行为：图片块原样保留；字符串直接透传，避免 jsonStringify 转义换行浪费 token。',
    '// 反直觉：这会在上下文里制造一次并不存在的工具调用，仅用于承载附件内容。',
    '// 丢失面：映射抛错时降级为固定 Error 文案，原始结果不可恢复。',
  ]],
  [4689, 'function createToolUseMessage', [
    '// 职责：与 createToolResultMessage 配对的假 tool_use 文本。',
    '// 行为：工具名 + JSON 化入参拼成一行，isMeta=true 使其不展示给用户。',
    '// 反直觉：入参被序列化后不可再解析回原对象，仅作为可读说明。',
    '// 丢失面：入参中的 undefined/函数等非 JSON 值会被静默丢弃。',
  ]],
  [5203, 'function isThinkingBlock', [
    '// 职责：thinking / redacted_thinking 的统一类型守卫。',
    '// 行为：只比较 block.type，兼容普通块、参数块与 beta 块三种形状。',
    '// 反直觉：redacted_thinking 也算 thinking，二者在尾部过滤时同等对待。',
    '// 丢失面：未来新增的思考类块若未加入此处，会被当作普通内容保留。',
  ]],
  [5213, 'function filterTrailingThinkingFromLastAssistant', [
    '// 职责：剥离最后一条 assistant 消息尾部的连续 thinking 块。',
    '// 动机：API 不允许 assistant 消息以 thinking 结尾，否则请求被拒。',
    '// 行为：全部被剥离时插入 [No message content] 占位，避免空 content。',
    '// 丢失面：被剥离的 thinking 不落盘，日志只记录数量与 uuid。',
  ]],
  [5267, 'function hasOnlyWhitespaceTextContent', [
    '// 职责：判定一组内容块是否“只有空白文本”。',
    '// 行为：空数组返回 false；出现任一非 text 块或非空白文本即返回 false。',
    '// 反直觉：空数组被视为“有效”而非“全空白”，交由其他规则处理。',
    '// 丢失面：无。',
  ]],
  [5369, 'function ensureNonEmptyAssistantContent', [
    '// 职责：保证除最后一条外的 assistant 消息内容非空。',
    '// 动机：API 要求非末尾 assistant 必须有内容，空数组会触发校验错误。',
    '// 行为：按 index 显式跳过最后一条（prefill 允许为空），其余插入占位文本。',
    '// 丢失面：占位文本会永久留在 transcript 中，无法与真实内容区分。',
  ]],
]

// 自检：目标行必须包含预期片段，防止行号漂移导致插错位置
const bad = []
for (const [line, expect] of sites) {
  if (!lines[line - 1] || !lines[line - 1].includes(expect)) {
    bad.push(`${line}: ${lines[line - 1] ?? '<EOF>'}`)
  }
}
if (bad.length) {
  console.error('ABORT: anchor mismatch\n' + bad.join('\n'))
  process.exit(1)
}

const ordered = [...sites].sort((a, b) => b[0] - a[0])
let added = 0
for (const [line, , block] of ordered) {
  lines.splice(line - 1, 0, ...block)
  added += block.length
}
fs.writeFileSync(file, lines.join(eol))
console.log(`inserted ${added} comment lines at ${sites.length} sites`)
