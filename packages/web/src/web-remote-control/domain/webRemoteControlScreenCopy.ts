// Web 远程控制失败页文案的唯一真值表：按 locale × failureReason 取 tone、badge、title、description、nextSteps 与 action。
// 只做静态查表，不参与失败原因判定、不发起重连、不渲染任何 UI 组件。
// 不负责：auth-required 的回登录页跳转（由入口负责）、relay 错误码的产生、以及页面排版与样式。
//
// INV-01 断言：zh-CN 与 en-US 两张表的 key 集合必须逐项一致，且恰好等于 FailureReason 去掉 auth-required 后的 12 个值 —— 守住它的位置：WEB_REMOTE_CONTROL_SCREEN_COPY 的两个语言分支与文末 satisfies —— 改错故障：单侧漏 key 时运行期取到 undefined，手机端失败页标题空白甚至直接白屏。
// INV-02 断言：新增失败原因必须先落 shared 协议再加两张表 —— 守住它的位置：satisfies 的穷尽约束 —— 改错故障：只补一种语言，另一语言索引越界，页面在切语言时才偶发崩溃。
// INV-03 断言：auth-required 不得出现在表的 key 中 —— 守住它的位置：satisfies 内层的 Exclude 排除项 —— 改错故障：若为它补文案，入口跳转与兜底折叠两条路径分叉，登出后仍停在失败页。
// INV-04 断言：resolveWebRemoteControlScreenCopy 必须把 auth-required 折叠成 relay-unavailable —— 守住它的位置：const reason 的三元分支 —— 改错故障：以 auth-required 直接索引得到 undefined，绕过入口的调用者拿到空文案后抛错。
// INV-05 断言：locale 只允许 zh-CN 与 en-US 两种取值 —— 守住它的位置：WebRemoteControlScreenLocale 类型 —— 改错故障：新增语言却忘了同步整张表，查表下标落空。
// INV-06 断言：语言归一化只按小写前缀 zh 判定，其余一律回落到 en-US —— 守住它的位置：resolveWebRemoteControlScreenLocale 的 return —— 改错故障：改成精确匹配 zh-CN 后，zh-TW、zh-Hans 用户全部看到英文页。
// INV-07 断言：tone 只能取 danger、warning、neutral —— 守住它的位置：WebRemoteControlScreenCopy.tone —— 改错故障：写入其他值后组件样式分支找不到匹配，徽标退回默认灰色，危险态失去红色提示。
// INV-08 断言：只有不可恢复或成因未知的故障才标 danger —— 守住它的位置：desktop-disconnected、relay-unavailable、unexpected-error 的 tone —— 改错故障：把可重试的超时标成 danger，用户误以为必须回桌面端重建二维码。
// INV-09 断言：workspace-closed 与 unsupported-action 必须保持 neutral —— 守住它的位置：这两项的 tone 字段 —— 改错故障：升级为 warning 后，正常关闭工作区被当成异常，用户反复无意义重试。
// INV-10 断言：每条 nextSteps 固定两条且都是可直接执行的动作 —— 守住它的位置：各 reason 的 nextSteps 数组 —— 改错故障：多于两条时手机窄屏卡片溢出，少于两条时丢掉「回桌面端」这条退路。
// INV-11 断言：badge 是短语、title 是结论、description 才解释成因 —— 守住它的位置：三个字段的职责划分 —— 改错故障：长句塞进 badge，小屏徽标被截断成省略号，用户看不出失败类型。
// INV-12 断言：detailLabel 是给用户看的标签而非内部错误码 —— 守住它的位置：detailLabel 字段（如「Relay 返回」「失败原因」） —— 改错故障：把 reason 原文塞进去，等于向终端用户暴露内部标识。
// INV-13 断言：action 必须与该页真正可执行的动作对应 —— 守住它的位置：action 字段的三种取值 —— 改错故障：超时类误写成「重新加载」，整页刷新会丢掉正在恢复的会话状态。
// INV-14 断言：查表返回的是共享常量对象的引用，调用方不得原地修改 —— 守住它的位置：resolveWebRemoteControlScreenCopy 的 return —— 改错故障：某处改写 nextSteps 后全局文案被污染，只在特定路径复现。
// INV-15 断言：所有字符串里不得出现内网地址、token 或账号标识 —— 守住它的位置：全部文案字面量 —— 改错故障：失败页在手机浏览器中把内部信息直接暴露给终端用户。
// INV-16 断言：英文侧允许措辞差异但不允许缺字段 —— 守住它的位置：en-US 各 reason 的字段完整性 —— 改错故障：为统一措辞把 desktop-disconnected 的 nextStepsTitle 改回 "Next steps"，丢失场景说明。
//
// 修改口径：先改 shared 的 FailureReason，再同时补齐两张语言表，最后确认 satisfies 仍然通过。
// 术语：relay 指外部中转服务，desktop 指电脑端 ZCode，workspace 指桌面端已打开的工作区。
// 语气：warning 表示可自行恢复，danger 表示必须回桌面端，neutral 表示规则限制而非故障。
//
import type { WebRemoteControlFailure, WebRemoteControlFailureReason } from "@zcode/shared";

// [契约] 语言枚举只认这两个值，resolveWebRemoteControlScreenLocale 的返回值必须落在该联合内。
// 在这里新增语言（例如 ja-JP）而不补整张表，satisfies 不会报错，但查表下标会返回 undefined。
// 不要把它放宽成 string —— 类型一松，越界访问的编译期拦截就全部失效。
export type WebRemoteControlScreenLocale = "zh-CN" | "en-US";

// [契约] 这 8 个字段是失败页组件的完整输入面，组件只按它们渲染，不再做二次判断。
// tone 决定配色与图标，badge / title / description 构成三层递进的信息密度。
// detailLabel 必须写成用户能看懂的标签，而不是内部错误码或 reason 原文。
// 新增字段要同时改组件与两张语言表，否则页面读到 undefined 会渲染出空节点。
export interface WebRemoteControlScreenCopy {
  tone: "danger" | "warning" | "neutral";
  badge: string;
  title: string;
  description: string;
  detailLabel: string;
  nextStepsTitle: string;
  nextSteps: string[];
  action: string;
}

// [契约] 这是全文件唯一的文案真值表，两个语言分支必须逐 key 对齐，顺序也保持一致便于人工比对。
// 外层用 satisfies 而不是类型注解，是为了既校验穷尽性、又保留每个字面量的窄类型供组件推导。
// 不要为了少写几行把两种语言合并成带占位符的模板 —— 中英文案结构与标点并不一一对应。
// [权衡] 表内维持扁平的两级索引而不按 reason 拆文件，是因为失败页只查一次，拆散只会增加跳转成本。
const WEB_REMOTE_CONTROL_SCREEN_COPY = {
  "zh-CN": {
    // [契约] 账号不匹配属于用户可自行纠正的失败：语气用 warning，动作给「重新连接」而不是刷新。
    // 文案必须点明「与电脑端相同账号」，否则用户只会反复扫描同一张二维码。
    // description 保持一句话，把操作细节全部放进 nextSteps，避免卡片在手机上过高。
    // 这一项与 invalid-mobile-connection 的区别是「链接有效、只是身份不对」，措辞不要混用。
    "device-not-owned": {
      tone: "warning",
      badge: "账号不匹配",
      title: "该设备不属于当前账号",
      description: "请使用与电脑端相同的账号登录。",
      detailLabel: "失败原因",
      nextStepsTitle: "下一步",
      nextSteps: ["确认电脑端当前登录的账号。", "切换为相同账号后重新连接。"],
      action: "重新连接",
    },
    "session-not-found": {
      tone: "warning",
      badge: "链接不可用",
      title: "访问链接已失效",
      description: "这次 Web 远程控制链接已经不存在，通常是桌面端重新生成了二维码。",
      detailLabel: "Relay 返回",
      nextStepsTitle: "下一步",
      nextSteps: ["回到桌面端重新打开 Web 远程控制。", "用手机扫描最新二维码。"],
      action: "重新加载",
    },
    // [失败路径] 会话过期与 session-not-found 症状相近但成因不同：链接还在，会话已经终止。
    // 因此 action 用「重新加载」而不是「重新连接」——重连会复用已失效的会话标识，必然再次失败。
    // description 必须说明「已被桌面端关闭」这一可验证事实，避免用户把原因归到手机网络。
    // 若把这两条文案合并，用户会误以为需要重新扫码，实际只需刷新当前页。
    "session-expired": {
      tone: "warning",
      badge: "会话结束",
      title: "本次远程控制已结束",
      description: "当前远程控制会话已经过期或被桌面端关闭。",
      detailLabel: "结束原因",
      nextStepsTitle: "下一步",
      nextSteps: ["在桌面端重新开启 Web 远程控制。", "用新的链接进入当前工作区。"],
      action: "重新加载",
    },
    // [并发] 同一会话只允许一个手机控制端，本机被接管时语义是「被替换」而不是「出错」。
    // 文案不能让用户以为可以两台同时控制，否则他会反复夺回控制权，形成来回抢占。
    // action 给「重新连接」是有意的：旧设备重连会再次触发接管，从而明确告知当前控制权归属。
    "session-conflict": {
      tone: "warning",
      badge: "设备接管",
      title: "已被其他设备接管",
      description: "另一台远程控制设备已经接入，同一时间只能保留一个手机控制端。",
      detailLabel: "Relay 返回",
      nextStepsTitle: "下一步",
      nextSteps: ["继续使用新接入的设备。", "如果要用本设备控制，请重新扫描桌面端二维码。"],
      action: "重新连接",
    },
    // [权衡] 工作区被桌面端主动关闭属于正常操作，用 neutral 而非 warning，避免制造告警感。
    // 下一步必须把用户引导回桌面端重开工作区，因为手机端无法自行创建 workspace。
    // 这里的 badge 写「工作区关闭」是陈述事实，不要改成「连接失败」这类误导性描述。
    "workspace-closed": {
      tone: "neutral",
      badge: "工作区关闭",
      title: "当前工作区已关闭",
      description: "桌面端已经关闭了共享工作区，手机端无法继续访问这个 workspace。",
      detailLabel: "桌面端返回",
      nextStepsTitle: "下一步",
      nextSteps: ["在桌面端重新打开目标工作区。", "重新发起 Web 远程控制。"],
      action: "重新加载",
    },
    "desktop-disconnected": {
      tone: "danger",
      badge: "电脑端离线",
      title: "桌面端已离线",
      description: "电脑端已经断开连接，当前手机页面不能继续控制桌面工作区。",
      detailLabel: "Relay 返回",
      nextStepsTitle: "下一步",
      nextSteps: ["确认电脑端 ZCode 仍在运行并联网。", "在电脑端重新开启 Web 远程控制后再连接。"],
      action: "重新连接",
    },
    // [失败路径] 二维码参数无效发生在建链之前，与 session-not-found 的关键区别是「从未连上 relay」。
    // 文案要显式劝阻复用旧截图或旧链接，这是该失败在真实支持工单里的主要来源。
    // action 仍是「重新连接」而非「重新加载」，因为页面本身没有可刷新的服务端状态。
    "invalid-mobile-connection": {
      tone: "warning",
      badge: "校验失败",
      title: "手机连接已失效",
      description: "当前页面的二维码参数无效，请扫描桌面端的最新二维码。",
      detailLabel: "失败原因",
      nextStepsTitle: "下一步",
      nextSteps: ["不要复用旧截图或旧链接。", "回到桌面端扫描最新二维码。"],
      action: "重新连接",
    },
    // [失败路径] 手机已连上 relay、桌面端未按时返回数据，故障点在 desktop 而不在手机网络。
    // `desktop-bootstrap-timeout` 的下一步先让用户确认桌面端没有休眠、没有卡在确认弹窗。
    // action 给「重试」保留当前链路，不要改成「重新加载」——整页刷新会重新走一遍 bootstrap。
    "desktop-bootstrap-timeout": {
      tone: "warning",
      badge: "响应超时",
      title: "桌面端响应超时",
      description: "手机端已经连上 relay，但桌面端没有及时返回工作区数据。",
      detailLabel: "超时详情",
      nextStepsTitle: "下一步",
      nextSteps: ["确认桌面端没有休眠或卡在确认弹窗。", "保持电脑和手机网络可用后重试。"],
      action: "重试",
    },
    // [失败路径] 与 bootstrap 超时的分界：这条对应「曾经连上过、断线后恢复失败」，链路已经存在。
    // action 用「重试」以保留当前页面的恢复状态机，改成「重新加载」会把重连进度全部丢弃。
    // 文案把「回桌面端重开」放在第二句，是有意把破坏性更强的动作排在后面。
    // description 不要写「网络异常」——恢复超时的常见成因是桌面端休眠，直接归因网络会误导排查。
    "connection-recovery-timeout": {
      tone: "warning",
      badge: "恢复超时",
      title: "连接恢复超时",
      description: "手机端连接没有及时恢复，当前页面暂时无法继续同步远程控制。",
      detailLabel: "恢复详情",
      nextStepsTitle: "下一步",
      nextSteps: [
        "保持手机网络可用后重试。",
        "如果仍无法恢复，再回到桌面端重新开启 Web 远程控制。",
      ],
      action: "重试",
    },
    // [权衡] auth-required 会在 resolveWebRemoteControlScreenCopy 里折叠到本项，因此这条文案实际承担两种场景。
    // 描述只能写「无法连接中转服务」这类共性成因，不可写成会话级的具体原因。
    // 若把它降成 warning，鉴权丢失场景会以轻提示呈现，用户不会去重新登录。
    // 把兜底目标选在这里而不是 unexpected-error，是为了让「网络可查」这类提示仍然成立。
    "relay-unavailable": {
      tone: "danger",
      badge: "中转异常",
      title: "无法连接中转服务",
      description: "手机端无法稳定连接 Web 远程控制中转服务。",
      detailLabel: "连接详情",
      nextStepsTitle: "下一步",
      nextSteps: ["检查手机网络是否可访问外网。", "如果电脑端仍在线，可以稍后刷新重试。"],
      action: "重试",
    },
    // [契约] 这是规则限制而不是故障：tone 必须 neutral，badge 用「暂不支持」而非错误措辞。
    // 说明里要强调「只能访问桌面端已打开的工作区」，这是该失败唯一的合法解法。
    // action 给「重新加载」是因为用户回桌面端打开工作区后，本页刷新即可重新建链。
    // 不要把它并进 unexpected-error —— 合并后用户会去重试一个永远不会成功的操作。
    "unsupported-action": {
      tone: "neutral",
      badge: "暂不支持",
      title: "当前动作暂不支持",
      description: "Web 远程控制只支持访问桌面端已经打开的工作区。",
      detailLabel: "限制说明",
      nextStepsTitle: "下一步",
      nextSteps: ["先在桌面端打开目标工作区。", "再从手机端选择这个工作区。"],
      action: "重新加载",
    },
    "unexpected-error": {
      tone: "danger",
      badge: "未知异常",
      title: "Web 远程控制失败",
      description: "打开远程控制页面时发生了未预期错误。",
      detailLabel: "错误详情",
      nextStepsTitle: "下一步",
      nextSteps: ["刷新页面再试一次。", "如果仍然失败，请回到桌面端重新生成二维码。"],
      action: "重试",
    },
  },
  // [契约] 英文表必须与中文表形影不离地同步：新增 reason 漏掉这里，satisfies 会立刻报缺 key。
  // 字段值允许风格差异（例如 desktop-disconnected 的 nextStepsTitle 用 "What happened"），
  // 但字段本身一个都不能少 —— 结构一致优先于措辞一致。
  // 翻译时保留 ZCode、relay 等专有名词，不要把 relay 意译成「服务器」，否则与桌面端提示不一致。
  "en-US": {
    "device-not-owned": {
      tone: "warning",
      badge: "Account mismatch",
      title: "This device does not belong to this account",
      description: "Sign in with the same account as the computer.",
      detailLabel: "Failure detail",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Check which account is signed in on the computer.",
        "Switch to the same account and reconnect.",
      ],
      action: "Try Again",
    },
    "session-not-found": {
      tone: "warning",
      badge: "Link unavailable",
      title: "Access Link Expired",
      description:
        "This Web remote control link no longer exists, usually because desktop generated a new QR code.",
      detailLabel: "Relay detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Open Web remote control again on desktop.", "Scan the latest QR code."],
      action: "Reload",
    },
    "session-expired": {
      tone: "warning",
      badge: "Session ended",
      title: "Remote Control Ended",
      description: "This remote control session expired or was closed from desktop.",
      detailLabel: "Close reason",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Start Web remote control again on desktop.",
        "Open the workspace from a new link.",
      ],
      action: "Reload",
    },
    "session-conflict": {
      tone: "warning",
      badge: "Device takeover",
      title: "Taken Over By Another Device",
      description:
        "Another remote control device connected and replaced this phone. Only one mobile controller can stay active at a time.",
      detailLabel: "Relay detail",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Continue on the newer device.",
        "Scan the desktop QR code again to use this phone.",
      ],
      action: "Try Again",
    },
    "workspace-closed": {
      tone: "neutral",
      badge: "Workspace closed",
      title: "Workspace Closed",
      description:
        "The shared workspace was closed on desktop, so this phone can no longer access it.",
      detailLabel: "Desktop detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Reopen the target workspace on desktop.", "Start Web remote control again."],
      action: "Reload",
    },
    "desktop-disconnected": {
      tone: "danger",
      badge: "Desktop offline",
      title: "Desktop Offline",
      description:
        "The desktop side disconnected. This phone can no longer control the desktop workspace.",
      detailLabel: "Relay detail",
      nextStepsTitle: "What happened",
      nextSteps: [
        "Make sure ZCode is still running and online on desktop.",
        "Start Web remote control again from desktop.",
      ],
      action: "Try Again",
    },
    "invalid-mobile-connection": {
      tone: "warning",
      badge: "Invalid connection",
      title: "Mobile Connection Invalid",
      description: "The QR parameters are invalid. Scan the latest desktop QR code.",
      detailLabel: "Failure detail",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Do not reuse an old screenshot or copied link.",
        "Scan the latest desktop QR code.",
      ],
      action: "Try Again",
    },
    "desktop-bootstrap-timeout": {
      tone: "warning",
      badge: "Timed out",
      title: "Desktop Timed Out",
      description:
        "This phone reached the relay, but desktop did not return workspace data in time.",
      detailLabel: "Timeout detail",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Check that desktop is not asleep or waiting for confirmation.",
        "Keep both devices online and retry.",
      ],
      action: "Retry",
    },
    "connection-recovery-timeout": {
      tone: "warning",
      badge: "Recovery timed out",
      title: "Connection Recovery Timed Out",
      description:
        "This phone did not recover its remote control connection in time, so the current page cannot keep syncing yet.",
      detailLabel: "Recovery detail",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Keep the phone network available and retry.",
        "If it still cannot recover, start Web remote control again from desktop.",
      ],
      action: "Retry",
    },
    "relay-unavailable": {
      tone: "danger",
      badge: "Relay unavailable",
      title: "Relay Unavailable",
      description: "This phone cannot maintain a connection to the Web remote control relay.",
      detailLabel: "Connection detail",
      nextStepsTitle: "Next steps",
      nextSteps: ["Check the phone network.", "Refresh later if desktop is still online."],
      action: "Retry",
    },
    "unsupported-action": {
      tone: "neutral",
      badge: "Unsupported",
      title: "Action Not Supported",
      description: "Web remote control can only access workspaces already open on desktop.",
      detailLabel: "Limitation",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Open the target workspace on desktop first.",
        "Select it from this phone afterward.",
      ],
      action: "Reload",
    },
    "unexpected-error": {
      tone: "danger",
      badge: "Unexpected error",
      title: "Web Remote Control Failed",
      description: "An unexpected error occurred while opening Web remote control.",
      detailLabel: "Error detail",
      nextStepsTitle: "Next steps",
      nextSteps: [
        "Refresh this page once.",
        "If it still fails, generate a new QR code on desktop.",
      ],
      action: "Retry",
    },
  },
// [契约] 这一行是整张表的编译期护栏：Record 的两层索引要求两语言、全部非 auth-required 原因都给出完整对象。
// 缺少任一 key 或任一字段，类型检查立即失败，不会拖到运行期才暴露。
// [契约] 用 satisfies 而非在 const 上加类型注解，是为了保留字面量的窄类型供组件侧推导。
// 若改成普通类型注解，tone 会被放宽成字符串，样式分支将失去穷尽检查。
// [权衡] Exclude 只排除 auth-required 一项，说明其余原因都必须有用户可读文案，不允许落到通用兜底。
} satisfies Record<
  WebRemoteControlScreenLocale,
  Record<Exclude<WebRemoteControlFailureReason, "auth-required">, WebRemoteControlScreenCopy>
>;

// [契约] 语言归一化只在这里做一次，调用方不应自行判断 locale。
// 返回值一定会被当作查表下标使用，因此绝不能返回空串或把入参原样透传。
// [权衡] 用前缀匹配而非白名单，是为了让 zh-TW、zh-Hans 等地区变体自动落到简体中文文案。
// 若日后要区分繁简，必须在此处拆出 zh-TW 并同步新增整张语言表，不能只改判断。
export function resolveWebRemoteControlScreenLocale(
  language: string,
): WebRemoteControlScreenLocale {
  // [契约] 先转小写再比较，避免 "ZH-cn" 这类浏览器上报值被误判成英文。
  // [失败路径] 任何非 zh 前缀（含空串与未初始化值）都会安全回落到 en-US，这是刻意的默认。
  // 不要在这里为空值新增抛错分支 —— 失败页本身不能因为取语言再失败一次。
  // [权衡] 中文优先判断与产品默认语言一致；若默认语言调整，只改这一处即可全局生效。
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

// [契约] 查表入口只有这一个：组件、路由守卫与测试都从这里取文案，不要直接引用常量表。
// 参数 failure 的其余字段刻意不参与选表，文案与具体错误文本解耦。
// 这样 relay 调整错误描述时不会牵动 UI 文案，反之改文案也不会影响协议。
// 新增调用方时保持只传 reason 与 locale 的语义，别把整条错误链路塞进来。
export function resolveWebRemoteControlScreenCopy(
  failure: WebRemoteControlFailure,
  locale: WebRemoteControlScreenLocale,
): WebRemoteControlScreenCopy {
  // [失败路径] auth-required 表示登录态已失效，入口应先跳登录页；走到这里说明调用方绕过了入口。
  // [契约] 折叠必须发生在这里而不是在表里加 key，因为 satisfies 已明确把 auth-required 排除在外。
  // [权衡] 折叠成 relay-unavailable 而不新增专用文案，是为了不把「未登录」暴露在公开失败页上。
  // 改这段前先确认入口跳转仍然存在，否则用户会被留在一个可重试但不可能成功的页面上。
  // auth-required 由入口回登录页；此处仅作为非入口调用者的防御性兜底。
  const reason = failure.reason === "auth-required" ? "relay-unavailable" : failure.reason;
  // [资源] 这里返回的是常量表里的对象引用，调用方不得 push 或改写 nextSteps、也不得改 tone。
  // 一旦原地改写，整个进程生命周期内所有用户都会看到被污染的文案，且极难复现。
  // 需要定制请由调用侧浅拷贝，不要改成每次返回新对象 —— 每次渲染都复制是纯粹的无谓分配。
  return WEB_REMOTE_CONTROL_SCREEN_COPY[locale][reason];
}
