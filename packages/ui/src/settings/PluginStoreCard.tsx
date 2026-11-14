// INV-01 已安装条目只出现「…」菜单，未安装条目只出现「安装」胶囊，同一卡片内两者互斥；守住位置：PluginStoreCard 尾部分支；改错故障：同一插件出现两个入口，点过安装后按钮仍可点，后端收到两次安装
// INV-02 进行中状态只从 actions.activeOperations 推导，组件内不另存本地 pending；守住位置：PluginStoreInstallButton 与 PluginStoreUpdateButton；改错故障：刷新或详情页返回后本地态丢失，按钮提前恢复可点
// INV-03 install 的 id 为 plugin:install:name@marketplace，restore 的 id 为 plugin:restore:id，任一命中都算安装中；守住位置：installing 判定；改错故障：内置可恢复插件安装期间按钮不禁用，restore 与 install 并发提交
// INV-04 update 的 id 为 plugin:update:id，前缀与安装不同，判定时不得复用 installing 的表达式；守住位置：updating 判定；改错故障：更新在途时按钮仍可点，同一插件被并发更新两次
// INV-05 启停、更新、卸载、打开 UI 共用 isItemBusy，任一动作在途其余动作全部禁用；守住位置：PluginStoreItemMenu、PluginStoreUpdateButton、PluginStoreOpenUiButton 的 disabled；改错故障：更新未落盘时用户点卸载，两次写互相覆盖
// INV-06 启停开关只按 actions.togglingPluginId 禁用被切换的那一个插件；守住位置：PluginStoreEnabledSwitch 的 disabled；改错故障：一个插件切换超时会让整列开关在超时前全部点不动
// INV-07 启停项仅在 item.info 存在且调用方注入 onSetEnabled 时渲染，缺任一条件菜单只剩卸载；守住位置：canToggleEnabled；改错故障：对没有运行时信息的条目点启用，后端收到空 id 的 toggle 请求
// INV-08 卸载项不依赖 item.info，只要 item.installed 为真就必须保留；守住位置：PluginStoreItemMenu 的 installed 分支；改错故障：只剩安装记录的脏条目无法清理，用户只能手改配置文件
// INV-09 分隔线只在卸载前确有其它菜单项时渲染，条件即 canToggleEnabled；守住位置：hasActionsBeforeUninstall；改错故障：单条卸载菜单上方留下孤立横线，菜单分区错乱
// INV-10 更新入口可见性统一由 canUpdatePluginItem 决定，角标与行内胶囊不得各写一套比较；守住位置：PluginStoreUpdateBadge 与 PluginStoreUpdateButton；改错故障：角标说有更新而按钮不出现，或反过来重复拉取无需更新的版本
// INV-11 不可更新的条目整体不渲染，而不是渲染成禁用态；守住位置：两个更新组件的提前 return；改错故障：来源缺失的插件显示灰色更新按钮，用户反复点击无响应
// INV-12 requiresPaidPlan 只影响徽标展示，不参与安装门禁；守住位置：PluginStorePaidPlanBadge 的提前 return；改错故障：免费用户被挡在商店外，或该字段缺失时徽标残留空壳
// INV-13 徽标可见文案用短文案，完整条件同时写进 aria-label 与 tooltip，二者取自同一条 message；守住位置：label 与 badgeLabel 取值；改错故障：读屏用户只听到标签而不知道条件，或提示与标签文案不一致
// INV-14 菜单、安装、更新、开关的点击都必须 stopPropagation，只有卡片主体拥有进入详情的行为；守住位置：各按钮与菜单的 onClick；改错故障：点卸载的同时跳进详情页，卸载确认被导航打断
// INV-15 卡片键盘只响应事件目标等于当前元素的 Enter 与空格，内部控件按键不被二次处理；守住位置：onKeyDown 首行；改错故障：在安装按钮上按回车会同时打开详情页
// INV-16 全部可见文案走 useZCodeIntl，不出现硬编码语言分支；守住位置：每个组件的 intl.formatMessage；改错故障：切换语言后仍显示旧语言，缺 message 时整块列表渲染失败
// INV-17 描述只渲染 resolveItemDescription 的返回值，为空时整行不渲染；守住位置：description 条件渲染；改错故障：描述缺失时留出空白行，双列网格错位
// INV-18 描述行用 truncate 单行截断，卡片不承载多行文本；守住位置：description 的 className；改错故障：长描述撑成两行后卡片高度抖动，同一行卡片不齐
// INV-19 显示名与描述都带 locale 解析，不得直接读 item.name 兜底；守住位置：resolveItemDisplayName 与 resolveItemDescription 调用；改错故障：非英文用户看到英文原名，或卡片与详情页显示不同名字
import {
  Crown,
  Download,
  Loader2,
  MoreHorizontal,
  Power,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import {
  canUpdatePluginItem,
  isItemBusy,
  isUiPluginItem,
  resolveItemDescription,
  resolveItemDisplayName,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

/** 商店条目的通用动作集：列表卡片、详情页共用同一套回调与进行中态判定。 */
export interface PluginStoreActions {
  onOpenDetail: (pluginId: string) => void;
  onOpenUi?: (item: StorePluginItem) => void;
  /** 安装或恢复（restorable 内置插件走 restoreBuiltin，其余走 install）。 */
  onInstall: (item: StorePluginItem) => void;
  onUninstall: (pluginId: string) => void;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  /** 删除当前 Workspace scope 的显式配置，使其回退到 User。 */
  onResetConfig?: (pluginId: string) => void;
  onUpdate: (pluginId: string) => void;
  // [并发] 这里只声明「正在进行什么」，不声明「结果如何」：条目状态一律回读列表，组件不缓存成功或失败
  // 若在这里补一个本地 pending 集合，刷新或详情页返回后本地态与真实态不一致，按钮会在后端仍在执行时恢复可点
  // 操作 id 是对外契约：install 带 name@marketplace，restore 与 update 带插件 id，三种前缀互不兼容
  // 任何新增操作都必须引入新前缀，不能复用旧前缀塞新语义，否则按钮会把两类操作算作同一件进行中的事
  // [失败路径] 操作失败后对应 id 会从 activeOperations 移除，卡片据此自动恢复可点
  // 因此失败态不需要额外错误标记，靠「同一张仍可点的卡片」承担重试入口，用户不必先关闭错误提示
  // [权衡] 用只读数组而非 Map 传递进行中集合：调用方无需维护增删，代价是每次判定线性扫描，条目数量在十级可接受
  activeOperations: ReadonlyArray<{ id: string }>;
  togglingPluginId: string | null;
}

/**
 * 付费套餐提示：目录条目声明 `listing.requiresPaidPlan` 时，在标题右侧展示渐变徽标。
 * 表达的是「需要付费套餐才好用」这个使用条件，不是「插件是收费商品」——不做安装门禁。
 * 商店卡片与详情页标题共用同一渐变徽标。
 * 徽标使用短文案，完整条件由 Tooltip 和 aria-label 表达；缺字段时整个标记不渲染。
 * hover 提示走 ControlHintTooltip（Root Provider 的 delayDuration=0，即时弹出），
 * 不用原生 title——后者有约 1s 系统延迟。
 */
export function PluginStorePaidPlanBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "listing">;
}) {
  const { intl } = useZCodeIntl();
  // [权衡] 该字段只做展示而非安装门禁：目录里部分插件在免费套餐下也能安装，只是能力受限
  // 若在这里之外再加拦截，免费用户在商店里会完全看不到入口，与「可安装但受限」的产品定义冲突
  // 字段缺失即视为不需要付费套餐，宁可少显示一个徽标，也不显示空徽标
  // 空壳节点会占掉标题行剩余宽度，长名称被迫提前截断，用户分不清是名字本身就长还是被徽标挤占
  // 商店卡片与详情页标题共用本组件，判定与文案只在这里维护一次，避免两处对同一字段给出不同结论
  // [失败路径] 提前返回位于 useZCodeIntl 之后、所有渲染之前，hooks 顺序不随字段存在与否变化
  // [资源] 提示气泡由 ControlHintTooltip 委托给 Root Provider，本组件不自行创建 Provider，卸载时无需清理
  if (!item.listing?.requiresPaidPlan) return null;
  const label = intl.formatMessage({ id: "settings.plugins.store.requiresPaidPlan" });
  const badgeLabel = intl.formatMessage({ id: "settings.plugins.store.paidPlanBadge" });
  return (
    <ControlHintTooltip title={label}>
      <span
        data-testid="plugin-store-paid-plan-badge"
        data-plugin-id={item.id}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-plugin-paid-plan-badge)] px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-[var(--color-plugin-paid-plan-badge-foreground)]"
        aria-label={label}
      >
        <Crown className="size-3" aria-hidden="true" />
        {badgeLabel}
      </span>
    </ControlHintTooltip>
  );
}

/** 详情页与管理视图的插件级启停开关；紧凑商店卡片只保留「…」菜单。 */
export function PluginStoreEnabledSwitch({
  item,
  actions,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
}) {
  const { intl } = useZCodeIntl();
  if (!item.info || !actions.onSetEnabled) return null;
  const enabled = item.info.enabled;
  return (
    <Switch
      data-testid="plugin-store-enabled-switch"
      data-plugin-id={item.id}
      checked={enabled}
      // [并发] 只锁被点的那一行：切换在途期间同插件的菜单与更新仍可点，但开关本身不可重复提交
      // 若改成全局必锁，一个慢请求会让整列开关全部灰掉，用户无法操作其它插件
      // 禁用条件必须与 onChange 的入参同源：新值由当前 checked 取反得到，而不是读事件里的布尔
      // 在途期间连点会以旧值为基准反复取反，产生「禁用→启用→禁用」的抖动请求
      // [失败路径] 请求失败后 togglingPluginId 被清空，开关回到真实 enabled，用户看到「拨过去又弹回」
      // 这是唯一的失败反馈，因此这里不得乐观改 checked，否则失败时用户以为已经生效
      // [权衡] 切换期间不禁用整张卡片：卡片仍可点进详情，用户在等待时能查看版本与权限说明
      disabled={actions.togglingPluginId === item.id}
      aria-label={
        enabled
          ? intl.formatMessage({ id: "settings.plugins.store.menu.disable" })
          : intl.formatMessage({ id: "settings.plugins.store.menu.enable" })
      }
      onClick={(event) => event.stopPropagation()}
      onCheckedChange={(checked) => actions.onSetEnabled?.(item.id, checked)}
    />
  );
}

/** 已安装条目的「…」菜单：启用/禁用、更新（有更新时）、卸载。卡片与详情页共用。 */
export function PluginStoreItemMenu({
  item,
  actions,
  triggerClassName,
  triggerVariant = "ghost",
  triggerSize = "icon-md",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  triggerClassName?: string;
  triggerVariant?: "ghost" | "outline";
  triggerSize?: "icon-md" | "icon-lg";
}) {
  const { intl } = useZCodeIntl();
  const enabled = item.info?.enabled ?? false;
  // [并发] 菜单每一项的 disabled 都取自这一个 busy，不在各分支重算
  // 多种操作共用同一份进行中集合，任何一处漏判都会让两个互斥的写请求同时发出
  // isItemBusy 同时看 install、restore、update、toggle 四类 id
  // 因此这里不能退化成只判断自己那一类前缀，否则更新在途时仍能点卸载
  // 触发器图标也由它决定：忙时换成转圈，用户在菜单展开前就能看到该条目正在处理
  // [权衡] 忙时只置灰、不关闭菜单也不隐藏项：关闭会丢焦点，隐藏会让菜单高度在操作中跳变
  // [失败路径] busy 来源只有 actions，本组件不维护备用定时器，因此不会出现永远转圈的本地残留
  const busy = isItemBusy(item, actions);
  const canToggleEnabled = Boolean(item.info && actions.onSetEnabled);
  // 分隔线不应跟随 item.installed 无条件渲染；启停/更新/恢复配置都不出现时，
  // 菜单只剩「卸载」一项，上方却留下一条孤立横线。分隔线只在卸载前确有其他操作项时才有意义。
  const hasActionsBeforeUninstall = canToggleEnabled;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/**
         * 原实现重复声明 data-testid，导致 TSX 编译报错 TS17001，
         * 仅保留一个测试 id 即可。
         */}
        <Button
          type="button"
          data-testid="plugin-store-item-menu"
          data-plugin-id={item.id}
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          aria-label={intl.formatMessage({ id: "settings.plugins.store.menu.label" })}
          onClick={(event) => event.stopPropagation()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <MoreHorizontal className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {canToggleEnabled ? (
          <DropdownMenuItem
            data-testid="plugin-store-menu-enabled"
            data-plugin-id={item.id}
            disabled={busy}
            onSelect={() => actions.onSetEnabled?.(item.id, !enabled)}
          >
            <Power className="size-4" aria-hidden="true" />
            {enabled
              ? intl.formatMessage({ id: "settings.plugins.store.menu.disable" })
              : intl.formatMessage({ id: "settings.plugins.store.menu.enable" })}
          </DropdownMenuItem>
        ) : null}
        {item.installed ? (
          <>
            {hasActionsBeforeUninstall ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid="plugin-store-menu-uninstall"
              data-plugin-id={item.id}
              variant="destructive"
              disabled={busy}
              // [失败路径] 卸载失败不回滚卡片结构：安装记录仍在，直到后端确认清除
              // 保留同一张卡片比先移除再插回可靠，后者会让用户在失败瞬间误以为已卸载，随后又看到卡片重现
              // 菜单项以 disabled 绑定 busy 防重入，卸载在途时重复触发会被直接拦截，回调内不必再做幂等判断
              // 菜单只对 installed 为真渲染，因此这条路径不会出现卸载一个不存在的插件
              // [资源] 卸载还需清理该插件的本地 suppression 与 workspace 显式配置
              // 这两步由 actions.onUninstall 内部串行完成，UI 不参与顺序编排，否则配置先于记录被清会留下孤儿条目
              // [权衡] 不在菜单里合并「卸载」与「重置配置」：重置配置是独立回调 onResetConfig，误合并会让用户丢配置
              onSelect={() => actions.onUninstall(item.id)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.detail.uninstall" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 安装/恢复胶囊按钮（未安装条目的卡片与详情页主按钮共用）。 */
export function PluginStoreInstallButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  // [并发] 安装中判定必须同时覆盖两种操作 id：marketplace 安装带 name@marketplace
  // restore 带插件 id，同一插件在不同市场是两个条目，两种 id 不能互换
  // 只写其中一条会让另一半场景的按钮在请求在途时仍可点，重复安装出两个副本
  // 两次 some 串联而不是拼一个正则：两类 id 由不同构造点生成，前缀语义不同，合并匹配易误判
  // [失败路径] runUserAction 只埋点不吞异常，安装失败由上层列表回读反映，按钮随 id 移除自动恢复可点
  // [权衡] 安装使用 secondary 胶囊而非主色按钮：卡片里有多个等价动作，突出单一动作会误导用户以为只有安装可用
  // [资源] 进行中图标与文案共用同一 installing 布尔，避免出现「转圈但仍写着安装」的中间态
  const installing =
    actions.activeOperations.some(
      (operation) => operation.id === `plugin:install:${item.name}@${item.marketplace}`,
    ) || actions.activeOperations.some((operation) => operation.id === `plugin:restore:${item.id}`);
  return (
    <Button
      type="button"
      data-testid="plugin-store-install"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      disabled={installing}
      onClick={(event) => {
        event.stopPropagation();
        runUserAction({
          input: { featureId: "extension.plugin", action: "install", trigger: "button" },
          operation: () => actions.onInstall(item),
          completed: { resultSource: "optimistic_projection" },
          failureStage: "plugin_install",
        });
      }}
    >
      {installing ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
      {installing
        ? intl.formatMessage({ id: "settings.plugins.marketplace.installing" })
        : intl.formatMessage({ id: "settings.plugins.store.install" })}
    </Button>
  );
}

/** 已安装条目的「可更新」角标：列表/卡片标题行直接标出哪个插件有更新，与详情页入口共用判定。 */
export function PluginStoreUpdateBadge({
  item,
}: {
  item: Pick<StorePluginItem, "id" | "installedMeta" | "orphaned"> | null | undefined;
}) {
  const { intl } = useZCodeIntl();
  // 版本比较只在 canUpdatePluginItem 一处实现：它同时排除 orphaned 与缺少 installedMeta 两类条目
  // orphaned 意味着来源缺失、无法确定远端最新版；缺少 installedMeta 意味着没有本地版本可比
  // 若把比较写进组件，卡片角标与行内按钮很容易对「已是最新」给出不同结论
  // 用户会看到角标提示有更新、点进去却没有更新按钮，只能反复刷新
  // [失败路径] 该函数对 null 与 undefined 入参返回 false，调用方可以先渲染再判断
  // 因此提前返回不改变 hooks 数量，也不必在 JSX 外层再包一层条件
  // [权衡] 不渲染禁用态按钮：禁用态暗示「稍后可以更新」，而这两类条目永远不能更新
  if (!canUpdatePluginItem(item)) return null;
  const label = intl.formatMessage({ id: "settings.plugins.list.updateAvailable" });
  return (
    <span
      data-testid="plugin-store-update-badge"
      data-plugin-id={item?.id}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/14 px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-success dark:bg-success/18"
      aria-label={label}
    >
      <Download className="size-3" aria-hidden="true" />
      {label}
    </span>
  );
}

/** 行内「更新」胶囊：已安装且可更新的条目原地触发更新，不必进详情页。 */
export function PluginStoreUpdateButton({
  item,
  actions,
  size = "sm",
}: {
  item: StorePluginItem | null | undefined;
  actions: PluginStoreActions;
  size?: "sm" | "default" | "lg";
}) {
  const { intl } = useZCodeIntl();
  if (!item || !canUpdatePluginItem(item)) return null;
  // [并发] 更新用独立前缀 plugin:update:id，与安装的 name@marketplace 不同源
  // 同一插件可能已装旧版且远端有新版本，安装与更新是两个动作，混用 id 会让两个按钮互相顶掉状态
  // 这里只判更新自己的 id，不并入 isItemBusy：按钮的 disabled 已由 busy 覆盖
  // 若在 updating 里并入安装态，转圈图标就无法区分「正在安装」与「正在更新」
  // [权衡] 更新进行中保留按钮位置并换成转圈，而不是隐藏：隐藏会让卡片尾部宽度突变，相邻卡片按钮组错位
  // [失败路径] 更新失败后 id 移除，按钮回到下载图标，用户可直接重试同一次更新
  // 因此更新不需要单独的错误态文案，失败与未开始对用户是同一个可点状态
  const updating = actions.activeOperations.some(
    (operation) => operation.id === `plugin:update:${item.id}`,
  );
  return (
    <Button
      type="button"
      data-testid="plugin-store-card-update"
      data-plugin-id={item.id}
      variant="secondary"
      size={size}
      className="rounded-full"
      // 与安装按钮一致按插件判定：A 安装中时 B 仍可提交更新，后端按提交顺序串行执行。
      disabled={isItemBusy(item, actions)}
      onClick={(event) => {
        event.stopPropagation();
        actions.onUpdate(item.id);
      }}
    >
      {updating ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-3.5" aria-hidden="true" />
      )}
      {intl.formatMessage({ id: "settings.plugins.detail.update" })}
    </Button>
  );
}

/**
 * 商店卡片（双列网格单元）：40px 头像 + 显示名 + 单行截断描述；
 * 尾部动作：已安装 → 「…」菜单，未安装 → 「安装」胶囊。点击主体进入详情页。
 */
export function PluginStoreCard({
  item,
  actions,
  locale,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  locale: string;
}) {
  const { intl } = useZCodeIntl();
  const displayName = resolveItemDisplayName(item, locale);
  const description = resolveItemDescription(item, locale);
  // 卡片整行统一进入详情；打开 UI 只走会话右侧市场提供的「打开」按钮。
  // 卡片整块可点但只进入详情：打开插件 UI 需要额外前置条件，放在整卡手势上会让误触直接切走当前会话
  // 回调只捕获 item.id 而不是整个 item：详情页以 id 重新拉取最新状态
  // 带着卡片快照进入详情会看到过期版本号或过期启用态，与列表刚刷新的结果矛盾
  // 键盘 Enter 与空格共用同一个 open，保证两条路径进入同一处
  // [权衡] 用 div 加 role=button 而非原生 button：卡片内部还要放按钮与菜单触发器，原生 button 不能嵌套 button
  const open = () => actions.onOpenDetail(item.id);
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="plugin-store-card"
      data-plugin-id={item.id}
      className="group/card flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <PluginStoreAvatar item={item} className="size-10" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
            {displayName}
          </span>
          <PluginStorePaidPlanBadge item={item} />
          <PluginStoreUpdateBadge item={item} />
        </div>
        {item.orphaned ? (
          <div
            data-testid="plugin-store-source-degraded"
            data-plugin-id={item.id}
            className="mt-0.5 flex items-center gap-1 truncate text-ui-sm text-warning"
          >
            <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {intl.formatMessage({ id: "settings.plugins.store.sourceMissing" })}
            </span>
          </div>
        ) : null}
        {description ? (
          <div className="mt-0.5 truncate text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {item.installed ? (
          <>
            <PluginStoreOpenUiButton item={item} actions={actions} />
            <PluginStoreUpdateButton item={item} actions={actions} />
            {/* Bugfix：旧版误写 suppression 后可能只剩安装记录、没有运行时 info；
                此时仍须保留卸载菜单，让用户能清理安装记录与脏 suppression。 */}
            <PluginStoreItemMenu item={item} actions={actions} />
          </>
        ) : (
          <PluginStoreInstallButton item={item} actions={actions} />
        )}
      </div>
    </div>
  );
}

export function PluginStoreOpenUiButton({
  item,
  actions,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
}) {
  const { intl } = useZCodeIntl();
  if (!item.installed || !isUiPluginItem(item) || !actions.onOpenUi) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      data-testid="plugin-store-open-ui"
      data-plugin-id={item.id}
      disabled={isItemBusy(item, actions)}
      onClick={(event) => {
        event.stopPropagation();
        actions.onOpenUi?.(item);
      }}
    >
      {intl.formatMessage({
        id:
          (item.info?.enabled ?? item.installedMeta?.enabled)
            ? "settings.plugins.store.ui.open"
            : "settings.plugins.store.menu.enable",
      })}
    </Button>
  );
}
