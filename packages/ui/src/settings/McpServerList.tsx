// INV-01 [事务] servers 是父级注入的只读输入，本文件不复制为本地状态；守住位置：McpServerList 的解构参数与 SettingsResourceList 的 items；改错故障：组件内再缓存一份会让启停和编辑结果与父级分叉，行上显示过期的 enabled。
// INV-02 [权衡] 状态配色优先级固定为 disabled 高于 connected、connected 高于 connecting、connecting 高于 error、error 高于 attention；守住位置：McpStatusDot 中 color 的嵌套三元链；改错故障：调换分支会让禁用项仍显绿色，或让错误态误显进行中色，误导排障方向。
// INV-03 [失败路径] 禁用必须压过一切 status，包括 error；守住位置：color 首层的 disabled 判断与 icon 的 connecting 前提；改错故障：已禁用但残留 error 的服务器会继续显示红点，用户以为可以点进去修复。
// INV-04 [资源] 仅 connecting 且未禁用时渲染旋转图标；守住位置：icon 三元中的 Loader2Icon 与 animate-spin；改错故障：其他状态也转圈会让静态列表持续动画，产生无谓重绘并制造正在连接的错觉。
// INV-05 状态点的 reason 为必填字符串，不允许空 tooltip；守住位置：McpStatusDot 的 reason 形参与 statusReason 的取值；改错故障：空标题让悬停无反馈，用户无法区分 disconnected 与 unknown。
// INV-06 [事务] scope 只归一化为 workspace 或 user，其他值一律落到 user；守住位置：ScopeBadge 的 normalizedScope；改错故障：透传未知 scope 会让徽章查不到文案，元信息区出现空白胶囊并挤出换行。
// INV-07 类型标签推导顺序为 config.command 优先、其次 config.type、最后按 url 推断 http；守住位置：McpServerItem 的 typeLabel 表达式；改错故障：顺序颠倒会把 stdio 服务器标成 http，用户按错误协议排查。
// INV-08 [权衡] 描述行按数据源二选一拼接：有 url 展示 url，有 command 展示 command 加 args；守住位置：description 的三元表达式；改错故障：两条都拼会让文本重复冗长，挤压名称与状态徽章的空间。
// INV-09 [事务] 可编辑性由 location.source 决定，缺省 location 视为可编辑，非 zcode 来源只读；守住位置：McpServerItem 的 canEdit；改错故障：放宽条件会让插件托管条目进入编辑弹窗，保存时被后端拒绝。
// INV-10 [失败路径] 授权入口只在存在 authorizationUrl 时出现；守住位置：canOpenAuthorization 与右侧按钮的渲染条件；改错故障：无条件渲染会打开空地址，用户以为授权功能已损坏。
// INV-11 [失败路径] error 状态的文案 id 必须经 resolveMcpFailureMessageId 解析 failureKind；守住位置：statusReason 中最外层的 error 分支；改错故障：退化成通用错误文案后，鉴权失败与进程崩溃无法区分。
// INV-12 error 明细只在 status 为 error 时挂载 McpFailurePresentation；守住位置：McpServerItem 中 description 之后的渲染判断；改错故障：提前挂载会在正常行留下空容器，撑高行高并破坏列表对齐。
// INV-13 [事务] 行点击编辑必须同时受 canEdit 约束，只读行不注册交互；守住位置：settingsResourceRowInteraction 的传参；改错故障：只读行仍可点击会打开不可保存的弹窗，产生脏写尝试。
// INV-14 [事务] 开关只上抛 onToggle 与目标值，不在组件内改 server.enabled；守住位置：Switch 的 onCheckedChange 回调；改错故障：本地乐观改写会与父级刷新竞态，出现开关回弹或状态错位。
// INV-15 [并发] 授权点击统一走 runUserAction 包裹，遥测与业务回调同源；守住位置：授权按钮的 onClick 包络与 featureId、failureStage 字段；改错故障：直接调用回调会缺失失败阶段，授权异常在统计里不可见。
// INV-16 [失败路径] 空态判断必须早于任何列表渲染；守住位置：McpServerList 顶部的 servers.length 判断；改错故障：空数组交给列表组件只会渲染空容器，新建入口随之消失。
// INV-17 列表 key 使用 server.id 而非 name；守住位置：SettingsResourceList 的 getKey 回调；改错故障：同名服务器共用 key，切换一行会牵连另一行重挂载甚至串状态。
// INV-18 [权衡] hideMetadata 仅隐藏范围徽章与工具数，不隐藏状态与操作；守住位置：ScopeBadge 与 toolCount 的渲染条件；改错故障：把开关一起隐藏会让精简视图失去唯一可操作入口。
//
// 模块职责：把 MCP 服务器数组渲染为可编辑、可启停、可发起授权的设置列表，并负责状态点与失败文案的展示投影。
// 状态所有权：servers 与 enabled 归父级所有，本文件只读入参并上抛 onEdit、onToggle、onOpenAuthorization，不写入任何持久化状态。
// 阅读顺序：先看 McpStatusDot 的状态映射，再看 McpServerItem 的行内投影与交互，最后看 McpServerList 的空态与列表委托。
import { type McpServerStatus, type ZCodeMcpServer } from "@zcode/shared";
import {
  TID_MCP_OPEN_AUTHORIZATION_BUTTON,
  TID_MCP_SERVER_ROW,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { SettingsScopeBadge } from "@/settings/SettingsScopeBadge.js";
import {
  McpFailurePresentation,
  resolveMcpFailureMessageId,
} from "@/settings/McpFailurePresentation.js";
import { SettingsResourceList } from "@/settings/SettingsResourceGroup.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { CircleIcon, Cable, Loader2Icon, ExternalLink, Plus } from "lucide-react";

// 状态点把 McpServerStatus 映射为颜色与图标，是纯展示组件，不发起连接也不读取服务。
// [权衡] status 允许缺省，落到中性灰，用于尚未探测或来源未知的服务器。
// reason 必须与状态语义一致，tooltip 是用户区分 connecting 与 disconnected 的主要线索。
// 该组件同时被 McpSettingsSection 复用，改颜色或尺寸前先确认外部调用点的布局假设。
// 颜色只由 className 决定，不写内联 style，保证主题切换时仍由样式变量接管。
//
export function McpStatusDot({
  status,
  attention = false,
  disabled = false,
  reason,
}: {
  status?: McpServerStatus;
  attention?: boolean;
  disabled?: boolean;
  reason: string;
}) {
  // 颜色链按固定优先级短路求值：禁用先于连接状态，连接状态先于 attention 兜底。
  // [失败路径] 缺少任一分支都会落到默认灰色，未连接与未知状态在视觉上不再可区分。
  // connected 用绿色、connecting 与 attention 用黄色、error 用红色，与设置页其余状态语义保持一致。
  // 三元嵌套已较深，新增状态时优先改为映射表，避免继续叠加条件。
  // 这里不读取国际化或业务字段，保持纯样式推导，便于复用与测试。
  //
  const color = disabled
    ? "text-foreground-subtlest"
    : status === "connected"
      ? "text-green-500"
      : status === "connecting"
        ? "text-yellow-500"
        : status === "error"
          ? "text-red-500"
          : attention
            ? "text-yellow-500"
            : "text-foreground-subtlest";

  const icon =
    !disabled && status === "connecting" ? (
      <Loader2Icon className={`size-3 shrink-0 animate-spin ${color}`} aria-hidden="true" />
    ) : (
      <CircleIcon className={`size-2.5 shrink-0 fill-current ${color}`} aria-hidden="true" />
    );

  return (
    <ControlHintTooltip title={reason} className="max-w-64">
      <span className="inline-flex cursor-help items-center">{icon}</span>
    </ControlHintTooltip>
  );
}

// 把可选 scope 收敛为 workspace 或 user，未识别的值一律按 user 处理。
// [权衡] 归一化放在渲染前而非类型层，兼容旧数据或远端缺少 scope 的情况。
// [失败路径] 若直接透传，未知值会让徽章查不到文案，出现空白胶囊。
//
function ScopeBadge({ scope }: { scope?: string }) {
  const normalizedScope = scope === "workspace" ? "workspace" : "user";
  return <SettingsScopeBadge scope={normalizedScope} includeMcpTestAttribute />;
}

// 单行投影组件：消费 server 与四个回调，不持有状态，也不自行发起请求。
// 回调均以 ZCodeMcpServer 或 id 为参数，父级据此定位真实数据源，而不是操作行内快照。
// [事务] onToggle 传 id 与新布尔值，父级负责写入与回读，避免本地乐观改写与刷新竞态。
// onOpenAuthorization 可选，缺省时授权入口完全不渲染，调用方无需传占位函数。
// canEdit 由 location.source 决定，缺失 location 视为可编辑，非 zcode 来源一律只读。
// hideMetadata 只隐藏范围徽章与工具数，状态点、失败信息与操作区始终保留。
//
function McpServerItem({
  server,
  onEdit,
  onToggle,
  onOpenAuthorization,
  hideMetadata,
}: {
  server: ZCodeMcpServer;
  onEdit: (server: ZCodeMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZCodeMcpServer) => void;
  hideMetadata: boolean;
}) {
  const { intl } = useZCodeIntl();
  const typeLabel = server.config.command
    ? "stdio"
    : (server.config.type ?? (server.config.url ? "http" : "?"));
  const canEdit = !server.location || server.location.source === "zcode";
  const canOpenAuthorization = Boolean(server.authorization?.authorizationUrl);
  const openAuthorizationLabel = intl.formatMessage({
    id: "settings.mcp.oauth.openAuthorization",
  });
  // 状态文案按 status 逐级选择消息 id，error 分支额外用 failureKind 定位具体失败原因。
  // [失败路径] 未知状态兜底 unknownReason，保证 tooltip 永远不会是空字符串。
  // 文案统一走国际化资源，不在 JSX 中拼硬编码中文，切换语言时同步生效。
  //
  // 调整分支顺序会改变展示结果，例如把 disconnected 放进兜底会丢掉专用说明。
  const statusReason = intl.formatMessage({
    id:
      server.status === "error"
        ? resolveMcpFailureMessageId(server.failureKind)
        : server.status === "connected"
          ? "settings.mcp.status.connectedReason"
          : server.status === "connecting"
            ? "settings.mcp.status.connectingReason"
            : server.status === "disconnected"
              ? "settings.mcp.status.disconnectedReason"
              : "settings.mcp.status.unknownReason",
  });

  const description = server.config.url
    ? `${typeLabel} · ${server.config.url}`
    : server.config.command
      ? `${typeLabel} · ${server.config.command} ${(server.config.args ?? []).join(" ")}`
      : typeLabel;

  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors ${canEdit ? "hover:bg-hover" : ""}`}
      // [事务] 行级点击与键盘激活统一交给 settingsResourceRowInteraction，只读时传 undefined 关闭入口。
      // 该工具函数会忽略来自按钮、开关等交互后代的冒泡，因此授权与启停不会误触整行编辑。
      // 传入回调只上报当前 server，父级负责打开编辑面板，组件不自行导航或写状态。
      // [权衡] 悬停高亮与可点击性共用 canEdit，保证视觉反馈与实际可操作性一致。
      // data-mcp-status 与 data-mcp-tool-count 供状态样式和测试断言使用，重构时不要删除。
      //
      {...settingsResourceRowInteraction(canEdit ? () => onEdit(server) : undefined)}
      data-mcp-status={server.status ?? ""}
      data-mcp-tool-count={server.toolCount}
      data-testid={testId(TID_MCP_SERVER_ROW, server.name)}
    >
      <div
        className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
        data-mcp-status-dot-placement="icon-corner"
      >
        <Cable className="size-4" aria-hidden="true" />
        <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-background">
          <McpStatusDot status={server.status} reason={statusReason} />
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{server.name}</span>
          {!hideMetadata ? <ScopeBadge scope={server.scope} /> : null}
          {!hideMetadata && typeof server.toolCount === "number" && (
            <span className="inline-flex rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle ring-1 ring-border">
              {intl.formatMessage(
                { id: "settings.mcp.status.toolCount" },
                { count: String(server.toolCount) },
              )}
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-ui-sm text-foreground-subtle">{description}</div>
        {server.status === "error" ? (
          <McpFailurePresentation error={server.error} failureKind={server.failureKind} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canOpenAuthorization && (
          <Button
            variant="link"
            size="sm"
            className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
            aria-label={openAuthorizationLabel}
            data-testid={testId(TID_MCP_OPEN_AUTHORIZATION_BUTTON, server.name)}
            title={openAuthorizationLabel}
            onClick={() =>
              runUserAction({
                input: { featureId: "extension.mcp", action: "authorize", trigger: "button" },
                operation: () => onOpenAuthorization?.(server),
                completed: { resultSource: "platform_result" },
                failureStage: "mcp_authorize",
              })
            }
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{openAuthorizationLabel}</span>
          </Button>
        )}
        <Switch checked={server.enabled} onCheckedChange={(v) => onToggle(server.id, v)} />
      </div>
    </div>
  );
}

export function McpServerList({
  servers,
  onCreate,
  onEdit,
  onToggle,
  onOpenAuthorization,
  emptyTitle,
  emptyDescription,
  hideMetadata = false,
}: {
  servers: ZCodeMcpServer[];
  onCreate: () => void;
  onEdit: (server: ZCodeMcpServer) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenAuthorization?: (server: ZCodeMcpServer) => void;
  emptyTitle: string;
  emptyDescription: string;
  hideMetadata?: boolean;
}) {
  const { intl } = useZCodeIntl();

  // [失败路径] 空数组先返回带虚线边框的空态，包含标题、说明与新建按钮三层内容。
  // 标题与说明由 emptyTitle、emptyDescription 注入，本文件不内置业务措辞。
  // 新建按钮复用 onCreate，与父级工具栏入口指向同一动作，不另开创建路径。
  // [权衡] 空态判断必须早于列表委托，SettingsResourceList 在空数组时返回 null，否则整块消失。
  //
  if (servers.length === 0) {
    return (
      <div className="overflow-hidden rounded-xl border border-dashed border-border">
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">{emptyTitle}</div>
            <div className="text-ui-base text-foreground-subtle">{emptyDescription}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <Plus className="size-4" />
            <span>{intl.formatMessage({ id: "settings.mcp.create.open" })}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    // 非空时把渲染委托给 SettingsResourceList，本文件只提供列表身份与逐行内容。
    // getKey 使用 server.id，保证启停或状态刷新时行身份稳定，不被当成新行重挂载。
    // 列表容器自带圆角与行间分隔线，行内不要再补边框，否则出现双线。
    //
    // renderItem 闭包捕获 hideMetadata 与各回调，父级重渲染会同步传给每一行。
    <SettingsResourceList
      items={servers}
      getKey={(server) => server.id}
      renderItem={(server) => (
        <McpServerItem
          server={server}
          onEdit={onEdit}
          onToggle={onToggle}
          onOpenAuthorization={onOpenAuthorization}
          hideMetadata={hideMetadata}
        />
      )}
    />
  );
}
