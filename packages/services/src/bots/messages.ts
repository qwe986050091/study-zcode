// bots/messages.ts — 第三方渠道的用户可见文案（zh-CN / en-US）。
//
// INV-01 两个 locale 的键集合必须完全一致：BotMessageId 由 zh-CN 推导，en-US
//        缺键会在编译期报错，新增文案必须同时补两处。
// INV-02 {placeholder} 的键名就是调用方 values 的键；缺值替换为空串，
//        未知占位符原样保留（见 formatBotMessage）。
// INV-03 文案里出现的命令写法必须与 commandParser 的中文别名一致，例如
//        斜杠项目、斜杠状态；改命令别名时这里要同步。
// INV-04 错误文案只给用户可执行动作，不回显内部错误栈或 provider 细节。
// INV-05 emoji 仅用于流式/卡片终态标记，普通文本渠道不依赖 emoji 传达语义。
// [安全] 文案不拼接用户输入之外的敏感字段；{message} 只放已脱敏摘要。
//
// 维护方式：按功能分组，组内按展示顺序排列；新增键请就近插入同组。
import type { Locale } from "@zcode/shared";

export type BotMessageLocale = Extract<Locale, "zh-CN" | "en-US">;

type MessageValues = Record<string, string | number | undefined>;

// 未指定或非法 locale 一律回落中文；非中英语言也归到这里。
const DEFAULT_BOT_MESSAGE_LOCALE: BotMessageLocale = "zh-CN";

const messages = {
  "zh-CN": {
    // 状态与群开关文案。
    // 带占位符的条目由 formatBotMessage 统一替换，键名即占位符名。
    // groupEnabled 内含权限清单，属于用户可见的配置引导，改动需同步文档。
    botDisabled: "当前 bot 未启用。",
    // 群权限：owner 判定与启用前置条件。
    // groupNotEnabled 必须给出可执行路径（绑定用户 @机器人 /enable）。
    groupOwnerOnly: "仅绑定机器人的用户可以执行此操作。",
    groupNotEnabled: "此群尚未启用，请绑定用户 @机器人 /enable。",
    groupEnabled:
      "群聊已启用。话题历史默认开启，同一工作区的文件共享，可能发生并发修改。\n\n使用话题前，请应用管理员确认已开通相关权限：\n1. 打开[开放平台后台]({permissionsUrl})，选择当前机器人应用。\n2. 在权限管理中开通应用身份的消息读取权限，包括 `im:message.group_msg`（获取用户群消息）。接收其他机器人的 @ 还需 `im:message.group_at_msg.include_bot:readonly`；若需接收话题内未 @ 的机器人消息，开通 `im:message.group_msg.include_bot:read`。\n3. 可选：开通 `im:chat.members:read`（查看群成员），用于显示发送者用户名；缺少此权限不影响任务执行。\n4. 发布生效后，在话题内 @机器人提交需求。\n\n群启用不代表应用权限已开通；缺少话题历史读取权限时不会执行话题任务。",
    // 停用不删除已接收任务，因此文案强调任务保留在 Desktop。
    groupDisabled: "群聊已停用。已接收的任务保留在 Desktop。",
    // 私聊限制与 /bind 绑定入口。
    // privateChatOnly 是能力限制，bindPrivateOnly 是动作限制，不可互换。
    privateChatOnly: "Bots 暂不支持群聊，请在私聊中使用。",
    bindPrivateOnly: "Bots 只允许在私聊中绑定。",
    // 未绑定 / 命令禁用 / 工作区越界三类拒绝文案。
    // workspaceOutOfScope 指向斜杠项目，不能改成 workspace。
    // 拒绝文案必须告诉用户下一步动作，避免只报“不可用”。
    userNotBound: "当前 bot 未绑定。请先在 zcode UI 生成绑定码，然后发送 **/bind <code>**。",
    // 命令被 Bot 配置关闭时的统一提示，不暴露具体策略字段。
    commandNotAllowed: "当前 bot 未启用这个命令。",
    // 无可用工作区是配置问题，提示去 Bots 设置而不是用斜杠项目。
    noWorkspaceAllowed: "没有可用 workspace，请先在 Bots 设置里允许 workspace。",
    workspaceOutOfScope: "当前聊天上下文的 workspace 已不在授权范围内，请重新选择 **/项目**。",
    // 绑定码一次性且有过期时间，失败不区分“无效”与“过期”。
    bindCodeInvalid: "绑定码无效或已过期，请在 zcode UI 重新生成。",
    // bot 已被删除但绑定码仍在时的兜底。
    bindBotMissing: "绑定失败：bot 不存在。",
    bindSuccess: "绑定成功。发送 **/帮助** 查看可用命令。",
    // 微信激活后的首次欢迎语；与飞书绑定成功文案区分。
    weixinActivatedWelcome: "微信 Bot 已激活。发送 **/帮助** 查看命令，或直接描述你要做的事。",
    // [契约] help 文案的排列顺序与 bots/commandOrder 一致：两处口径漂移会让菜单与命令提示对不上。
    // 顺序与 bots/commandOrder 的展示顺序保持一致，避免两处口径漂移。
    // helpThoughtLevel 用的是斜杠思考，与状态文案里的“思考级别”同名。
    helpTitle: "ZCode 机器人命令：",
    helpHelp: "**/帮助** — 查看这份说明",
    // bind 展示占位符写法，提醒用户需要 code 参数。
    helpBind: "**/bind <code>** — 绑定当前聊天",
    // 状态命令覆盖 /status 的三块信息，与 statusFormatting 对应。
    helpStatus: "**/状态** — 查看工作区、模型和任务状态",
    helpNew: "/新建 或 /clear — 开始新的任务草稿",
    helpWorkspace: "**/项目** — 切换工作区",
    helpModel: "**/模型** — 切换模型",
    helpMode: "**/模式** — 切换运行模式",
    helpThoughtLevel: "**/思考** — 切换思考级别",
    // 回复颗粒度只影响第三方渠道的完成消息，不影响任务本身。
    helpReply: "**/回复** — 切换回复详细程度",
    // 回调失败：只暴露通用信息，不回显 provider 细节。
    // 原来的 Bugfix：通用回调路径曾误显示 Telegram，现已按渠道无关处理。
    webhookSecretInvalid: "Webhook secret 校验失败。",
    // Bugfix: 这条错误由通用 provider callback 处理路径触发，微信/飞书失败时不能误显示 Telegram。
    callbackFailed: "处理机器人回调失败：{message}",
    // 会话失效与任务重建提示。
    // deletedTaskReplaced 强调“不继承原上下文”，避免用户误以为历史还在。
    // 两者都给出 /new task 的可执行路径。
    sessionExpiredNewTaskHint:
      "当前任务会话已失效，可能是任务已被清理或机器人消息已过期。请发送 **/new task** 创建新任务后再继续。",
    deletedTaskReplaced:
      "原任务已删除，已为你新建任务。本条消息将在新任务中处理，不会继承原任务的对话上下文。",
    // 入站确认与纯附件消息的默认提示词。
    // attachmentOnlyPrompt 是送去模型的任务文本，不是错误提示。
    received: "已收到。",
    attachmentOnlyPrompt: "请查看附件并根据内容协助我。",
    // 附件失败：处理失败、不可下载、超限三种，提示必须可操作。
    // 5MB 上限与协议附件上限同一口径。
    attachmentRejected: "附件处理失败：{message}",
    attachmentDownloadUnavailable:
      "无法下载附件。文件可能已过期、已撤回，或机器人没有读取权限。请重新发送附件后再试。",
    // 超限文案必须给出可执行动作（压缩/重发）。
    attachmentTooLarge: "附件超过 5MB，请压缩后重新发送。",
    // 数字选择交互：0 取消是历史兼容口径，不能换其他数字。
    // selectionTextHintNoCancel 用于不允许取消的场景。
    selectionCancelled: "已取消。",
    // 取消项固定放在最后一个选项，编号由选择卡片生成。
    selectionCancelOption: "取消",
    selectionTextHint: "回复数字选择，0 取消。",
    selectionTextHintNoCancel: "回复数字选择。",
    // 新任务草稿与工作区选择标题。
    // workspaceSelectTitle 的当前项在前，列表由 UI 追加。
    newTaskDraft: "已进入 {workspacePath} 的新任务草稿。",
    workspaceSelectTitle: "当前 workspace {workspace}\n选择 workspace",
    // 与 noWorkspaceAllowed 不同：这里表示查询结果为空。
    workspaceMissing: "未找到可用 workspace。",
    // 模型选择：先选供应商再选模型。
    // sessionModelUnavailable 表示历史选择失效但已保留，提示用 /model 重选。
    modelSelectTitle: "选择 model",
    // 两级选择的第二级标题都会回显当前模型，便于确认上下文。
    modelProviderSelectTitle: "当前模型 {model}\n选择模型供应商",
    modelModelSelectTitle: "当前模型 {model}\n选择模型",
    modelMissing: "未找到 model。",
    sessionModelUnavailable: "当前会话的模型选择不可用，请使用 /model 重新选择。原选择已保留。",
    // 运行模式：yolo 由 Bot 锁定，modeLocked 是最终态提示。
    // 锁定文案必须明确“无法切换”，而不是“暂时不可用”。
    modeSelectTitle: "当前模式 {mode}\n选择模式",
    modeMissing: "未找到模式。",
    // 切换成功只影响当前 task，不写回 Bot 默认配置。
    modeChanged: "当前任务模式已切换为 {mode}。",
    modeLocked: "机器人已锁定 **yolo** 运行模式，无法切换。",
    // 思考级别：模型不支持时用 thoughtLevelMissing，而不是隐藏入口。
    thoughtLevelSelectTitle: "当前思考级别 {level}\n选择思考级别",
    thoughtLevelMissing: "当前模型不支持思考级别。",
    // 思考级别是任务级设置，不持久化到 Bot。
    thoughtLevelChanged: "当前任务思考级别已切换为 {level}。",
    modelProviderMissing: "未找到模型供应商。",
    modelChanged: "当前任务 model 已切换为 {model}。",
    // 任务切换：taskMissing 是找不到，noActiveTask 是尚未选择，语义不同。
    // taskChanged 展示 title，不展示 taskId，保持可读。
    taskMissing: "未找到任务。",
    taskChanged: "已切换到任务：{title}",
    // 尚未选择任何任务时的只读提示。
    noActiveTask: "当前没有 active task。",
    // 权限 / 问答 / 计划审批的卡片文案。
    // 过期文案统一引导回 zcode UI 处理，不提供聊天内重试。
    // planApproval* 与 elicitation* 共用同一套卡片渲染。
    permissionExpired: "权限请求已过期，请在 zcode UI 中处理。",
    permissionHandled: "权限请求已处理。",
    permissionDenied: "已拒绝权限请求。",
    permissionSubmitted: "已提交权限响应。",
    elicitationExpired: "问答请求已过期，请在 zcode UI 中处理。",
    elicitationHandled: "问答请求已处理。",
    elicitationSubmitted: "已提交问答响应。",
    // 取消问答是终态，卡片会替换为 elicitationCancelledCard。
    elicitationCancelled: "已取消问答请求。",
    elicitationCustomOption: "自定义回答",
    elicitationCustomPlaceholder: "请输入自定义回答",
    elicitationQuestionTitle: "提问",
    planApprovalTitle: "请审阅此实施计划。",
    planApprovalHeader: "实施计划",
    planApprovalApprove: "批准",
    planApprovalApproveDescription: "退出计划模式并开始实施。",
    elicitationCancelledCard: "✅ 问答已取消",
    elicitationSubmitOption: "完成",
    elicitationSkipOption: "跳过",
    elicitationMultiSelectHint: "可多选；再次选择会取消，选择“完成”提交。",
    elicitationTextHint: "也可以直接回复文本作为自定义答案。",
    // 状态行标签；与 statusFormatting 的拼接顺序对应。
    // statusDraft 是小写，作为状态值而不是行标题。
    statusWorkspace: "工作区",
    statusModel: "模型",
    statusTask: "任务",
    statusState: "状态",
    // Worked 行与 Task 行分开，避免把工作时长误读为任务时间。
    statusWorked: "已工作",
    statusProgress: "进展",
    statusDraft: "草稿",
    statusRemoteDisconnected: "远端未连接",
    statusCancelled: "已取消",
    statusStopped: "已停止",
    // 流式状态标记。
    // emoji 只出现在 running/completed，文本渠道可忽略不影响语义。
    streamingStatusRunning: "⏳ 运行中",
    streamingStatusCompleted: "✅ 已完成",
    streamingStatusFailed: "失败",
    streamingWorking: "正在处理...",
    // 工具摘要只展示名称与结果计数，不展开完整参数。
    streamingToolSummaries: "工具摘要",
    // 停止与未知命令。
    // unknownCommand 保留 {command}，方便用户核对拼写。
    stopSubmitted: "已停止当前任务生成。",
    unknownCommand: "未知命令：**/{command}**",
    taskFailed: "任务失败：{message}",
    groupTaskQueued:
      "当前任务还有排队输入（可能已暂停）。请在 Desktop 处理或移除队列后再切换任务；/停止 不会清空队列。",
    // 群任务前置条件：排队输入、交互等待、远端断线三种拦截。
    // 三种都必须显式说明“未执行”，避免用户误以为任务在跑。
    groupTaskInteraction: "当前任务正在等待回答或审批。请先处理该交互，或使用 /停止 结束当前任务。",
    groupTaskDisconnected: "远程工作区已断开，无法确认当前任务状态。请先使用 /reconnect 重连。",
    taskRunning: "当前任务正在运行，稍后再试，或使用 **/停止** 停止当前任务。",
    taskSelectTitle: "当前任务 {task}\n选择任务",
    noHistoryTasks: "当前 workspace 没有历史任务。",
    // 远端断线与重连：按未连接 / 切换后未连接 / 重连中 / 失败 / 不可用 /
    // 本地无需重连分场景。remoteDisconnectedStatus 只提示，不拦截新任务。
    // 失败与不可用必须说明“上一条请求没有执行”。
    remoteDisconnected:
      "当前远端项目 {workspacePath} 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。",
    remoteDisconnectedStatus: "当前远端项目 {workspacePath} 未连接。请发送 **/重连** 恢复连接。",
    remoteWorkspaceSelectedDisconnected:
      "已切换到远端项目 {workspacePath}，但当前未连接。请先发送 **/重连** 后再执行任务。",
    remoteReconnectStarting: "当前远端项目 {workspacePath} 未连接，正在为你重连...",
    remoteReconnectFailed: "当前远端项目 {workspacePath} 重连失败：{message}\n上一条请求没有执行。",
    remoteReconnectUnavailable:
      "当前远端项目 {workspacePath} 未连接，但机器人无法访问远端重连服务。请先在 ZCode 打开该远端项目后重试。",
    remoteReconnectLocal: "当前 workspace 是本地项目，不需要重连。发送 **/项目** 可切换远端项目。",
    remoteReconnectAlreadyConnected: "当前远端项目 {workspacePath} 已连接。",
    // 第三方回复颗粒度；mode 值是 short/medium/long 的展示名。
    replySelectTitle: "当前第三方回复颗粒度 {mode}\n选择第三方回复颗粒度",
    replyMissing: "未找到回复颗粒度。",
    replyChanged: "第三方回复颗粒度已切换为 {mode}。",
  },
  "en-US": {
    // 英文文案。键集合与 zh-CN 一一对应；占位符名称必须保持一致，
    // 否则 formatBotMessage 替换不到。
    botDisabled: "This bot is not enabled.",
    groupOwnerOnly: "Only the bound bot owner can perform this action.",
    groupNotEnabled:
      "This group is not enabled. Ask the bound owner to mention the bot with /enable.",
    groupEnabled:
      "Group enabled. Topic history defaults on. Workspace files are shared and may be edited concurrently.\n\nBefore using topics, ask the app administrator to confirm the required permissions:\n1. Open the [developer console]({permissionsUrl}) and select this bot app.\n2. In permission management, enable application-identity message read permissions, including `im:message.group_msg` (read user group messages). To receive mentions from other bots, also enable `im:message.group_at_msg.include_bot:readonly`; for bot messages without mentions in topics, enable `im:message.group_msg.include_bot:read`.\n3. Optional: enable `im:chat.members:read` (view group members) to display sender names. Missing this permission does not block task execution.\n4. Publish the changes, then mention the bot in a topic.\n\nEnabling the group does not grant app permissions; topic tasks will not execute without topic history read permissions.",
    groupDisabled: "Group disabled. Accepted work remains in Desktop.",
    privateChatOnly: "Bots do not support group chats yet. Please use a private chat.",
    bindPrivateOnly: "Bots can only bind in a private chat.",
    userNotBound:
      "This bot is not bound. Generate a bind code in the zcode UI, then send **/bind <code>**.",
    commandNotAllowed: "This command is disabled for the current bot.",
    noWorkspaceAllowed: "No workspace is available. Allow a workspace in Bots settings first.",
    workspaceOutOfScope:
      "The workspace in this chat is no longer authorized. Please select **/workspace** again.",
    bindCodeInvalid: "The bind code is invalid or expired. Generate a new one in the zcode UI.",
    bindBotMissing: "Bind failed: bot does not exist.",
    bindSuccess: "Bound successfully. Send **/help** to see available commands.",
    weixinActivatedWelcome:
      "Weixin bot is active. Send **/help** to see commands, or describe what you want to do.",
    helpTitle: "ZCode bot commands:",
    helpHelp: "**/help** — Show this guide",
    helpBind: "**/bind <code>** — Bind this chat",
    helpStatus: "**/status** — Show workspace, model, and task status",
    helpNew: "/new or /clear — Start a new task draft",
    helpWorkspace: "**/project** — Switch workspace",
    helpModel: "**/model** — Switch model",
    helpMode: "**/mode** — Switch run mode",
    helpThoughtLevel: "**/think** — Switch thought level",
    helpReply: "**/reply** — Switch reply detail",
    webhookSecretInvalid: "Webhook secret verification failed.",
    callbackFailed: "Failed to process bot callback: {message}",
    sessionExpiredNewTaskHint:
      "The current task session has expired. It may have been cleaned up, or this bot message is stale. Send **/new task** to create a new task and continue.",
    deletedTaskReplaced:
      "The previous task was deleted, so I created a new task for you. This message will be processed in the new task without the previous conversation history.",
    received: "Received.",
    attachmentOnlyPrompt: "Please review the attachment and help based on its content.",
    attachmentRejected: "Failed to process attachment: {message}",
    attachmentDownloadUnavailable:
      "Could not download the attachment. The file may have expired, been removed, or the bot may not have permission to read it. Please send the attachment again and try once more.",
    attachmentTooLarge: "The attachment exceeds 5MB. Compress it and send it again.",
    selectionCancelled: "Cancelled.",
    selectionCancelOption: "Cancel",
    selectionTextHint: "Reply with a number to choose, or 0 to cancel.",
    selectionTextHintNoCancel: "Reply with a number to choose.",
    newTaskDraft: "Entered a new task draft in {workspacePath}.",
    workspaceSelectTitle: "Current workspace {workspace}\nSelect workspace",
    workspaceMissing: "No available workspace found.",
    modelSelectTitle: "Select model",
    modelProviderSelectTitle: "Current model {model}\nSelect model provider",
    modelModelSelectTitle: "Current model {model}\nSelect model",
    modelMissing: "Model not found.",
    sessionModelUnavailable:
      "The session's model selection is unavailable. Use /model to choose again. Your saved selection has been preserved.",
    modeSelectTitle: "Current mode {mode}\nSelect mode",
    modeMissing: "Mode option not found.",
    modeChanged: "Current task mode changed to {mode}.",
    modeLocked: "This bot is locked to **yolo** run mode and cannot be switched.",
    thoughtLevelSelectTitle: "Current thought level {level}\nSelect thought level",
    thoughtLevelMissing: "The current model does not support thought level.",
    thoughtLevelChanged: "Current task thought level changed to {level}.",
    modelProviderMissing: "Model provider not found.",
    modelChanged: "Current task model changed to {model}.",
    taskMissing: "Task not found.",
    taskChanged: "Switched to task: {title}",
    noActiveTask: "There is no active task.",
    permissionExpired: "This permission request has expired. Please handle it in the zcode UI.",
    permissionHandled: "Permission request has already been handled.",
    permissionDenied: "Permission request denied.",
    permissionSubmitted: "Permission response submitted.",
    elicitationExpired: "This question request has expired. Please handle it in the zcode UI.",
    elicitationHandled: "Question request has already been handled.",
    elicitationSubmitted: "Question response submitted.",
    elicitationCancelled: "Question request cancelled.",
    elicitationCustomOption: "Custom answer",
    elicitationCustomPlaceholder: "Enter a custom answer",
    elicitationQuestionTitle: "Question",
    planApprovalTitle: "Review this implementation plan.",
    planApprovalHeader: "Implementation plan",
    planApprovalApprove: "Approve",
    planApprovalApproveDescription: "Exit plan mode and start implementation.",
    elicitationCancelledCard: "✅ Questions cancelled",
    elicitationSubmitOption: "Done",
    elicitationSkipOption: "Skip",
    elicitationMultiSelectHint:
      "You can select multiple options; select again to remove, then choose Done.",
    elicitationTextHint: "You can also reply with text as a custom answer.",
    statusWorkspace: "Workspace",
    statusModel: "Model",
    statusTask: "Task",
    statusState: "State",
    statusWorked: "Worked",
    statusProgress: "Progress",
    statusDraft: "draft",
    statusRemoteDisconnected: "remote disconnected",
    statusCancelled: "cancelled",
    statusStopped: "stopped",
    streamingStatusRunning: "Running",
    streamingStatusCompleted: "Completed",
    streamingStatusFailed: "Failed",
    streamingWorking: "Working...",
    streamingToolSummaries: "Tool summaries",
    stopSubmitted: "Current task generation stopped.",
    unknownCommand: "Unknown command: **/{command}**",
    taskFailed: "Task failed: {message}",
    groupTaskQueued:
      "The current task still has queued inputs, possibly paused. Process or remove them in Desktop before switching tasks; /stop does not clear the queue.",
    groupTaskInteraction:
      "The current task is waiting for an answer or approval. Resolve it first, or use /stop to stop the task.",
    groupTaskDisconnected:
      "The remote workspace is disconnected. Use /reconnect before checking the current task state.",
    taskRunning:
      "The current task is still running. Try again later, or use **/stop** to stop the current task.",
    taskSelectTitle: "Current task {task}\nSelect task",
    noHistoryTasks: "There are no history tasks in the current workspace.",
    remoteDisconnected:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** first, then try again. The previous request was not executed.",
    remoteDisconnectedStatus:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** to restore the connection.",
    remoteWorkspaceSelectedDisconnected:
      "Switched to {workspacePath}, but the remote workspace is not connected. Send **/reconnect** before running tasks.",
    remoteReconnectStarting:
      "The remote workspace {workspacePath} is not connected. Reconnecting now...",
    remoteReconnectFailed:
      "Remote workspace {workspacePath} reconnect failed: {message}\nThe previous request was not executed.",
    remoteReconnectUnavailable:
      "The remote workspace {workspacePath} is not connected, but the bot cannot access the remote reconnect service. Open this remote project in ZCode and try again.",
    remoteReconnectLocal:
      "The current workspace is local and does not need reconnecting. Send **/workspace** to switch to a remote project.",
    remoteReconnectAlreadyConnected: "The remote workspace {workspacePath} is connected.",
    replySelectTitle: "Current third-party reply detail {mode}\nSelect third-party reply detail",
    replyMissing: "Reply detail option not found.",
    replyChanged: "Third-party reply detail changed to {mode}.",
  },
} as const;

export type BotMessageId = keyof (typeof messages)[BotMessageLocale];

// 目前只支持 zh-CN / en-US，其他 Locale 视为默认。
export function normalizeBotMessageLocale(locale: Locale | undefined): BotMessageLocale {
  return locale === "en-US" ? "en-US" : DEFAULT_BOT_MESSAGE_LOCALE;
}

// 占位符替换：缺失值按空串处理，未知占位符原样保留。
export function formatBotMessage(
  locale: Locale | undefined,
  id: BotMessageId,
  values: MessageValues = {},
): string {
  let message: string = messages[normalizeBotMessageLocale(locale)][id];
  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return message;
}
