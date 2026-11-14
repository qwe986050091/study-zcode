// 远端连接展示层：把设备与项目侧已有的连接事实折叠成可直接渲染的展示模型（文案键、色调、图标、主操作、描述）。
// 不负责：错误分类与本地化（在 remoteConnectionPresentationErrors）、发起连接或重试（交给调用方）、订阅与持久化任何连接状态。
// 纯函数约束：不读 store、不碰平台服务、不写日志；相同输入必须得到相同输出，便于快照测试。
//
// INV-01 断言：主动断开恒为中性离线态，日志里残留的失败不得参与展示 —— 守住它的位置：resolveRemoteConnectionPresentation 的首个 if 分支 —— 改错故障：用户点断开后侧栏闪红并弹失败提示。
// INV-02 断言：已取消且不在进行中的连接与主动断开同属中性终态 —— 守住它的位置：首个 if 中的 !active 与 canceled 联合条件 —— 改错故障：取消连接后卡片显示 danger 并给出 retry。
// INV-03 断言：进行中状态（reconnecting 或 bootstrapping/retrying/connecting/updating）优先于一切错误与 pending 判定 —— 守住它的位置：else if (active) 必须排在 failed 分支之前 —— 改错故障：重连中被旧错误覆盖成失败，用户看到重试按钮。
// INV-04 断言：status、short、tone、icon、action 五项必须在同一分支内成套赋值 —— 守住它的位置：每个 else if 分支体 —— 改错故障：connecting 文案配 danger 红色，或 danger 文案配 disconnect 操作。
// INV-05 断言：身份待确认、待升级、待安装三条 pending 分支的顺序不可互换 —— 守住它的位置：identity 到 upgrade 到 install 的 else if 次序 —— 改错故障：已安装旧版本被判成待安装，按钮变成 install。
// INV-06 断言：升级动作按 upgradeTarget 分流到桌面端或服务端 —— 守住它的位置：needsUpdate 分支的 action 三元 —— 改错故障：controller 目标却给出 update-server，点击后毫无反应。
// INV-07 断言：credentialsMissing 或分类结果为 credentials 时必须给出 credentials 操作 —— 守住它的位置：needsCredentials 分支 —— 改错故障：缺凭据的卡片只给 retry，用户反复重试仍然失败。
// INV-08 断言：只有 state 不在 offline 与 absent 时，错误文本才可把状态抬升为 failed —— 守住它的位置：failed 分支的 state 排除条件 —— 改错故障：历史错误让已离线设备常驻失败态。
// INV-09 断言：recoveryBudgetExhausted 为真即判 failed，与是否携带错误文本无关 —— 守住它的位置：failed 分支的首个条件 —— 改错故障：自动恢复耗尽后仍显示 connecting，转圈不结束。
// INV-10 断言：成功态在 attached 为 false 时必须降级为 connecting —— 守住它的位置：online 分支内的 status 三元 —— 改错故障：已断开的 attachment 仍显示在线并给出断开按钮。
// INV-11 断言：分类结果 reason 只随 failed 与 pending 返回，其余状态不得携带 —— 守住它的位置：return 末尾的条件展开 —— 改错故障：在线卡片带上陈旧 reason，翻译键错配。
// INV-12 断言：设备级 errorCode 或 error 存在时不写 reasonText，避免项目本地化文案覆盖权威分类 —— 守住它的位置：return 中 reasonText 的三重否定条件 —— 改错故障：目录错误文案盖住设备错误，提示内容前后矛盾。
// INV-13 断言：recovery 只在 connecting 且 recoveryAttempt 为真时出现 —— 守住它的位置：return 中的 recovery 条件展开 —— 改错故障：预算为 0 或非重连状态也显示第 1/3 次恢复。
// INV-14 断言：optionalUpdate 只由 updateAvailability 为 available 决定，且此时 updateNotice 固定取中性色 —— 守住它的位置：return 的 optionalUpdate 与 updateNotice —— 改错故障：可升级提示被染成成功色，或强制升级被当成可选项。
// INV-15 断言：TONES 的键必须与 RemoteConnectionTone 的五个字面量一一对应 —— 守住它的位置：TONES 常量与 tone 类型 —— 改错故障：漏配一个色板后展开为 undefined，样式整体丢失。
// INV-16 断言：STATUS_PRIORITY 的数值必须严格单调，它决定多连接聚合的胜者 —— 守住它的位置：STATUS_PRIORITY 与 aggregateSourceStatus —— 改错故障：离线覆盖在线，侧栏把活跃设备显示成离线。
// INV-17 断言：同优先级快照取 updatedAt 最新者，避免输入数组顺序决定展示 —— 守住它的位置：getRemoteDevicePresentationInput 内的排序 —— 改错故障：刷新后侧栏状态在两次渲染之间来回跳动。
// INV-18 断言：导航聚合的挑选顺序为 pending 与 failed、optionalUpdate、connecting、online、默认 —— 守住它的位置：resolveRemoteConnectionNavigationPresentation 的瀑布查找 —— 改错故障：设置入口显示绿色在线，掩盖另一台设备的失败。
//
// 阅读顺序：先看 resolveRemoteConnectionPresentation 的分支优先级，再看三处聚合入口共用的同一张优先级表。
// 扩展点：新增连接状态需同步联合类型、TONES 键、STATUS_PRIORITY 与 i18n messageId 四处，缺一处即静默失真。
import {
  classifyRemoteConnectionError,
  type RemoteConnectionErrorPresentation,
} from "@/lib/remoteConnectionPresentationErrors.js";
import type { RemoteConnectionAction } from "@/lib/remoteConnectionPresentationTypes.js";
export {
  classifyRemoteConnectionError,
  formatRemoteConnectionError,
  shouldShowStandaloneRemoteErrorToast,
} from "@/lib/remoteConnectionPresentationErrors.js";
export type { RemoteConnectionErrorPresentation } from "@/lib/remoteConnectionPresentationErrors.js";
export type { RemoteConnectionAction } from "@/lib/remoteConnectionPresentationTypes.js";
import type {
  ConnectionProfile,
  RemoteTarget,
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
  SourceServerRecord,
} from "@zcode/shared";

// [契约] 这五个值是展示态而非协议态：bootstrapping、retrying、updating 会先折叠成 connecting 才出现在这里
// messageId 由它拼成 remote.status 加状态名，新增字面量必须同时补 i18n，否则界面只剩原始键名
// failed 与 pending 是仅有的两个可以携带 reason 的终态，其余状态带 reason 会出现两套互相矛盾的解释
// 不要为少写分支而新增状态：聚合优先级按这五档比较，多出一档就会静默失真
export type RemoteConnectionStatus = "online" | "connecting" | "offline" | "pending" | "failed";
export type AggregatedSourceStatus = RemoteConnectionStatus;
export type RemoteConnectionTone = "success" | "progress" | "neutral" | "warning" | "danger";
export type RemoteConnectionIcon = "cloud" | "spinner" | "cloud-off" | "cloud-alert" | "cloud-x";

// [契约] 字段都是可缺省的事实，缺省表示未知而不是 false，判断时必须显式区分 undefined
// state 同时接受协议状态机与展示状态，因为设备快照与项目侧回调共用这一个入口
// error 是设备权威原文并参与分类，projectError 是项目已本地化的文案，只作兜底展示
// 新增字段优先复用 shared 的既有类型，不要在此手写字符串联合，跨包升级时会悄悄失配
export interface RemoteConnectionPresentationInput {
  profileId?: string;
  state?: SourceServerConnectionState | RemoteConnectionStatus;
  attached?: boolean;
  reconnecting?: boolean;
  installState?: SourceServerRecord["installState"];
  disconnectOrigin?: "user" | "unexpected" | "startup";
  credentialsMissing?: boolean;
  updateAvailability?: SourceServerConnectionStateSnapshot["updateAvailability"];
  upgradeTarget?: SourceServerConnectionStateSnapshot["upgradeTarget"];
  recoveryAttempt?: number;
  recoveryLimit?: number;
  recoveryBudgetExhausted?: boolean;
  errorCode?: string;
  error?: string;
  /** 项目错误可能已本地化，不能覆盖设备权威错误用于分类的原文。 */
  projectError?: string;
  target?: RemoteTarget;
  displayName?: string;
  wizard?: boolean;
}

// [契约] 每种色调的四件套（前景、背景、边框、圆点）必须成套，UI 只做展开不做二次选色
// neutral 的圆点用边框而非实心，是为了让离线圆点在深浅主题下都保持低对比，别改成实心背景
// danger 用 destructive 语义色而不是字面色值，主题切换交由 design token 负责
// as const 保住字面量类型，去掉后按 tone 取值会退化为宽 string，样式类名的约束随之失效
const TONES = {
  success: {
    foreground: "text-success-surface-foreground",
    surface: "bg-success-surface",
    border: "border-success",
    dot: "bg-success",
  },
  progress: {
    foreground: "text-progress-surface-foreground",
    surface: "bg-progress-surface",
    border: "border-progress-surface-foreground",
    dot: "bg-progress-surface-foreground animate-pulse",
  },
  neutral: {
    foreground: "text-remote-foreground-muted",
    surface: "bg-surface",
    border: "border-border",
    dot: "border border-foreground-subtlest",
  },
  warning: {
    foreground: "text-warning-surface-foreground",
    surface: "bg-warning-surface",
    border: "border-warning",
    dot: "bg-warning",
  },
  danger: {
    foreground: "text-destructive-surface-foreground",
    surface: "bg-destructive-surface",
    border: "border-destructive",
    dot: "bg-destructive",
  },
} as const;

// [契约] 这是渲染层的完整契约，字段一旦存在，UI 就不得再从 store 或快照自行推导
// messageId 与 shortMessageId 必须成对：前者用于卡片整句，后者用于侧栏窄栏位
// primaryAction 与 actionMessageId 由同一分支产出，禁止 UI 按 status 反推操作
// 可选字段保持 optional，UI 必须容忍缺省；改成必填会波及所有调用点的快照测试
export interface RemoteConnectionPresentation {
  profileId?: string;
  status: RemoteConnectionStatus;
  messageId: string;
  shortMessageId: string;
  tone: RemoteConnectionTone;
  icon: RemoteConnectionIcon;
  primaryAction: RemoteConnectionAction;
  actionMessageId: string;
  foreground: string;
  surface: string;
  border: string;
  dot: string;
  recovery?: {
    messageId: string;
    shortMessageId: string;
    values: { attempt: number; limit: number };
  };
  optionalUpdate: boolean;
  updateNotice: { foreground: string; surface: string };
  description: string;
  displayName?: string;
  reason?: RemoteConnectionErrorPresentation;
  /** 项目 owner 已分类的文案（例如目录错误），设备级错误码仍优先。 */
  reasonText?: string;
}

/** 设备、项目、恢复均只读已有 owner 的事实；主动断开不能被残留错误染成失败。 */
export function resolveRemoteConnectionPresentation(
  input: RemoteConnectionPresentationInput,
): RemoteConnectionPresentation {
  // [契约] 默认值即离线中性态：所有分支都不命中时保持它，不要把兜底改成失败
  // short 初值 offline 与 status 对齐，拼出的翻译键才能命中同一组文案
  // icon 默认 cloud-off 表示未连接而非出错，错误图标只属于 failed 分支
  // [权衡] 用可变变量加顺序分支而非查表，是为了让条件优先级一眼可读，改成映射表会丢掉短路顺序
  let status: RemoteConnectionStatus = "offline";
  let short = "offline";
  let tone: RemoteConnectionTone = "neutral";
  let icon: RemoteConnectionIcon = "cloud-off";
  let action: RemoteConnectionAction = "connect";
  // [契约] 分类输入取设备原文优先、项目文案兜底，两者的优先级不能反过来
  // 三个来源任一存在就先分类，即便后面某些分支不读它，reason 仍决定 canceled 与主操作
  // 传入的是展开后的整个输入，分类器依赖 errorCode 而不是已本地化的字符串
  // [失败路径] 分类器对未知原因给兜底分类，这里不再二次判断，避免两处口径分叉
  const reason =
    input.errorCode || input.error || input.projectError
      ? classifyRemoteConnectionError({ ...input, error: input.error ?? input.projectError })
      : undefined;
  const canceled = reason?.category === "canceled";
  const active =
    input.reconnecting ||
    ["bootstrapping", "retrying", "connecting", "updating"].includes(input.state ?? "");
  // [契约] 空分支是刻意为之：中性终态就是保持上方默认值，不需要任何赋值
  // 主动断开优先于其余全部条件，用户意图不能被残留错误或随后的自动重连改写
  // [权衡] canceled 需要与 active 取反联合判断：重连过程中取消仍属进行中，不能提前判为终态
  // 若在此分支顺手补一句离线赋值，会盖掉启动阶段仍需展示的待处理提示
  if (input.disconnectOrigin === "user" || (!active && canceled)) {
    // 主动断开与用户取消是中性终态，保留在日志里的上次失败不再参与展示。
  // [并发] active 聚合了 reconnecting 与四种过渡协议态，任一为真都视为进行中
  // short 在 updating 时单独取值，让升级中的文案区别于普通连接
  // 向导内的进行中只给 cancel：连接尚未完成，断开连接的语义并不成立
  // [契约] 本分支排在所有 pending 与 failed 判定之前，重连期间不展示上一次的失败原因
  } else if (active) {
    status = "connecting";
    short = input.state === "updating" ? "updating" : "connecting";
    tone = "progress";
    icon = "spinner";
    action = input.wizard ? "cancel" : "none";
  } else if (
    input.state === "identity-change-pending" ||
    input.errorCode === "source-server-identity-change-pending"
  ) {
    status = "pending";
    short = "needsIdentity";
    tone = "warning";
    icon = "cloud-alert";
    action = "confirm-identity";
  } else if (
    input.state === "needs-upgrade" ||
    input.updateAvailability === "required" ||
    input.errorCode === "source-server-upgrade-required"
  ) {
    status = "pending";
    short = "needsUpdate";
    tone = "warning";
    icon = "cloud-alert";
    // controller 表示桌面端自身需要升级，动作落到 update-desktop；其余情况升级远端服务
    // upgradeTarget 缺省时走 update-server，这是多数场景，不要因为不确定就退化成 none
    // 服务端与桌面端升级的进度文案不同，但状态同为 pending，不要为此新增展示状态
    action = input.upgradeTarget === "controller" ? "update-desktop" : "update-server";
  } else if (
    input.state === "needs-install" ||
    input.installState === "uninstalled" ||
    input.errorCode === "source-server-install-required"
  ) {
    status = "pending";
    short = "needsInstall";
    tone = "warning";
    icon = "cloud-alert";
    action = "install";
  } else if (input.credentialsMissing || reason?.category === "credentials") {
    status = "pending";
    short = "needsCredentials";
    tone = "warning";
    icon = "cloud-alert";
    action = "credentials";
  } else if (input.state === "pending") {
    status = "pending";
    short = "pending";
    tone = "warning";
    icon = "cloud-alert";
  } else if (
    input.state === "failed" ||
    input.recoveryBudgetExhausted ||
    ((input.error?.trim() || input.projectError?.trim()) &&
      input.state !== "offline" &&
      input.state !== "absent")
  ) {
    status = "failed";
    short = "failed";
    tone = "danger";
    icon = "cloud-x";
    action = reason?.primaryAction ?? "retry";
  // [契约] attached 为真且无 state 视为已附着，这是手机远控复用桌面 Host 的场景，不必等首个快照才亮起
  // attached 显式为 false 时降级为 connecting：附着已断开但会话仍在，不能停留在成功态
  // 该分支放在最后，任何显式错误或待处理条件都应先于「看起来在线」命中
  // 在线时主操作是 disconnect，但向导内不可断开，退化为 cancel
  } else if (input.state === "online" || (input.attached && !input.state)) {
    status = input.attached === false ? "connecting" : "online";
    short = status;
    tone = status === "online" ? "success" : "progress";
    icon = status === "online" ? "cloud" : "spinner";
    action = status === "online" ? "disconnect" : input.wizard ? "cancel" : "none";
  }
  // [契约] 返回体一次成型，所有展示字段都在此确定，调用方不得二次加工
  // 三个条件展开（恢复信息、失败原因、常量色板）都由 status 或字段驱动，互不交叉
  // [权衡] 用展开而非后置赋值，是为了让缺省字段在类型层面就是 optional，UI 不必判空对象
  // 恢复信息里的次数上限缺省为 3，只影响文案，不改变是否处于恢复中的判断
  return {
    profileId: input.profileId,
    status,
    messageId: `remote.status.${status}`,
    shortMessageId: `remote.status.${short}`,
    tone,
    icon,
    primaryAction: action,
    actionMessageId: `remote.action.${action}`,
    ...TONES[tone],
    ...(status === "connecting" && input.recoveryAttempt
      ? {
          recovery: {
            messageId: "workspaceSidebar.recoveringAutomaticAttempt",
            shortMessageId: "workspaceSidebar.recoveringAutomaticShort",
            values: { attempt: input.recoveryAttempt, limit: input.recoveryLimit ?? 3 },
          },
        }
      : {}),
    optionalUpdate: input.updateAvailability === "available",
    updateNotice: input.updateAvailability === "available" ? TONES.neutral : TONES[tone],
    description: formatRemoteConnectionDescription(input.target),
    displayName: input.displayName,
    ...(status === "failed" || status === "pending"
      ? {
          reason,
          ...(!input.errorCode && !input.error && input.projectError
            ? { reasonText: input.projectError }
            : {}),
        }
      : {}),
  };
}

// [契约] 地址是可展示的定位串：ssh 带默认端口 22，wsl 用中点连接发行版与用户，docker 只给容器名
// server 走 URL 解析只取 host，路径与查询串里的 token 一律不进入展示层
// [失败路径] 非法 URL 返回 undefined 而不是原串，避免把畸形地址或被污染的凭据拼进界面
// 不要在这里做脱敏或加省略号：截断属于 UI 排版，掺进来会破坏复制出去的地址
export function formatRemoteProjectConnectionAddress(target?: RemoteTarget): string | undefined {
  if (!target) return undefined;
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl":
      return [target.distro, target.user].filter(Boolean).join(" · ") || "WSL";
    case "docker":
      return target.container;
    case "server":
      try {
        return new URL(target.url).host;
      } catch {
        return undefined;
      }
  }
}

/** 所有项目入口共用设备名回退；Server URL 只取地址，不能泄露 token。 */
// [契约] 显式 displayName 优先，且要 trim 后再判空，全空白名称等同于未命名
// ssh 优先配置别名（用户认得的名字），缺失才退回主机名；wsl 与 docker 同理
// server 优先 name，缺失时才退回地址；地址不含 token，可以安全展示
// 所有项目入口共用本函数，不要在调用点另写回退链，否则同一设备会出现两个名字
export function formatRemoteDeviceName(
  target?: RemoteTarget,
  displayName?: string,
): string | undefined {
  if (displayName?.trim()) return displayName.trim();
  if (!target) return undefined;
  switch (target.kind) {
    case "ssh":
      return target.sshConfigAlias?.trim() || target.host;
    case "wsl":
      return target.distro?.trim() || "WSL";
    case "docker":
      return target.container;
    case "server":
      return target.name?.trim() || formatRemoteProjectConnectionAddress(target);
  }
}

// 描述形如「协议 · 地址」，协议名走固定映射且不翻译，保证与连接详情页一致
// 地址为空时仍保留协议段，用户至少能分辨这是 SSH 还是 HTTP
// [契约] target 缺省返回空串而不是 undefined，调用方可以无条件渲染
export function formatRemoteConnectionDescription(target?: RemoteTarget): string {
  return target
    ? `${{ ssh: "SSH", wsl: "WSL", docker: "Docker", server: "HTTP" }[target.kind]} · ${formatRemoteProjectConnectionAddress(target) ?? ""}`
    : "";
}

export function formatConnectionProfileTarget(profile: ConnectionProfile): string {
  return formatRemoteProjectConnectionAddress(profile.target) ?? "";
}

// [契约] 数值越大越值得展示：online 最高，其次 connecting、pending、failed、offline
// 这张表同时服务聚合状态与设备选择，两处必须共用，改一处漏一处会让侧栏与卡片打架
// [权衡] failed 低于 pending，是为了让需用户动手的设备优先于已失败待重试的设备出现在导航上
// 类型声明覆盖全部五个状态，新增状态时检查会强制补齐，不要改成可选键
const STATUS_PRIORITY: Record<RemoteConnectionStatus, number> = {
  offline: 0,
  failed: 1,
  pending: 2,
  connecting: 3,
  online: 4,
};

// 多连接聚合取优先级最高者，而不是最后一条或第一条，结果与输入顺序无关
// 空列表返回 offline：无连接即离线中性，不要返回 undefined 让调用方各自兜底
// [契约] 逐条经 resolveRemoteConnectionPresentation 折算，保证聚合与单设备展示同源
export function aggregateSourceStatus(
  states: ReadonlyArray<Pick<SourceServerConnectionStateSnapshot, "state">>,
): AggregatedSourceStatus {
  return states.reduce<AggregatedSourceStatus>((current, candidate) => {
    const next = resolveRemoteConnectionPresentation(candidate).status;
    return STATUS_PRIORITY[next] > STATUS_PRIORITY[current] ? next : current;
  }, "offline");
}

/** 活动连接优先于其他连接的旧失败；同态取最新快照，避免输入顺序决定用户状态。 */
// [契约] 只认未退役的连接档案，已退役档案的残留状态不得参与设备状态聚合
// 先按档案标识建立集合再筛状态，避免把别的设备的快照算进来
// 设备记录缺失时仍返回档案信息，让移除中的设备继续有可展示的名字与地址
// 安装状态取自设备记录而不是档案：它是设备级事实，不能被某个档案覆盖
export function getRemoteDevicePresentationInput(
  snapshot:
    | Pick<SourceServerManagementSnapshot, "servers" | "profiles" | "states">
    | null
    | undefined,
  sourceServerId: string,
): RemoteConnectionPresentationInput {
  const server = snapshot?.servers.find((candidate) => candidate.sourceServerId === sourceServerId);
  const profiles =
    snapshot?.profiles.filter(
      (profile) =>
        profile.sourceServerId === sourceServerId && profile.lifecycleState !== "retired",
    ) ?? [];
  const ids = new Set(profiles.map((profile) => profile.profileId));
  const states = snapshot?.states.filter((state) => ids.has(state.profileId)) ?? [];
  // [契约] 先按优先级降序、再按更新时间降序排序，取第一项即最值得展示的最新快照
  // 排序键里两次折算展示状态，确保排序依据与最终展示完全一致，不要改成读原始 state
  // 不要改成找第一个非离线项：输入顺序会决定结果，刷新时状态会来回跳
  const selected = [...states].sort(
    (a, b) =>
      STATUS_PRIORITY[resolveRemoteConnectionPresentation(b).status] -
        STATUS_PRIORITY[resolveRemoteConnectionPresentation(a).status] || b.updatedAt - a.updatedAt,
  )[0];
  const profile =
    profiles.find((item) => item.profileId === selected?.profileId) ??
    profiles.find((item) => item.profileId === server?.preferredProfileId) ??
    profiles[0];
  return {
    ...selected,
    profileId: profile?.profileId,
    installState: server?.installState,
    target: profile?.target,
    displayName: server?.displayName ?? profile?.displayName,
  };
}

// 按设备维度输出只读映射，键是设备标识，值是折叠后的聚合状态
// 复用 getRemoteDevicePresentationInput，避免与侧栏设备状态出现第二套判定逻辑
// 无快照时返回空映射而不是抛错，侧栏首帧即可安全渲染
export function buildAggregatedSourceStatusMap(
  snapshot:
    | Pick<SourceServerManagementSnapshot, "servers" | "profiles" | "states">
    | null
    | undefined,
): ReadonlyMap<string, AggregatedSourceStatus> {
  return new Map(
    snapshot?.servers.map((server) => [
      server.sourceServerId,
      resolveRemoteConnectionPresentation(
        getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
      ).status,
    ]) ?? [],
  );
}

/** 设置导航聚合也是展示决策，界面不自行挑颜色或把失败降成警告。 */
// [契约] 挑选顺序为待处理与失败、可升级、进行中、在线，最后退回默认展示
// 待处理设备优先于可升级与在线：设置入口必须先把需要用户动手的设备暴露出来
// 可升级设备把圆点改成低对比色，提醒但不抢占待处理设备的警示位
export function resolveRemoteConnectionNavigationPresentation(
  snapshot: SourceServerManagementSnapshot | null | undefined,
): RemoteConnectionPresentation {
  const devices =
    snapshot?.servers.map((server) =>
      resolveRemoteConnectionPresentation(
        getRemoteDevicePresentationInput(snapshot, server.sourceServerId),
      ),
    ) ?? [];
  const result =
    devices.find((item) => item.status === "pending" || item.status === "failed") ??
    devices.find((item) => item.optionalUpdate) ??
    devices.find((item) => item.status === "connecting") ??
    devices.find((item) => item.status === "online") ??
    resolveRemoteConnectionPresentation({});
  return result.optionalUpdate ? { ...result, dot: "bg-foreground-subtle" } : result;
}
