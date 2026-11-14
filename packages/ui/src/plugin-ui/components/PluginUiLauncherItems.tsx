// INV-01 启动项 key 由插件 id 与界面 id 拼成，不含序号；守住位置：buildPluginUiLauncherItemId；改错故障：重渲染后 key 漂移，行节点被重建并丢失焦点与进度态。
// INV-02 key 前缀固定 plugin-ui:，与内置应用条目区分；守住位置：buildPluginUiLauncherItemId 返回串；改错故障：插件项与内置项撞 key，列表出现重复行或错位。
// INV-03 列表顺序沿用 entries 给出的推荐顺序，组件内不再排序；守住位置：PluginUiLauncherItems 渲染入口；改错故障：本地再排序会让商店优先级失效，用户看到与推荐不一致的名次。
// INV-04 草稿态不产生任何启动项；守住位置：sessionId 为空的分支；改错故障：草稿页出现无法打开的插件入口。
// INV-05 无可用条目时网格给空态文案、菜单返回 null；守住位置：空列表出口分支；改错故障：菜单里出现空白占位或不可点击的空行。
// INV-06 加载态判断先于空态判断；守住位置：loading 分支；改错故障：首次加载闪出「无插件」再跳成列表。
// INV-07 骨架屏固定八格，数量与真实条目解耦；守住位置：占位数组；改错故障：骨架随数据抖动，容器高度反复跳动。
// INV-08 忙碌态按插件粒度计算，不按整表；守住位置：isBusy 赋值处；改错故障：装一个插件时全部入口转圈并被禁用。
// INV-09 忙碌期间该行同时禁用并暴露 aria-busy；守住位置：菜单项与行组件的 disabled；改错故障：重复点击触发并发安装，读屏用户听不到进行中状态。
// INV-10 未安装或未启用的点击只走准备流程，不打开面板；守住位置：open 内首个分支；改错故障：未就绪插件被强行打开，出现空白标签页。
// INV-11 沙箱缺失、远程会话、远程身份三者任一命中即拦截；守住位置：open 的能力判断；改错故障：远程环境打开本地面板，渲染必然失败。
// INV-12 解析结果以 undefined 与 falsy 区分「无需提示」和「不可用」；守住位置：resolveSurface 结果分支；改错故障：取消路径也弹不可用提示，或真不可用静默失败。
// INV-13 打开请求的 parentSessionId 必为已确认的非空会话；守住位置：sessionId 收窄处；改错故障：面板挂在空会话上，回放与恢复都对不上。
// INV-14 workspaceIdentity 仅在存在时并入请求；守住位置：请求对象展开处；改错故障：空串身份覆盖路径身份，跨 workspace 串数据。
// INV-15 remoteSessionId 缺省归一为 null；守住位置：请求对象字段；改错故障：undefined 与 null 两种形态让下游判断分叉。
// INV-16 标题优先取界面标题，缺失回退条目展示名；守住位置：title 计算；改错故障：多界面插件所有行同名，用户无法区分。
// INV-17 图标优先用市场头像，缺失才用拼图占位；守住位置：SidePaneLauncherRow 的 avatar 回退；改错故障：品牌图被忽略，列表回到一排相同图标。
// INV-18 整行只包一个按钮，尾部胶囊仅作视觉；守住位置：SidePaneLauncherRow 结构；改错故障：按钮嵌套导致点击冒泡双触发。
// 本文件承载「打开标签页」的插件入口：筛选可用界面、维持 key 稳定、把点击收敛到唯一的 open 分发。
// 菜单与网格两种形态共用同一份数据与同一个 open，差异只在容器、文案与点击后是否收起。
//
import { documentViewerInstance } from "@/plugin-ui/contract.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { useRecommendedUiPlugins } from "@/plugin-ui/adapters/useRecommendedUiPlugins.js";
import { resolveItemDisplayName, resolveItemDescription } from "@/settings/pluginStoreListing.js";
import { useEffect, type ReactNode } from "react";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { PuzzleIcon, type LucideIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/adapters/usePluginUiSurfaces.js";

export interface PluginUiLauncherItemsProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 正式会话 id；草稿态为 null，此时不显示入口（面板是会话级，第一版不支持草稿）。 */
  sessionId: string | null;
  onOpenPluginUi: (request: OpenPluginUiSideTabRequest) => void;
  /** 菜单复用标准菜单项；空白页与内置应用共用 SidePaneLauncherRow。 */
  variant?: "launcher" | "menu";
}

// ID 构造是列表 key 的唯一来源，插件 id 与界面 id 都要参与。
// 只用插件 id 会让多界面插件互相顶掉，最后只剩一行可见。
// [权衡] 拼接串便于调试且能直接复用为 data 属性，代价是改格式等于改 key。
// 调整格式前先确认无持久化依赖，否则历史选择会失配。
export function buildPluginUiLauncherItemId(pluginId: string, surfaceId: string): string {
  // 前缀带 plugin-ui:，让侧栏能区分插件入口与内置应用入口。
  // 分隔符用斜杠保持可读，不要换成可能被 id 内部占用的字符。
  // [资源] 返回值同时用于 key 与 data 属性，两侧保持一致才能定位到行。
  return `plugin-ui:${pluginId}/${surfaceId}`;
}

/**
 * "打开标签页"里的插件面板入口，与内建项共用列表/网格。
 * 旧分组容器会占据一个网格单元，导致插件全部挤在同一列；使用 Fragment 让按钮直接参与父级布局。
 */
// 组件只做展示与分发，数据与忙碌态都来自 useRecommendedUiPlugins 适配层。
// 面板是会话级能力，所以会话 id 是渲染前提，而不是可选装饰。
// [并发] 安装与启用可能同时在跑，忙碌态必须按条目粒度读取。
// 不另存一份 entries 缓存，避免与适配层的刷新节奏形成两份真相。
export function PluginUiLauncherItems(props: PluginUiLauncherItemsProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const {
    entries,
    loading,
    prepare,
    resolveSurface,
    isBusy: isPluginBusy,
    error,
  } = useRecommendedUiPlugins(props);
  // error 只以一次 toast 暴露，不阻断后续列表渲染。
  // [失败路径] 依赖的是 error 对象本身，同一对象重复上报才不会再弹。
  // 提示走 toast 而非内联，避免提示条挤压列表行高。
  useEffect(() => {
    if (error) toast(error, { variant: "warning" });
  }, [error]);
  // 加载分支必须排在空态之前，否则首屏会误报没有插件。
  // 菜单与网格使用不同骨架，但共用同一个 loading 判定。
  // 骨架用 aria-hidden 且无事件处理器，点击不穿透到真实行。
  if (loading) {
    const label = intl.formatMessage({ id: "common.loading" });
    if (props.variant === "menu")
      return (
        <DropdownMenuItem disabled aria-label={label} data-testid="side-pane-ui-loading">
          <span
            aria-hidden="true"
            className="h-4 w-40 motion-safe:animate-pulse rounded bg-surface"
          />
        </DropdownMenuItem>
      );
    return (
      <div
        role="status"
        aria-label={label}
        data-testid="side-pane-ui-loading"
        className="col-span-full grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2"
      >
        {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
          <div
            key={index}
            aria-hidden="true"
            className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 motion-safe:animate-pulse"
          >
            <span className="size-12 shrink-0 rounded-xl bg-surface" />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block h-4 max-w-full rounded-sm bg-surface",
                  index % 2 === 0 ? "w-24" : "w-32",
                )}
              />
              <span className="mt-1.5 block h-3 w-36 max-w-full rounded-sm bg-surface" />
            </span>
            <span className="h-6 w-11 shrink-0 rounded-full bg-surface" />
          </div>
        ))}
      </div>
    );
  }
  // sessionId 为空或 entries 为空共用一个出口，都不产出可点击入口。
  // 菜单形态返回 null，让父级菜单自然收紧，不留空白项。
  // 网格形态回退为一句空态文案，保证容器内有可见内容。
  // [失败路径] 不要把空态改成禁用按钮，用户会误以为仍在加载。
  if (props.sessionId === null || entries.length === 0)
    return props.variant === "menu" ? null : (
      <p className="text-ui-base text-foreground-subtle" data-testid="side-pane-ui-empty">
        {intl.formatMessage({ id: "sidePane.launcher.empty" })}
      </p>
    );
  const sessionId = props.sessionId;
  return (
    <>
      {entries.map(({ pluginId, surfaceId, item }) => {
        // uiSurfaces 可能整体缺失，先按 surfaceId 精确查找再决定标题。
        // [失败路径] 找不到时不要隐藏该行，退回条目展示名后它依然可用。
        // 只在 uiSurfaces 内匹配，不顺带匹配服务名，避免误命中同名的另一个界面。
        // 查找是线性扫描，条目量级很小，不需要额外索引。
        const surface = item.info?.uiSurfaces?.find((candidate) => candidate.id === surfaceId);
        const title = surface
          ? resolvePluginUiSurfaceTitle(surface.title, locale)
          : resolveItemDisplayName(item, locale);
        const itemId = buildPluginUiLauncherItemId(pluginId, surfaceId);
        // 原入口只替换加载文案，缺少持续可见的进度；图标与文案共用当前插件的忙碌态。
        const isBusy = isPluginBusy(item);
        const actionLabel = intl.formatMessage({
          id: isBusy
            ? "common.loading"
            : !item.installed
              ? "settings.plugins.store.install"
              : !item.info?.enabled
                ? "settings.plugins.store.menu.enable"
                : "settings.plugins.store.ui.open",
        });
        // open 分发只此一处，菜单与网格分支都复用它。
        // 顺序固定：先补齐安装或启用，再判环境能力，最后解析并打开。
        // 每条失败路径都提前返回，不留半开状态。
        const open = async () => {
          // 未就绪时只触发准备流程，不进入面板打开链路。
          // [事务] 准备是异步的，本行先转入忙碌态，成功后才出现可打开的文案。
          // 菜单分支在未就绪时还需 event.preventDefault 阻止默认收起。
          // 未安装或未启用时不要打开面板，只调用 prepare。
          if (!item.installed || !item.info?.enabled) {
            void prepare(item);
            return;
          }
          if (
            // 能力缺失、远程会话、远程身份任一成立都视为不支持。
            // [失败路径] 统一提示不支持，而不是抛异常让入口静默消失。
            // 判断放在解析之前，避免为注定失败的场景去拉资源。
            !platform?.pluginSandbox ||
            props.remoteSessionId ||
            isRemoteWorkspaceIdentity(props.workspaceIdentity ?? "")
          ) {
            toast(intl.formatMessage({ id: "settings.plugins.store.ui.unsupported" }));
            return;
          }
          const resolved = await resolveSurface(pluginId, surfaceId);
          if (resolved === undefined) return;
          if (!resolved) {
            toast(intl.formatMessage({ id: "settings.plugins.store.ui.unavailable" }));
            return;
          }
          // 请求体字段全部来自解析结果，不在这里二次推断。
          // 身份字段按存在性展开，缺省时不写入空串。
          // [资源] 打开后由宿主接管生命周期，本组件不持有任何句柄。
          props.onOpenPluginUi({
            parentSessionId: sessionId,
            surfaceId: resolved.id,
            serverName: resolved.server,
            pluginId: resolved.pluginId,
            resourceUri: resolved.resourceUri,
            ...documentViewerInstance(resolved.resourceUri),
            title: resolvePluginUiSurfaceTitle(resolved.title, locale),
            workspacePath: props.workspacePath,
            ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
            remoteSessionId: props.remoteSessionId ?? null,
          });
        };
        if (props.variant === "menu") {
          return (
            <DropdownMenuItem
              key={itemId}
              data-side-pane-add-item={itemId}
              onSelect={(event) => {
                if (!item.installed || !item.info?.enabled) event.preventDefault();
                void open();
              }}
              disabled={isBusy}
              aria-busy={isBusy || undefined}
            >
              <PuzzleIcon className="size-4 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <span className="flex items-center gap-1.5 text-foreground-subtle">
                {isBusy ? (
                  <Spinner
                    data-testid="side-pane-plugin-progress"
                    className="size-3.5 motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                {actionLabel}
              </span>
            </DropdownMenuItem>
          );
        }
        return (
          <SidePaneLauncherRow
            key={itemId}
            itemId={itemId}
            icon={PuzzleIcon}
            avatar={
              <PluginStoreAvatar
                item={item}
                className="size-12"
                fallbackIcon={<PuzzleIcon className="size-6" />}
              />
            }
            label={title}
            description={
              surface ? resolveItemDisplayName(item, locale) : resolveItemDescription(item, locale)
            }
            actionLabel={actionLabel}
            loading={isBusy}
            disabled={isBusy}
            onOpen={open}
          />
        );
      })}
    </>
  );
}

/**
 * 「打开标签页」条目：内置应用与 UI 插件共用的横向行（对齐原型 SidePaneAppLauncher）。
 * 整行是一个按钮，尾部「打开」只做视觉胶囊，避免按钮嵌套按钮。
 */
export function SidePaneLauncherRow({
  itemId,
  icon: Icon,
  avatar,
  label,
  description,
  actionLabel,
  loading,
  disabled,
  onOpen,
}: {
  itemId: string;
  icon: LucideIcon;
  avatar?: ReactNode;
  label: string;
  description?: string;
  actionLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      data-side-pane-open-tab-item={itemId}
      className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={onOpen}
      disabled={disabled}
      aria-busy={loading || undefined}
    >
      {/* 应用插件复用市场图标来源；固定 PuzzleIcon 会忽略已发布的品牌图片。 */}
      {avatar ?? (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface">
          <Icon className="size-6 text-foreground-subtle" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-base font-semibold text-foreground">{label}</span>
        {description ? (
          <span
            className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
            title={description}
          >
            {description}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          buttonVariants({ variant: "secondary", size: "sm" }),
          "shrink-0 rounded-full",
        )}
      >
        {loading ? (
          <Spinner
            data-testid="side-pane-plugin-progress"
            className="size-3.5 motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
        {actionLabel ?? intl.formatMessage({ id: "settings.plugins.store.ui.open" })}
      </span>
    </button>
  );
}
