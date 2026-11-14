/* eslint-disable max-lines -- 设置页 provider 导航同时承载分组、卡片化预置入口和拖拽排序，当前先集中维护交互边界。 */
// ============================================================
// 文件职责：设置页「模型服务商」左栏导航（model-provider-section/Navigation.tsx）。
// 职责边界 · 做：
//   1) 按 navigationGroups 渲染两组：preset 组为卡片式按钮，custom 组为可拖拽按钮；
//   2) 按 selectedNodeKey 只读派生 aria-selected 与 data-state，选中态不在本文件落库；
//   3) 按 reorderableProviderIds 决定哪些条目可拖，把新顺序交给 onReorderProviderIds；
//   4) 提供四个纯函数：可拖 ID 提取、组内换序、组 loading 判定、乐观顺序投影。
// 职责边界 · 不做：
//   1) 不写路由、不写选中态、不改 store，选中语义的唯一所有者在 useModelProviderNavigation；
//   2) 不拉取 provider 列表、不持久化顺序、不做权限与可见性过滤，只消费父层入参；
//   3) 不直接调平台服务与 Repo，loading 只按 presetLoading 与 customLoading 展示。
//
// INV 表（每条格式：断言 · 守住它的位置 · 改错故障）：
// INV-01 断言：选中判据只有 item.key 与 selectedNodeKey 全等 —— 守住它的位置：按钮的 isSelected 派生 —— 改错故障：改用 providerId 比较，preset 与套餐 key 错位后侧栏无高亮。
// INV-02 断言：节点 key 由 create*NodeKey 统一生成，本文件不拼接 —— 守住它的位置：testId 与 data-state 的入参 —— 改错故障：高亮与右侧详情指向两个不同节点。
// INV-03 断言：路由与选中态同源，点击只上报 item、高亮只读 selectedNodeKey —— 守住它的位置：两个按钮组件的点击分支 —— 改错故障：本地乐观高亮被父层纠偏后闪烁错位。
// INV-04 断言：未知分组按 custom 语义兜底 loading —— 守住它的位置：组 loading 纯函数的非 preset 分支 —— 改错故障：新增分组永久转圈或永不显示加载。
// INV-05 断言：custom 组为空时整组不渲染 —— 守住它的位置：navigationGroups 的过滤条件 —— 改错故障：侧栏留下只有标题的空白段落。
// INV-06 断言：codingPlanLoading 占位禁用且点击早退 —— 守住它的位置：只读按钮的 disabled 与 onClick —— 改错故障：点占位项后详情页永久空白。
// INV-07 断言：拖拽只改纵向、x 恒为零 —— 守住它的位置：组级 DndContext 的修饰器 —— 改错故障：条目被侧栏横向裁切，图标与文字缺一半。
// INV-08 断言：over 为空或与 active 相同时不改顺序 —— 守住它的位置：onDragEnd 首个早退 —— 改错故障：松手在组外仍提交一次无意义排序，产生多余写入。
// INV-09 断言：组内换序下标非法时返回副本且顺序不变 —— 守住它的位置：换序纯函数的早退分支 —— 改错故障：跨组拖拽把列表清空。
// INV-10 断言：reorderableProviderIds 缺省表示不设限，存在时按 providerId 精确匹配 —— 守住它的位置：可拖 ID 提取 —— 改错故障：老调用方条目全部不可拖，或权限外条目被拖动。
// INV-11 断言：乐观顺序只重排可拖条目，其余条目相对位置不变 —— 守住它的位置：投影函数的游标 —— 改错故障：套餐卡片被挤到组尾，点击命中错项。
// INV-12 断言：投影结果与入参等长，缺 id 时保留原位 —— 守住它的位置：投影函数的回退分支 —— 改错故障：渲染列表少项，选中项从侧栏消失触发回退。
// INV-13 断言：每组独立上下文与独立乐观控制器，不支持跨组拖拽 —— 守住它的位置：可排序组的结构 —— 改错故障：一次拖拽写坏两个组的持久化顺序。
// INV-14 断言：sensors 在组件顶层创建一次并复用 —— 守住它的位置：对外组件的钩子顺序 —— 改错故障：条件渲染导致钩子数量变化，组件抛错。
//
// 阅读顺序：纯函数在上、按钮组件居中、可排序组与对外组件在下；改一处先看对应 INV。
// ============================================================
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Loader2Icon } from "lucide-react";
import { ProviderStatusIndicator } from "./ProviderStatusIndicator.js";

import {
  resolveModelProviderFamilySpecByProviderId,
  isStartPlanModelProviderId,
} from "@zcode/shared";
import { TID_MODEL_PROVIDER_NAV_ITEM, testId } from "@zcode/shared/test-ids";
import { useCallback, useMemo, type KeyboardEvent } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { ModelProviderNavGroup, ModelProviderNavItem } from "./constants.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";
import { renderModelProviderNavIcon } from "./utils.js";

// 侧栏会裁切水平溢出；排序只改变纵向位置，拖动时也必须保持 x=0。
// [契约] 侧栏父级会裁切横向溢出，条目一旦横向位移就会被切掉半个图标和文字。
// [权衡] 只把 x 归零、保留 y：纵向跟手决定排序手感，锁死纵向会让条目拖到组边缘卡住。
// 修饰器返回新对象，不原地改写 dnd-kit 传入的 transform，避免污染其它修饰器的输入。
// 它只挂在本组 DndContext 上，组与组之间的拖拽本来就不被支持，也不需要跨组坐标换算。
// 若将来出现横向排列的导航，应新建修饰器，而不是在这里放开 x 归零。
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

// [契约] 只有带 provider 的 preset 与 custom 两类条目可拖，其余类型一律返回空值。
// 编码套餐与团队套餐的顺序由连接方式推导，混进侧栏排序会让选中顺序与事实脱节。
// reorderableProviderIds 缺省表示「不设限」而非「全部禁止」，老调用方不必传集合。
// 集合存在时按 providerId 精确匹配：命中才可拖，未命中的条目仍渲染但只能点击切换。
// 返回空值是权限与可见性在渲染层的唯一出口，调用方据此选择只读按钮或拖拽按钮。
export function getSortableProviderId(
  item: ModelProviderNavItem,
  reorderableProviderIds?: ReadonlySet<string>,
): string | null {
  if ((item.type === "custom" || item.type === "preset") && item.provider) {
    return !reorderableProviderIds || reorderableProviderIds.has(item.provider.providerId)
      ? item.provider.providerId
      : null;
  }
  return null;
}

// [契约] 入参 providerIds 是当前渲染顺序（含乐观 pending），不是后端权威顺序。
// 下标取不到或两端相等时返回副本而不返回原数组：上游拿它直接当新状态，引用必须换。
// 返回空数组会让列表瞬间清空，因此非法拖拽一律退化为顺序不变。
// [失败路径] active 与 over 来自拖拽事件，组件卸载后可能失效，故先落成下标再判断。
// 下标缺失说明落点不在本组，跨组拖拽不被支持，保持原序是唯一安全结果。
export function resolveReorderedProviderIdsForGroup(params: {
  activeProviderId: string;
  overProviderId: string;
  providerIds: readonly string[];
}): string[] {
  const activeIndex = params.providerIds.indexOf(params.activeProviderId);
  const overIndex = params.providerIds.indexOf(params.overProviderId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.providerIds];
  }
  return arrayMove([...params.providerIds], activeIndex, overIndex);
}

// [契约] 组 loading 只映射两个真实来源：preset 组看 presetLoading，其余组一律看 customLoading。
// 这是未知分区兜底：groupId 之外新增组时默认落到 custom 语义，不会永久显示加载中。
// 反过来写（只有命中的组才展示）会让新组静默丢失 loading，用户以为列表已加载完。
// [权衡] 不做成按组 id 查表：当前只有两个组，查表反而要维护第三份需要同步的键集合。
// 判定是纯函数，便于单测；组件里不要在 JSX 内重复写这套三元分支。
export function shouldShowModelProviderGroupLoadingIndicator(params: {
  groupId: ModelProviderNavGroup["id"];
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  if (params.groupId === "preset") {
    return params.presetLoading;
  }
  return params.customLoading;
}

// [契约] 侧栏文案优先取 family spec 的 label，其次才回落到导航项的 label。
// spec 存在说明该 preset 属于某个品牌 family，展示名应以品牌定义为准，避免两处文案漂移。
// Start Plan 是唯一被改写的套餐名：它在产品上是体验套餐，不能显示成普通编码套餐。
// [契约] 这两个来源都只读 item 上的 presetId，不读 provider 配置，故未登录时也能正确展示。
// 返回的都是展示字符串，不含 i18n key：key 到文案的映射已在导航派生层完成。
export function resolveModelProviderSideNavLabel(item: ModelProviderNavItem): string {
  if (item.type === "preset") {
    return resolveModelProviderFamilySpecByProviderId(item.presetId)?.label ?? item.label;
  }
  if (item.type === "codingPlan" && isStartPlanModelProviderId(item.presetId)) {
    return "Start Plan";
  }
  return item.label;
}

// [契约] 只读按钮的 props：item、label、selectedNodeKey、onSelectNavItem 与 showIcon。
// 组件不持有自身选中状态，点下去只上报 onSelectNavItem，高亮完全由 selectedNodeKey 决定。
// 这保证路由与选中态同源：导航切换与右侧详情渲染读的是同一把 key。
// item.type 为 codingPlanLoading 时禁用按钮：占位项没有详情，点它只会让右侧空白。
// showIcon 为假时隐藏图标但仍渲染 label，preset 卡片组与可排序组因此共用一套按钮。
function ModelProviderNavigationButton({
  item,
  label,
  selectedNodeKey,
  onSelectNavItem,
  showIcon = true,
}: {
  item: ModelProviderNavItem;
  label: string;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  showIcon?: boolean;
}) {
  // [契约] 选中判据只有一项：item.key 与 selectedNodeKey 全等，不比较 providerId 或类型。
  // 侧栏与右侧详情共享同一套节点 key，只要 key 同源，高亮与内容就不会指向两个节点。
  // [权衡] 不在点击时先本地置高亮：乐观高亮会让点击后被父层纠偏时闪一下错位。
  // 加载中条目即便 key 命中也不代表可用，禁用态由 isLoadingItem 单独控制。
  // isSelected 还喂给 aria-selected 与 data-state，样式与无障碍语义因此不会分叉。
  const isSelected = item.key === selectedNodeKey;
  const isLoadingItem = item.type === "codingPlanLoading";
  const inactiveItemClassName = "border-transparent text-foreground hover:border-border-hover/60";

  return (
    <ControlHintTooltip title={label} side="right">
      <button
        type="button"
        disabled={isLoadingItem}
        aria-label={label}
        aria-selected={isSelected}
        data-state={isSelected ? "selected" : "idle"}
        data-testid={testId(TID_MODEL_PROVIDER_NAV_ITEM, item.key)}
        onClick={() => {
          if (isLoadingItem) {
            return;
          }
          onSelectNavItem(item);
        }}
        className={`relative box-border flex h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0 ${
          isSelected
            ? "border-border-hover bg-card-selected text-foreground"
            : inactiveItemClassName
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        {isLoadingItem ? (
          <Loader2Icon className="size-4 shrink-0 animate-spin text-foreground-subtlest" />
        ) : showIcon ? (
          <span className="shrink-0 text-current">{renderModelProviderNavIcon(item)}</span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {"provider" in item ? (
          <ProviderStatusIndicator
            provider={item.type === "preset" ? item.statusProvider : item.provider}
          />
        ) : null}
      </button>
    </ControlHintTooltip>
  );
}

// [契约] 行级键盘入口只认 Enter 与空格，其余按键交还给拖拽库的键盘传感器。
// 空格在可排序行里同时是拖拽抓取键，因此必须先让拖拽库处理，再落到这里的选中逻辑。
// 阻止默认是必要的：不拦会让页面随空格滚动，用户以为点击没生效。
// [契约] 键盘与指针走同一个 onSelectNavItem，不为键盘单独维护第二条选中路径。
// event 类型限定为行容器的键盘事件，输入框内的按键不会冒泡到这里被误当成选中。
function handleModelProviderNavigationRowKeyDown({
  event,
  item,
  onSelectNavItem,
}: {
  event: KeyboardEvent<HTMLDivElement>;
  item: ModelProviderNavItem;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  event.preventDefault();
  onSelectNavItem(item);
}

// [契约] 可拖拽按钮把 useSortable 的 attributes 与 listeners 摊到行容器上，整行即拖拽把手。
// id 传 providerId 而不是 item.key：排序结果按 providerId 持久化，两种 id 不能混用。
// 容器是 div 而非 button：button 内再嵌 button 会破坏无障碍树，键盘语义由行级处理器补齐。
// 拖拽中给 z-20 与半透明，让拖动行浮在相邻行之上，松手后样式随 isDragging 自动复位。
// [契约] 选中态与只读按钮同口径，仍只比 item.key 与 selectedNodeKey，不因可拖而改变判据。
function SortableModelProviderNavigationButton({
  providerId,
  item,
  label,
  selectedNodeKey,
  onSelectNavItem,
}: {
  providerId: string;
  item: ModelProviderNavItem;
  label: string;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: providerId,
  });
  // [契约] transform 由 CSS.Transform 序列化，直接写对象会让 dnd-kit 的位移不生效。
  // transition 原样透传，拖拽结束的回落动画与库内部时序保持一致，不自己加缓动。
  // 样式对象每次渲染新建：拖拽期间 transform 每帧变化，缓存它反而会停在旧位置。
  // [资源] 这层只做视觉位移，不触碰布局尺寸，长列表拖动不会引发布局抖动。
  // 归零 x 的修饰器在组级 DndContext 上生效，这里不要重复裁剪 x。
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const isSelected = item.key === selectedNodeKey;
  const inactiveItemClassName = "border-transparent text-foreground hover:border-border-hover/60";
  // [契约] 先调拖拽库的键盘处理器，再由本组件补齐 Enter 与空格的选中语义。
  // defaultPrevented 为真说明拖拽库已经消费该按键（例如开始抓取），此处必须让路。
  // [并发] 两个处理器串行执行而非互斥，靠这个早退保证同一次按键只产生一个结果。
  // 顺序不能反：先选中会让空格既触发跳转又开始拖拽，用户看到页面闪动。
  // 处理函数在渲染中重建，不缓存，避免闭包拿到旧的 item 与 onSelectNavItem。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    listeners?.onKeyDown?.(event);
    if (event.defaultPrevented) return;
    handleModelProviderNavigationRowKeyDown({ event, item, onSelectNavItem });
  };

  return (
    <ControlHintTooltip title={label} side="right">
      <div
        ref={setNodeRef}
        style={style}
        aria-label={label}
        aria-selected={isSelected}
        data-state={isSelected ? "selected" : "idle"}
        data-testid={testId(TID_MODEL_PROVIDER_NAV_ITEM, item.key)}
        onClick={() => onSelectNavItem(item)}
        {...attributes}
        {...listeners}
        onKeyDown={handleKeyDown}
        className={`relative box-border flex h-8 w-full cursor-grab touch-pan-y select-none items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0 ${
          isSelected
            ? "border-border-hover bg-card-selected text-foreground"
            : inactiveItemClassName
        } ${isDragging ? "z-20 opacity-70" : ""}`}
      >
        <span className="shrink-0 text-current" aria-hidden="true">
          {renderModelProviderNavIcon(item)}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {"provider" in item ? (
          <ProviderStatusIndicator
            provider={item.type === "preset" ? item.statusProvider : item.provider}
          />
        ) : null}
      </div>
    </ControlHintTooltip>
  );
}

// [契约] preset 组不可排序，固定按 group.items 顺序渲染，卡片顺序即产品定义顺序。
// 卡片组复用只读按钮，不接 reorderableProviderIds：排序权限在这一层就被收窄。
// label 走 resolveModelProviderSideNavLabel，卡片组是唯一会改写 Start Plan 名称的入口。
// [契约] 空组仍会渲染空容器，不在这里隐藏：分组标题与 loading 由上层统一处理。
// `SettingsNavigation` 在 `lg` 以下改为纵向居中并只留图标，卡片间距同步收窄。
function PresetProviderCardNavigation({
  group,
  selectedNodeKey,
  onSelectNavItem,
}: {
  group: ModelProviderNavGroup;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  return (
    <div className="flex flex-col gap-2 max-md:items-center max-md:gap-1">
      {group.items.map((item) => (
        <ModelProviderNavigationButton
          key={item.key}
          item={item}
          label={resolveModelProviderSideNavLabel(item)}
          selectedNodeKey={selectedNodeKey}
          onSelectNavItem={onSelectNavItem}
        />
      ))}
    </div>
  );
}

// [契约] 每组各自持有 DndContext 与乐观排序控制器，跨组拖拽在结构上不可达。
// 这避免一次拖拽改动两个组的持久化顺序，组间顺序仍由 navigationGroups 决定。
// authoritativeProviderIds 只取可拖条目，与渲染顺序解耦，才能把 pending 顺序叠上去。
// sensors 由父层统一创建后传入，同一份传感器配置在两组间共享，避免重复注册监听。
// [事务] 组内换序只有一个提交点：仅 onDragEnd 会触发持久化回调。
function SortableProviderNavigationGroup({
  group,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  sensors,
}: {
  group: ModelProviderNavGroup;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  sensors: ReturnType<typeof useSensors>;
}) {
  // [契约] 权威顺序从 group.items 逐项提取，只保留 getSortableProviderId 命中的条目。
  // 依赖显式列出 group.items 与 reorderableProviderIds，二者任一变化都要重算顺序基线。
  // 用 flatMap 加条件收集，比先过滤再映射少一次中间数组，也少一处需要同步的判断。
  // [契约] 这里不做去重：同一 providerId 出现两次属于上游构造错误，静默去重会掩盖它。
  // 返回的是新数组，乐观排序控制器不会写回 group.items。
  const authoritativeProviderIds = useMemo(
    () =>
      group.items.flatMap((item) => {
        const providerId = getSortableProviderId(item, reorderableProviderIds);
        return providerId ? [providerId] : [];
      }),
    [group.items, reorderableProviderIds],
  );
  const persist = useCallback(
    async (providerIds: readonly string[]) => {
      await onReorderProviderIds?.([...providerIds]);
    },
    [onReorderProviderIds],
  );
  // [契约] 乐观排序控制器吸收权威顺序与持久化回调，对外只暴露渲染顺序与提交入口。
  // persist 用 useCallback 包一层，把 onReorderProviderIds 的可选性收敛成稳定的异步函数。
  // [并发] 连续拖拽由控制器内部串行写入，后一次提交不会被上一次的迟到结果覆盖。
  // 失败时控制器回滚到权威顺序，界面看到的顺序与最终落盘顺序保持一致。
  // 这里不直接调 onReorderProviderIds，保证所有排序写入都经过同一个串行队列。
  const optimisticOrder = useOptimisticReorder({
    authoritativeIds: authoritativeProviderIds,
    persist,
  });
  // [契约] 渲染顺序是乐观顺序在 group.items 上的重排投影，不是替换后的新列表。
  // 投影只移动可拖条目，codingPlan、teamPlan 与 loading 占位保持原有相对位置。
  // 依赖 optimisticOrder.renderedIds 而非整个控制器对象，避免无关字段变化触发重算。
  // [失败路径] providerIds 用尽时投影回退原条目，宁可少排一个也不产生重复或丢项。
  // 结果只用于渲染，不回写 group.items，也不参与选中判断。
  const renderedItems = useMemo(
    () =>
      projectItemsToOptimisticProviderOrder({
        items: group.items,
        providerIds: optimisticOrder.renderedIds,
        reorderableProviderIds,
      }),
    [group.items, optimisticOrder.renderedIds, reorderableProviderIds],
  );

  return (
    <DndContext
      sensors={sensors}
      modifiers={[restrictToVerticalAxis]}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        const activeProviderId = String(event.active.id);
        const overProviderId = event.over ? String(event.over.id) : "";
        if (!overProviderId || activeProviderId === overProviderId) return;
        const nextProviderIds = resolveReorderedProviderIdsForGroup({
          activeProviderId,
          overProviderId,
          providerIds: optimisticOrder.renderedIds,
        });
        void optimisticOrder.commit(nextProviderIds).catch(() => undefined);
      }}
    >
      <SortableContext
        items={[...optimisticOrder.renderedIds]}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-1 max-md:items-center">
          {renderedItems.map((item) => {
            const providerId = getSortableProviderId(item, reorderableProviderIds);
            if (!providerId) {
              return (
                <ModelProviderNavigationButton
                  key={item.key}
                  item={item}
                  label={item.label}
                  selectedNodeKey={selectedNodeKey}
                  onSelectNavItem={onSelectNavItem}
                />
              );
            }
            return (
              <SortableModelProviderNavigationButton
                key={item.key}
                providerId={providerId}
                item={item}
                label={item.label}
                selectedNodeKey={selectedNodeKey}
                onSelectNavItem={onSelectNavItem}
              />
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// [契约] 先按可拖条目建 providerId 到 item 的索引，再按目标顺序逐个替换位置。
// 索引只收录可拖条目，因此不参与排序的项不会因为键冲突被误替换。
// 游标 providerIndex 只对可拖条目自增，与 providerIds 的消费进度严格对齐。
// [失败路径] 目标 id 缺失或索引查不到时保留原位，函数总返回与入参等长的数组。
// 不修改入参 items，返回新数组；调用方可以安全地把它交给渲染层做比对。
function projectItemsToOptimisticProviderOrder({
  items,
  providerIds,
  reorderableProviderIds,
}: {
  items: readonly ModelProviderNavItem[];
  providerIds: readonly string[];
  reorderableProviderIds?: ReadonlySet<string>;
}): ModelProviderNavItem[] {
  const itemByProviderId = new Map(
    items.flatMap((item) => {
      const providerId = getSortableProviderId(item, reorderableProviderIds);
      return providerId ? ([[providerId, item]] as const) : [];
    }),
  );
  let providerIndex = 0;
  return items.map((item) => {
    if (!getSortableProviderId(item, reorderableProviderIds)) return item;
    const providerId = providerIds[providerIndex++];
    return (providerId && itemByProviderId.get(providerId)) || item;
  });
}

// [契约] 对外组件入参：navigationGroups、selectedNodeKey、两个 loading 标志与三个回调。
// 组件不自行读取导航数据，分组、顺序与选中键全部由父层派生后注入，边界单向。
// custom 组为空时不渲染该分组标题，避免侧栏出现只剩标题的空白段落。
// 选中项切换只经 onSelectNavItem 上报，本组件不回写 selectedNodeKey，也不做默认落点。
// [契约] 组的渲染方式按 id 分流：preset 走卡片，其余一律走可排序组，未知组按可排序处理。
export function ModelProviderSectionNavigation({
  navigationGroups,
  selectedNodeKey,
  presetLoading,
  customLoading,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
}: {
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  presetLoading: boolean;
  customLoading: boolean;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
}) {
  // [资源] 指针传感器设置 6 像素激活距离，区分点击选中与按下即拖两种手势。
  // 距离阈值过小会让点击轻微抖动就开始拖拽，过大则拖拽启动迟滞，6 是经验折中。
  // [契约] 键盘传感器配 sortableKeyboardCoordinates，方向键在纵向列表里按位置移动。
  // 传感器在组件顶层创建一次，随渲染复用；放进条件分支会导致钩子顺序不稳定。
  // 这组传感器同时交给两个可排序组，保证自定义组内的拖拽行为完全一致。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  return (
    <aside className="px-1.5 py-3 md:py-2 md:px-2">
      <div className="flex min-h-0 flex-col gap-3 max-md:gap-1">
        {navigationGroups
          .filter((group) => group.id !== "custom" || group.items.length > 0)
          .map((group) => (
            <div key={group.id} className="flex flex-col gap-2 max-md:gap-1">
              <div className="flex h-7 items-center justify-between px-2 py-1 max-md:hidden">
                <h3 className="text-ui-sm font-semibold text-foreground-subtlest">{group.title}</h3>
                {shouldShowModelProviderGroupLoadingIndicator({
                  groupId: group.id,
                  presetLoading,
                  customLoading,
                }) ? (
                  <Loader2Icon className="size-3 animate-spin text-foreground-subtlest" />
                ) : null}
              </div>

              {group.id === "preset" ? (
                <PresetProviderCardNavigation
                  group={group}
                  selectedNodeKey={selectedNodeKey}
                  onSelectNavItem={onSelectNavItem}
                />
              ) : (
                <SortableProviderNavigationGroup
                  group={group}
                  selectedNodeKey={selectedNodeKey}
                  onSelectNavItem={onSelectNavItem}
                  onReorderProviderIds={onReorderProviderIds}
                  reorderableProviderIds={reorderableProviderIds}
                  sensors={sensors}
                />
              )}
            </div>
          ))}
      </div>
    </aside>
  );
}
