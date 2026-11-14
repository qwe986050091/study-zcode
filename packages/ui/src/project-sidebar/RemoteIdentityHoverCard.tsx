// INV-01 悬停结束即关闭：守住位置 scheduleClose；改错故障 浮层常驻遮挡列表。
// INV-02 关闭保留缓冲延迟：守住位置 关闭延迟常量；改错故障 移向详情途中闪关。
// INV-03 进入详情取消关闭：守住位置 cancelClose；改错故障 无法选中详情文字。
// INV-04 离开详情重新计时：守住位置 指针离开回调；改错故障 浮层永不关闭。
// INV-05 菜单内失焦不算离开：守住位置 焦点目标判断；改错故障 鼠标进详情即被关闭。
// INV-06 无新焦点不立即关：守住位置 详情标记判断；改错故障 点击文字复制即消失。
// INV-07 主机换代即重置：守住位置 effect 依赖主机标识；改错故障 旧设备详情残留。
// INV-08 无主机直接渲染子节点：守住位置 空值返回；改错故障 本地项目出现空浮层。
// INV-09 定位读取菜单外沿：守住位置 锚点矩形测量；改错故障 浮层与菜单错位。
// INV-10 无菜单回退行矩形：守住位置 三元回退；改错故障 普通列表浮层偏移。
// INV-11 锚点仅在菜单模式启用：守住位置 菜单锚点开关；改错故障 非菜单场景多出虚拟锚点。
// INV-12 连接状态先经协议解析：守住位置 协议校验；改错故障 未知状态直入展示层。
// INV-13 解析失败回退主机状态：守住位置 空值合并；改错故障 浮层状态显示空白。
// INV-14 升级目标透传展示层：守住位置 升级目标字段；改错故障 操作名与设备卡矛盾。
// INV-15 状态文案用短消息：守住位置 短消息标识；改错故障 浮层出现过长的泛化文案。
// INV-16 恢复参数单独传递：守住位置 参数映射；改错故障 占位符未被替换。
// INV-17 待处理才显示设置入口：守住位置 待处理判断；改错故障 正常设备出现无意义按钮。
// INV-18 本组件不写入主机状态：守住位置 只读投影；改错故障 悬停触发连接副作用。
//
// 模块职责：远端项目身份的悬停详情卡，展示设备、连接与路径信息。
// 状态所有权：开关与关闭计时为局部状态；主机数据由调用方传入且只读。
// 阅读顺序：先看常量与锚点，再读开关时序，最后看展示投影与内容结构。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { ChevronRight, Settings } from "lucide-react";
import { Anchor, createPopperScope } from "@radix-ui/react-popper";
import { sourceServerConnectionStateSchema } from "@zcode/shared";
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { RemoteConnectionProgressSection } from "@/project-sidebar/RemoteConnectionProgressSection.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatRemoteProjectConnectionAddress,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";

const CLOSE_DELAY_MS = 100;
const useHoverCardScope = HoverCardPrimitive.createHoverCardScope();
const usePopperScope = createPopperScope();

/**
 * 项目模型迁移曾漏接详情；项目入口只读同一 Host，悬停结束即关闭，不保存点击锁定状态。
 * 待处理设备只提供定位设置的入口，实际处理仍由设置页设备卡完成。
 */
export function RemoteIdentityHoverCard({
  host,
  title,
  projectName,
  deviceName,
  paths,
  connectionError,
  anchorToMenu = false,
  contentClassName,
  onOpenDeviceSettings,
  children,
}: {
  host?: RemoteProjectHost;
  title: string;
  projectName?: string;
  deviceName?: string;
  paths: readonly string[];
  /** 项目行已合并旧 workspace 错误的连接错误；缺省读 Host 投影。 */
  connectionError?: string;
  anchorToMenu?: boolean;
  contentClassName?: string;
  onOpenDeviceSettings?: () => void;
  children: ReactElement;
}) {
  const { intl } = useZCodeIntl();
  const scope = useHoverCardScope(undefined);
  const popperScope = usePopperScope(scope.__scopeHoverCard);
  const trigger = useRef<HTMLAnchorElement>(null);
  // 固定偏移会把不存在的滚动条也算进去；让定位器直接读取菜单外沿，仍以行高确定纵向位置。
  // menuAnchor.contextElement 返回 trigger.current，浮层跟随触发节点而非文档流。
  // getBoundingClientRect 先量 trigger.current 的 bounds，作为纵向定位基准。
  // 菜单矩形用 row.closest 读最近 [role=menu]，嵌套菜单不跨层取宽度。
  // 命中菜单时横向取 menu.width，纵向仍用行高 bounds.height。
  // 纵向位置始终取 bounds.top 与行高，菜单高度不参与定位。
  // menuAnchor 作为 virtualRef 虚拟锚点，不向 DOM 插入任何节点。
  const menuAnchor = useRef({
    get contextElement() {
      return trigger.current ?? undefined;
    },
    getBoundingClientRect() {
      const row = trigger.current;
      if (!row) return new DOMRect();
      const bounds = row.getBoundingClientRect();
      const menu = row.closest('[role="menu"]')?.getBoundingClientRect();
      return menu ? new DOMRect(menu.left, bounds.top, menu.width, bounds.height) : bounds;
    },
  });
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const overDetails = useRef(false);
  const cancelClose = () => clearTimeout(closeTimer.current);
  // scheduleClose 先调 cancelClose 清掉 closeTimer.current，避免两次计时叠加。
  // 计时器到期才 setOpen(false)，期间任何指针进入都会取消。
  // 指针重新进入时由 cancelClose 取消计时，不累积多次关闭。
  // 延迟值统一取 CLOSE_DELAY_MS，openDelay 与 closeDelay 共用一个常量。
  // 关闭只写 setOpen 局部状态，不通知调用方。
  // 该回调不发起网络请求，主机数据仍由上层只读传入。
  const scheduleClose = () => {
    cancelClose();
    // Radix 会因文字选区跳过关闭；身份浮层只按离开区域关闭，保留跨区缓冲和复制能力。
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  // host.id 变化时立刻 setOpen(false)，旧浮层不跨设备残留。
  // 同时把 overDetails.current 复位，新旧设备不共用详情标记。
  // 卸载时 clearTimeout(closeTimer.current)，防止卸载后仍触发 setOpen。
  // 依赖数组只含 host?.id，其他字段变化不重建计时器。
  // 该 effect 无返回值。
  useEffect(() => {
    // Host 消失或换代时撤销旧浮层，不能在设备重新出现后恢复旧的展示状态。
    setOpen(false);
    overDetails.current = false;
    return () => clearTimeout(closeTimer.current);
  }, [host?.id]);
  if (!host) return children;
  const msg = (id: string) => intl.formatMessage({ id });
  const error = connectionError ?? host.lastConnectionError;
  // lastConnectionStatus 先过 sourceServerConnectionStateSchema.safeParse。
  // 解析结果为空时回退 host.connectionStatus，浮层不显示空白。
  // upgradeTarget 原样透传，操作名由展示层按升级目标选择。
  // projectError 与 host.lastConnectionError 合并成 error，项目错误优先。
  // presentation 只读投影，本组件不改写 host 上的字段。
  const presentation = resolveRemoteConnectionPresentation({
    state:
      sourceServerConnectionStateSchema.safeParse(host.lastConnectionStatus).data ??
      host.connectionStatus,
    // 修复原因：缺少 upgradeTarget 时操作名固定回退成“更新远端”，与设置页设备卡矛盾。
    upgradeTarget: host.upgradeTarget,
    projectError: error,
  });
  return (
    <HoverCard
      {...scope}
      open={open}
      onOpenChange={setOpen}
      openDelay={300}
      closeDelay={CLOSE_DELAY_MS}
    >
      <HoverCardTrigger
        {...scope}
        ref={trigger}
        asChild
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onFocus={cancelClose}
        onBlur={(event) => {
          // 菜单移出条目时会把焦点收回容器，这不是离开详情；关闭交给指针移出处理，
          // 同时阻止 Radix 默认失焦关闭，否则鼠标进入详情后仍会被菜单的焦点回收关闭。
          const menu = event.currentTarget.closest('[role="menu"]');
          if (menu && event.relatedTarget === menu) {
            event.preventDefault();
            return;
          }
          // 点击详情文字会让按钮失焦但没有新焦点；仍在详情内时保留选择和复制。
          if (event.relatedTarget || !overDetails.current) scheduleClose();
        }}
      >
        {children}
      </HoverCardTrigger>
      {anchorToMenu && open ? <Anchor {...popperScope} virtualRef={menuAnchor} /> : null}
      <HoverCardContent
        {...scope}
        data-testid="remote-identity-details"
        role="tooltip"
        side="right"
        align="start"
        onPointerEnter={() => {
          overDetails.current = true;
          cancelClose();
        }}
        onPointerLeave={() => {
          overDetails.current = false;
          scheduleClose();
        }}
        className={cn("w-80 max-w-[calc(100vw-2rem)] rounded-xl p-3 text-ui-sm", contentClassName)}
      >
        <div className="flex min-w-0 items-center gap-3 border-b border-border pb-3">
          <strong className="min-w-0 flex-1 break-words font-medium">{title}</strong>
          {/* 修复原因：曾显示 pending 的泛化文案“需要处理”，看不出要更新、安装还是确认身份；改用与项目行一致的短状态。 */}
          <span className={presentation.foreground}>
            {intl.formatMessage({ id: presentation.shortMessageId }, presentation.recovery?.values)}
          </span>
        </div>
        <RemoteConnectionProgressSection host={host} status={presentation.status} error={error} />
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
          {projectName ? (
            <>
              <dt className="text-remote-foreground-muted">{msg("project.name")}</dt>
              <dd className="break-words">{projectName}</dd>
            </>
          ) : null}
          <dt className="text-remote-foreground-muted">{msg("workspaceSidebar.projectDevice")}</dt>
          <dd className="break-words">{deviceName || remoteHostLabel(host)}</dd>
          <dt className="text-remote-foreground-muted">{msg("workspaceSidebar.projectLine")}</dt>
          <dd>{msg(`remote.kind.${host.kind}`)}</dd>
          <dt className="text-remote-foreground-muted">
            {msg("settings.source.connectionAddress")}
          </dt>
          <dd className="break-all font-mono">
            {host.target ? formatRemoteProjectConnectionAddress(host.target) : "—"}
          </dd>
          <dt className="text-remote-foreground-muted">{msg("workspaceSidebar.projectPath")}</dt>
          <dd className="min-w-0 break-all font-mono">
            {paths.map((path) => (
              <div key={path}>{path}</div>
            ))}
          </dd>
        </dl>
        {presentation.status === "pending" && onOpenDeviceSettings ? (
          <button
            type="button"
            data-testid="remote-identity-device-settings"
            className={cn(
              "mt-3 flex w-full items-center gap-1.5 border-t border-border pt-3 text-left hover:underline",
              presentation.foreground,
            )}
            onClick={() => {
              setOpen(false);
              onOpenDeviceSettings();
            }}
          >
            <Settings aria-hidden="true" className="size-3.5" />
            <span className="min-w-0 flex-1 break-words">{msg(presentation.actionMessageId)}</span>
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
