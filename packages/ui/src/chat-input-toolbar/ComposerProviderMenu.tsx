// INV-01 媒体查询断点 639px 是宽窄两条渲染路径的唯一开关，守住位置 让 JS 订阅与 CSS 断点同源，改错故障 会让窄屏仍渲染 Sub 结构
// INV-02 快照只读取当前断点是否命中，守住位置 让服务端与首帧兜底同为 false，改错故障 会触发水合前后的分支跳变
// INV-03 订阅函数必须返回取消订阅闭包，守住位置 保证监听器随组件卸载成对增删，改错故障 会累积 matchMedia 监听造成泄漏
// INV-04 contents 是窄屏触发项与宽屏子菜单共用的同一份片段，守住位置 保证错误块、单选组、页脚只定义一次，改错故障 会让两处渲染顺序分叉
// INV-05 单选组的值绑定 group?.key，守住位置 让无接入项时呈现未选中态，改错故障 会把随机首项误报为当前接入
// INV-06 分隔线仅在非首项且 key 命中 separatorBeforeKey 时插入，守住位置 避免列表首项前出现孤立横线，改错故障 会产生重复分隔
// INV-07 列表项以目录 key 包裹 Fragment，守住位置 让分隔线与单选项作为整体稳定复用，改错故障 会在重排时丢失单选焦点
// INV-08 选中回调先拦截默认行为再上抛并收起，守住位置 保证受控展开态不被 Radix 自动覆盖，改错故障 会让菜单选择后立刻重开
// INV-09 error 非空时强制展开，守住位置 把失败信息送回用户刚操作的层级，改错故障 会让错误藏在已关闭的子菜单里
// INV-10 子菜单展开态完全受控，守住位置 让窄屏返回项与宽屏 Sub 共享同一状态机，改错故障 会出现双开或无法关闭
// INV-11 展开前偏移使用 {side: 9, align: -5} 兜底，守住位置 保证测量尚未发生时外框仍合理，改错故障 会让首帧子菜单贴边溢出
// INV-12 横向偏移由父菜单右边缘减行右边缘再加 4 推导，守住位置 抵消父菜单内边距与边框，改错故障 会让子菜单与触发行错位
// INV-13 纵向偏移取父菜单顶边与行顶边之差，守住位置 让子菜单首项与触发行顶对齐，改错故障 会出现垂直漂移
// INV-14 测量基准取自 role=menu 的祖先盒子，守住位置 确保偏移相对真正浮层而非文档，改错故障 会在滚动后失真
// INV-15 触发项禁用条件合并显式禁用、加载与空目录无页脚三种，守住位置 保证无可选内容时不可展开，改错故障 会弹出空列表
// INV-16 忙碌标记仅在加载为真时输出，守住位置 避免静态菜单被读屏持续标记为忙，改错故障 会反复播报加载
// INV-17 加载指示器同时服务宽屏触发器尾部与窄屏菜单项尾部，守住位置 保证两种布局的加载态同源，改错故障 会出现图标与状态错配
// INV-18 页脚只在传入页脚节点时渲染且列表非空才追加分隔线，守住位置 防止空列表下出现悬空横线，改错故障 会多出一条分隔
//
// 模块职责：渲染 Composer 的模型接入方菜单，窄屏走单选分步展开，宽屏走 Radix Sub 加 Portal 子菜单
// 状态所有权：展开态与偏移量属于组件本地，当前接入项与错误信息由父级持有并下行
// 阅读顺序：先看断点订阅与共享片段，再看窄屏分支，最后看宽屏测量与浮层定位
import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuPortal,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { TID_CHAT_MODEL_SELECT_GROUP, testId } from "@zcode/shared/test-ids";

const query = "(max-width: 639px)";
// 订阅函数、快照函数与断点常量三件套构成外部状态源，缺一不可
// 快照返回布尔原始值，同值比较自动跳过重渲染，无需额外缓存层
// 每个监听器都需要对应的移除调用，返回的清理闭包不可省略
// 服务端与首帧兜底为假，窄屏判定不会在水合完成前跳变
// 断点数字只在常量处出现一次，样式侧改动时需同步此处
function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const snapshot = () => window.matchMedia(query).matches;

// 合并菜单曾只渲染名称而丢失接入标识；主行和子菜单复用同一目录字段。
// 接入标识来自目录字段 labelBadge，主行标题、触发器与列表项共用本组件
// 无标识时渲染空，父级弹性布局自动收拢，不保留占位宽度
// 最大宽度与截断只作用于视觉，标题属性保留完整文本供悬停与读屏
// 组件不接受尺寸参数，尺寸差异一律由调用方外层控制
function ProviderAccessBadge({ group }: { group: ModelSelectGroup }) {
  return group.labelBadge ? (
    <span
      data-provider-access-badge
      title={group.labelBadge}
      className="max-w-48 shrink-0 truncate rounded-full bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
    >
      {group.labelBadge}
    </span>
  ) : null;
}

export function ComposerProviderMenu({
  groups,
  disabled = false,
  loading = false,
  isDisabled,
  separatorBeforeKey,
  group,
  label,
  providerFooter,
  onSelect,
  children,
  error,
}: {
  groups: readonly ModelSelectGroup[];
  disabled?: boolean;
  loading?: boolean;
  isDisabled?: (group: ModelSelectGroup) => boolean;
  separatorBeforeKey?: string;
  group: ModelSelectGroup | undefined;
  label: string;
  providerFooter?: ReactNode;
  onSelect: (group: ModelSelectGroup) => void;
  children: ReactNode;
  error?: string | null;
}) {
  const { intl } = useZCodeIntl();
  // 断点判定走订阅式读取，窗口跨越 639px 时组件自动切换渲染分支
  // 窄屏分支退化为单选分步，先触发项再列表，宽屏则交给 Radix Sub
  // 该值只参与渲染决策，不产生写入，因此与展开态无需同步
  // 兜底值为假，让无窗口环境走宽屏结构，服务端输出保持确定
  const narrow = useSyncExternalStore(subscribe, snapshot, () => false);
  const [open, setOpen] = useState(false);
  // 切换失败后回到对应操作区域，避免错误藏在已关闭的 Provider 子菜单。
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  const triggerRef = useRef<HTMLDivElement>(null);
  // 默认偏移只在首次展开前的瞬间生效，随后被父菜单与行矩形的差值覆盖
  // 实测偏移在收到展开信号时计算，此时触发节点与浮层均已挂载
  // 父菜单的内边距或边框变化时，默认值与计算式的补偿量需一起复核
  // 偏移存入状态而非引用，Portal 内子菜单才能跟随重新定位
  const [offset, setOffset] = useState({ side: 9, align: -5 });
  // 该片段被窄屏分支与子菜单内容各自独立挂载，同一时刻只有一条路径命中
  // 错误块位于单选组之前，列表滚动时失败信息仍固定可见
  // 列表的最小高度与纵向滚动让内容在可用高度内收敛，不撑破浮层
  // 页脚与列表是兄弟节点，仅在页脚存在时追加分隔线
  const contents = (
    <>
      {error ? (
        <div role="alert" className="px-2 py-1 text-ui-sm text-destructive">
          {error}
        </div>
      ) : null}
      <DropdownMenuRadioGroup
        // 单选组的值取当前接入键，父级未命中任何目录项时为空
        // 空值让全部选项保持未选中，避免默认高亮首项造成误判
        // 目录刷新导致键消失时选中态自然清空，无需额外副作用
        // 该组只读，所有变更统一经由选中回调上抛
        value={group?.key}
        data-composer-provider-list
        className="min-h-0 overflow-y-auto"
      >
        {groups.map((candidate, index) => (
          // 每项用 Fragment 包裹，使分隔线与单选项作为同一键的连续兄弟
          // 键取目录字段而非下标，目录重排时列表项身份不变、焦点不丢
          // 分隔线条件依赖当前键与指定键相等，故键必须与目录字段一致
          // 下标只用于判断是否首项，不参与键计算
          <Fragment key={candidate.key}>
            {index > 0 && candidate.key === separatorBeforeKey ? (
              // 原因：默认负边距会撑出滚动列表 4px；列表内分隔线必须留在横向边界内。
              <DropdownMenuSeparator className="mx-0 shrink-0 bg-border/50" />
            ) : null}
            <DropdownMenuRadioItem
              disabled={disabled || isDisabled?.(candidate)}
              value={candidate.key}
              aria-label={[candidate.label, candidate.labelBadge].filter(Boolean).join(" ")}
              data-testid={testId(TID_CHAT_MODEL_SELECT_GROUP, candidate.key)}
              data-model-provider-key={candidate.key}
              className="min-h-8 gap-2 pl-2 pr-8"
              onSelect={(event) => {
                event.preventDefault();
                onSelect(candidate);
                setOpen(false);
              }}
            >
              {/* 名称不占满剩余空间，避免把接入标签推到行尾。 */}
              <span className="min-w-0 whitespace-normal break-words">{candidate.label}</span>
              <ProviderAccessBadge group={candidate} />
            </DropdownMenuRadioItem>
          </Fragment>
        ))}
      </DropdownMenuRadioGroup>
      {providerFooter ? (
        <>
          {groups.length > 0 ? <DropdownMenuSeparator className="shrink-0 bg-border/50" /> : null}
          <div className="shrink-0">{providerFooter}</div>
        </>
      ) : null}
    </>
  );
  const title = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {group ? <ProviderLogo logo={group.logo} className="size-4" /> : null}
      <span className="truncate">{group?.label ?? "—"}</span>
      {group ? <ProviderAccessBadge group={group} /> : null}
    </span>
  );
  const loadingIndicator = loading ? (
    <span
      data-testid="composer-provider-loading"
      role="status"
      aria-label={intl.formatMessage({ id: "common.loading" })}
      className="ml-auto inline-flex size-4 shrink-0 items-center justify-center text-foreground-subtle"
    >
      <Loader2Icon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
    </span>
  ) : undefined;
  // 触发属性集中构造，窄屏菜单项与宽屏子菜单触发器完全共享
  // 禁用条件合并显式禁用、加载与空目录无页脚三种情况
  // 忙碌标记仅在加载时输出，静态菜单不被读屏标记为忙
  // 高亮挂在数据属性上，使受控展开态与悬停态呈现同一背景
  const triggerProps = {
    "data-testid": "composer-provider-trigger",
    "aria-label": `${label}: ${group?.label ?? "—"}`,
    disabled: disabled || loading || (!group && !providerFooter),
    "aria-busy": loading || undefined,
    className:
      "min-h-8 gap-3 data-[highlighted]:bg-menu-hover/50 data-[state=open]:bg-menu-hover/50",
  };
  if (narrow)
    return open ? (
      <>
        <DropdownMenuItem
          data-testid="composer-provider-back"
          className="shrink-0"
          onSelect={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <ChevronLeftIcon />
          {intl.formatMessage({ id: "common.back" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="shrink-0 bg-border/50" />
        {contents}
      </>
    ) : (
      <>
        <DropdownMenuItem
          {...triggerProps}
          onSelect={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          {title}
          {loadingIndicator ?? (
            <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle" />
          )}
        </DropdownMenuItem>
        {children}
      </>
    );
  return (
    <>
      <DropdownMenuSub
        open={open}
        // 展开前先量父菜单与触发行的矩形，差值同时补偿内边距、边框与 4px 间隙
        // 测量只在展开信号为真时执行，收起路径不读布局，避免强制同步重排
        // 祖先浮层按菜单角色定位，偏移始终相对真正的菜单盒子
        // 写入偏移与写入展开态在同一帧完成，子菜单首帧即落在正确位置
        onOpenChange={(next) => {
          if (next && triggerRef.current) {
            const row = triggerRef.current.getBoundingClientRect();
            const menu = triggerRef.current.closest('[role="menu"]')!.getBoundingClientRect();
            // 子菜单默认锚定行的内边缘；补偿父菜单 padding/border 后外框对齐并留 4px。
            setOffset({ side: menu.right - row.right + 4, align: menu.top - row.top });
          }
          setOpen(next);
        }}
      >
        <DropdownMenuSubTrigger {...triggerProps} ref={triggerRef} indicator={loadingIndicator}>
          {title}
        </DropdownMenuSubTrigger>
        <DropdownMenuPortal>
          <DropdownMenuSubContent
            sideOffset={offset.side}
            alignOffset={offset.align}
            collisionPadding={12}
            className="z-[61] w-max min-w-0 max-w-(--radix-dropdown-menu-content-available-width) max-h-(--radix-dropdown-menu-content-available-height) [app-region:no-drag]"
          >
            {contents}
          </DropdownMenuSubContent>
        </DropdownMenuPortal>
      </DropdownMenuSub>
      {children}
    </>
  );
}
