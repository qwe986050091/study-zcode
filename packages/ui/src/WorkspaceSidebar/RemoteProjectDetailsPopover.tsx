// INV-01 单一浮层：守住位置 悬停与点击共用同一浮层；改错故障：提示与菜单竞争焦点。
// INV-02 虚拟锚点：守住位置 锚点对象与真实行元素；改错故障：详情定位到窗口原点。
// INV-03 自动锚点覆盖：守住位置 虚拟锚点节点；改错故障：退场的自动锚点仍指向旧节点。
// INV-04 悬停延迟：守住位置 进入定时器；改错故障：略过即弹或永不弹出。
// INV-05 离开宽限：守住位置 离开延时关闭；改错故障：指针跨过缝隙时闪烁关闭。
// INV-06 触屏排除：守住位置 指针类型判断；改错故障：触屏点按触发悬停态。
// INV-07 点击固定：守住位置 固定函数；改错故障：点击后仍被离开事件关闭。
// INV-08 焦点接管：守住位置 关闭自动聚焦处理；改错故障：浮层关闭后焦点丢失。
// INV-09 焦点回填：守住位置 关闭后的焦点归位判断；改错故障：焦点落到已卸载节点。
// INV-10 外部点击：守住位置 点击冒泡阻断；改错故障：点击详情同时选中侧栏行。
// INV-11 禁用清理：守住位置 禁用副作用；改错故障：禁用后定时器仍触发打开。
// INV-12 卸载清理：守住位置 副作用返回的清理；改错故障：卸载后定时器回调操作已卸载组件。
// INV-13 标签来源：守住位置 触发器的无障碍标签；改错故障：读屏只读出项目名，缺少功能说明。
// INV-14 状态描述：守住位置 隐藏状态文本；改错故障：连接状态无法被读屏获取。
// INV-15 文案分支：守住位置 在线与恢复状态的取值；改错故障：恢复文案丢失占位参数。
// INV-16 样式分支：守住位置 在线与离线的类名组合；改错故障：离线行看不出异常。
// INV-17 动作包装：守住位置 关闭后执行回调；改错故障：操作后浮层残留。
// INV-18 内容标识：守住位置 详情容器的数据属性；改错故障：多行同名项目无法区分定位。
//
// 模块职责：为侧栏远程项目行提供悬停与点击共用的连接详情浮层。
// 状态所有权：展开方式与定时器归组件；连接状态与动作回调由父层传入。
// 阅读顺序：属性 → 锚点与定时器 → 打开关闭逻辑 → 触发器 → 浮层内容。
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import { RemoteProjectConnectionDetails } from "@/WorkspaceSidebar/RemoteProjectConnectionDetails.js";

/** 悬停和点击共享一个浮层，锚定项目整行；不让 Tooltip 与菜单竞争焦点。 */
// 详情浮层：悬停打开、离开延时关闭，点击则固定，两种方式共用同一实例。
// 锚点使用行元素而非触发器，触发器随内容变化会改变位置。
// 定时器只在展开方式变化时重置，避免每次渲染都重建。
// disabled 为真时立即收起并 clearTimer，解除后再重新参与 hover。
//
export function RemoteProjectDetailsPopover({
  anchorRef,
  tab,
  deviceName,
  presentation,
  error,
  disabled = false,
  onConnect,
  onDisconnect,
  onEdit,
  onManage,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  tab: WorkspaceTabState;
  deviceName: string;
  presentation: RemoteConnectionPresentation;
  error?: string;
  disabled?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onEdit?: () => void;
  onManage?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const statusId = useId();
  // mode 显式记录 hover 或 click，null 表示关闭。
  // 方式决定离开事件是否生效，点击固定后离开不再关闭。
  // 打开状态由「非禁用且方式非空」推导，不再单独存布尔值。
  //
  const [mode, setMode] = useState<"hover" | "click" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clicked = useRef(false);
  // 虚拟锚点：把真实行元素包装成浮层可识别的定位对象。
  // 行元素变化时重建锚点，保证详情跟随当前行。
  // 没有行元素时返回空值，由自动锚点兜底。
  //
  const anchor = useMemo(
    () => ({
      current: {
        // 虚拟锚点仍需真实行元素，Floating UI 才能订阅侧栏滚动和布局变化。
        get contextElement() {
          return anchorRef.current ?? undefined;
        },
        getBoundingClientRect: () => anchorRef.current?.getBoundingClientRect() ?? new DOMRect(),
      },
    }),
    [anchorRef],
  );
  // 清理计时：进入与离开两个定时器一起清，避免残留的打开请求覆盖关闭。
  // disabled 与卸载都复用 clearTimer。
  //
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const close = () => {
    clearTimer();
    setMode(null);
  };
  const pin = () => {
    clearTimer();
    clicked.current = true;
    setMode("click");
  };
  useEffect(() => {
    if (disabled) {
      clearTimer();
      setMode(null);
    }
    return clearTimer;
  }, [disabled]);
  const leave = () => {
    clearTimer();
    if (mode === "hover") timer.current = setTimeout(close, 150);
  };
  // 动作包装：先关闭浮层再执行回调，保证操作后浮层不残留。
  // callback 可选，仅关闭浮层时也可以调用。
  //
  const action = (callback?: () => void) =>
    callback
      ? () => {
          close();
          callback();
        }
      : undefined;
  return (
    <Popover
      // open 条件：disabled 时无论 mode 是什么都不展示。
      // 条件写在受控属性上，任何打开路径都受同一约束。
      //
      open={!disabled && mode !== null}
      onOpenChange={(open) => {
        clearTimer();
        if (open) clicked.current = true;
        setMode(open ? "click" : null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-remote-project-details-trigger
          aria-describedby={statusId}
          aria-label={intl.formatMessage(
            { id: "workspaceSidebar.connectionDetails" },
            { device: deviceName },
          )}
          className={cn(
            "ml-auto flex h-6 min-w-0 max-w-24 items-center rounded-sm px-1 text-ui-xs",
            presentation.status === "online"
              ? "text-remote-foreground-muted"
              : [presentation.foreground, presentation.surface],
          )}
          onPointerEnter={(event) => {
            clearTimer();
            if (!disabled && !mode && event.pointerType !== "touch") {
              timer.current = setTimeout(() => {
                clicked.current = false;
                setMode("hover");
              }, 400);
            }
          }}
          onPointerLeave={leave}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (mode === "hover") {
              event.preventDefault();
              pin();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
        >
          <span id={statusId} className="sr-only">
            {presentation.recovery
              ? intl.formatMessage({ id: presentation.recovery.messageId }, presentation.recovery.values)
              : intl.formatMessage({ id: presentation.shortMessageId })}
          </span>
          <span className="truncate">
            {presentation.status === "online"
              ? deviceName
              : presentation.recovery
                ? intl.formatMessage(
                    { id: presentation.recovery.shortMessageId },
                    presentation.recovery.values,
                  )
                : intl.formatMessage({ id: presentation.shortMessageId })}
          </span>
        </button>
      </PopoverTrigger>
      {/* Radix 首帧会为 Trigger 自动注册锚点；虚拟锚点必须随后覆盖它，
          否则自动锚点退场后仍指向旧节点，详情会错误定位到窗口原点。 */}
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        data-remote-project-details={tab.workspaceIdentity ?? tab.workspacePath}
        side="right"
        align="start"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-24px)] p-3"
        onPointerEnter={clearTimer}
        onPointerLeave={leave}
        onFocusCapture={pin}
        onOpenAutoFocus={(event) => {
          if (mode === "hover") event.preventDefault();
        }}
        // onCloseAutoFocus 先 preventDefault 再判断，行仍聚焦时把焦点还给行元素。
        // 行已卸载时直接放弃，避免焦点落到文档根部。
        // 回填只针对 anchorRef 指向的行元素，浮层内按钮不参与。
        //
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // 详情切换后不夺取新浮层焦点；悬停关闭也不改变原键盘焦点。
          const row = anchorRef.current;
          const active = row?.ownerDocument.activeElement;
          if (
            clicked.current &&
            row &&
            (active === row.ownerDocument.body || row.contains(active ?? null))
          )
            row.focus();
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          pin();
        }}
      >
        <RemoteProjectConnectionDetails
          tab={tab}
          deviceName={deviceName}
          presentation={presentation}
          error={error}
          onConnect={action(onConnect)}
          onDisconnect={action(onDisconnect)}
          onEdit={action(onEdit)}
          onManage={action(onManage)}
        />
      </PopoverContent>
    </Popover>
  );
}
