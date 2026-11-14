// 组合输入框的「模型 / 思考档位」菜单：负责供应商分组导航、模型列表插槽、档位滑杆与最高档气泡动效。
// 只持有展示投影与瞬时浏览态，模型选择结果一律回传给 Composer owner，组件本身不是状态所有者。
// 不负责模型目录加载、锁定判定来源、快捷键注册，也不承担供应商菜单之外的布局与持久化。
//
// INV-01 断言：选中模型只能由 normalizedValue 与 providerMenu.selectedKey 派生 —— 守住它的位置：selected / group 计算 —— 改错故障：菜单高亮与输入框模型不一致，选择回传被本地副本覆盖。
// INV-02 断言：browse 仅在无 providerMenu 的自管模式写入且需 selection 等于当前值 —— 守住它的位置：group 的三段短路 —— 改错故障：切换供应商后被动跳组，用户看到的列表与当前模型错配。
// INV-03 断言：滑杆禁用状态与 aria-disabled 必须同源于 sliderDisabled —— 守住它的位置：sliderDisabled 与 input 的 aria-disabled —— 改错故障：禁用态仍能改档，或两处判定条件漂移。
// INV-04 断言：原生 range 不得设置 disabled 属性 —— 守住它的位置：input 上的 aria-disabled 写法 —— 改错故障：目录重读时焦点被移出，方向键落到菜单导致菜单关闭或误选。
// INV-05 断言：最高档气泡仅在填充、末档且非禁用时渲染 —— 守住它的位置：sliderFilled 与末档判断 —— 改错故障：中间档也冒气泡，让用户误以为已到最高档。
// INV-06 断言：气泡参数必须来自固定常量 —— 守住它的位置：EFFORT_BUBBLES / HIGHSPEED_BUBBLES —— 改错故障：每次重渲染重新随机，最高档气泡集体跳位抖动。
// INV-07 断言：高速态视觉只由选中模型名称派生 —— 守住它的位置：modelName 与 isGlmHighspeedModel —— 改错故障：供应商名或内部 value 含 highspeed 时误闪，别的品牌被当成高速。
// INV-08 断言：标签进度分母只计思考档位、不含无思考档 —— 守住它的位置：getComposerThoughtDisplay —— 改错故障：含无思考档时百分比整体偏低，标签与滑杆填充不同步。
// INV-09 断言：currentIndex 为 -1 时 range 的 value 必须钳到 0 —— 守住它的位置：input 的 value 表达式 —— 改错故障：受控 value 越界触发告警，滑块位置在目录刷新瞬间乱跳。
// INV-10 断言：视觉层 key 必须包含模型值、分组键与档位列表 —— 守住它的位置：内层 aria-hidden 容器 —— 改错故障：切模型时沿用上一组档位做补间，滑杆从错误位置滑入。
// INV-11 断言：视觉层重置不得重建原生 input —— 守住它的位置：key 只挂在内层装饰容器 —— 改错故障：拖拽中途 input 被替换，手势中断且焦点丢失。
// INV-12 断言：调档入口必须丢弃禁用态与同值输入 —— 守住它的位置：selectSliderValue —— 改错故障：keyup 与 click 重复回传，上层重复提交或目录反复重读。
// INV-13 断言：菜单项必须阻止默认选中行为 —— 守住它的位置：DropdownMenuItem 的 onSelect —— 改错故障：点一下滑杆菜单就关闭，无法连续调档。
// INV-14 断言：禁用态的指针按下只能阻止默认、不能阻止冒泡 —— 守住它的位置：onPointerDown —— 改错故障：Radix 点击标记残留，第一次点外部关不掉菜单。
// INV-15 断言：滑杆按键必须吞掉除 Escape 外的所有键 —— 守住它的位置：onKeyDown —— 改错故障：方向键被菜单 typeahead 抢走，焦点跳到菜单项。
// INV-16 断言：Home / End / 方向键必须在抬起时才提交 —— 守住它的位置：onKeyUp —— 改错故障：缺档时首格无 change 事件，Home 永远选不中首档。
// INV-17 断言：悬停高亮只对非触摸指针且靠近圆点中心生效 —— 守住它的位置：onPointerMove 的坐标反算 —— 改错故障：触屏拖拽误亮圆点，或圆点截获拖拽导致无法滑动。
// INV-18 断言：列表与连接信息只走插槽渲染，不缓存条目副本 —— 守住它的位置：renderItems / renderConnection 调用 —— 改错故障：目录更新后菜单仍展示旧模型，点击回传已失效的值。
// INV-19 断言：单档位必须渲染标题而非禁用滑杆 —— 守住它的位置：levels.length === 1 分支 —— 改错故障：禁用滑杆暗示可调，用户反复拖动后报障。
// INV-20 断言：外部 groups 只能在没有 providerMenu 时作为数据源 —— 守住它的位置：menuGroups 赋值 —— 改错故障：两种分组混用导致同一供应商出现两条目并回传不同 key。
import { useRef, useState, type ReactNode } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { isNoThoughtLevel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { ComposerEffortHeading } from "@/chat-input-toolbar/ComposerEffortHeading.js";
import { ComposerProviderMenu } from "@/chat-input-toolbar/ComposerProviderMenu.js";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import "@/chat-input-toolbar/composer-thought-slider.css";

// 固定种子避免重渲染重新随机，让最高档气泡错峰流动而不影响模型选择状态。
// [契约] 气泡参数是常量而非随机生成：重渲染不得产生新的 top/size/duration，否则最高档气泡会在每次滑杆重绘时跳位。
// [权衡] 12 条样本刻意错开 duration 与 delay，并用负 delay 让动画一开始就分布在中途，避免整列气泡同步起跑。
// top 用百分比行高、size 用像素，二者单位不同；调大 size 会撑破 4px 高的填充容器，看起来像气泡在闪。
// delay 为负值是关键：改成正值会让所有气泡先空白一段时间，最高档刚点亮时出现空槽。
// 若扩充到 12 条以上，高速态按长度取模的节奏会变化，需同时复核疏密观感与动画相位。
const EFFORT_BUBBLES = [
  { top: 4, size: 2, duration: 2.6, delay: -0.4 },
  { top: 14, size: 3, duration: 3.2, delay: -2.1 },
  { top: 8, size: 4, duration: 2.8, delay: -1.1 },
  { top: 18, size: 2, duration: 3.6, delay: -0.8 },
  { top: 3, size: 3, duration: 3, delay: -2.5 },
  { top: 12, size: 2, duration: 3.4, delay: -1.7 },
  { top: 6, size: 3, duration: 3.1, delay: -0.9 },
  { top: 17, size: 4, duration: 2.9, delay: -2.3 },
  { top: 10, size: 2, duration: 3.5, delay: -0.2 },
  { top: 2, size: 2, duration: 2.7, delay: -1.8 },
  { top: 15, size: 3, duration: 3.3, delay: -1.2 },
  { top: 7, size: 4, duration: 3.6, delay: -3.1 },
];

// [契约] 高速态在固定样本上派生 32 条：按长度取模复用形状，duration 压到 0.8~1.2 秒，delay 以 0.137 步进错峰。
// [权衡] 32 条不是性能上限而是视觉密度上限；再翻倍会让最高档填充区变成噪点，看不出流动方向。
// duration 公式 (8 + index % 5) / 10 依赖模数 5；改成别的值会让速度排序与低速态不连续。
// 数组元素是对象字面量展开，EFFORT_BUBBLES 被改动时这里会同步变化；不要在此处二次覆写 top 与 size。
// 此常量在模块加载时求值一次，属于纯派生数据；不要挪进组件体内，否则每次渲染都会重建 32 个对象。
const HIGHSPEED_BUBBLES = Array.from({ length: 32 }, (_, index) => ({
  ...EFFORT_BUBBLES[index % EFFORT_BUBBLES.length]!,
  duration: (8 + (index % 5)) / 10,
  delay: -index * 0.137,
}));

// [契约] ComposerModelOptions 是展示投影的只读入参：档位、当前值与文案都来自 Composer owner，组件不得缓存副本。
// levels 顺序即滑杆物理顺序，调用方改序会直接改变可拖动方向与进度百分比，组件不做排序兜底。
// value 可能不在 levels 内（目录刷新窗口），因此 currentIndex 允许为 -1，所有使用点必须自行钳位。
// onValueChange 是唯一出口；不要在这里加本地 state 做乐观回显，否则 owner 拒绝变更时界面与事实不符。
// providerMenu 为可选：缺省表示由本组件自行维护分组浏览，存在时所有选择都必须原样上抛。
export interface ComposerModelOptions {
  providerMenu?: {
    groups: readonly ComposerPlanGroup[];
    selectedKey?: string;
    pending: boolean;
    error: string | null;
    onSelect: (group: ComposerPlanGroup) => void;
  };
  providerLabel: string;
  modelsLabel: string;
  effortLabel: string;
  effortShortcutLabel?: string;
  selectModelLabel: string;
  levels: readonly { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
}

// [契约] 进度分母只数思考档位，无思考档被过滤，因此首档进度不是 0 而是 1/thinking.length。
// [失败路径] 当前值不在 levels 内时返回「—」与 0 进度；不要改成回退首档，否则目录重读瞬间标签会假报档位。
// thinking.findIndex 用 value 而非引用比较，目录重建后仍能命中；改成对象比较会让进度归零。
// thinking.length 为 0 时表达式会得到 Infinity 或 NaN，调用方必须保证 levels 至少含一个思考档。
// 返回值同时被滑杆 aria-valuetext 与标题复用；不要在这里做本地化拼接，文案由 label 自带。
export function getComposerThoughtDisplay(options: ComposerModelOptions) {
  const current = options.levels.find((level) => level.value === options.value);
  const thinking = options.levels.filter((level) => !isNoThoughtLevel(level));
  const progress =
    current && !isNoThoughtLevel(current)
      ? ((thinking.findIndex((level) => level.value === current.value) + 1) / thinking.length) * 100
      : 0;
  return { label: current?.label ?? "—", progress };
}

// [契约] 判定只用显示名称，且必须同时命中品牌与高速词；只匹配 highspeed 会把别家同名型号算进来。
// 名称来自目录的 name 字段而非 value：value 常含内部渠道前缀，用它判定会误触发视觉。
// 正则不区分大小写并允许中间夹词，是为了覆盖「GLM-4.6-FlashX」这类写法；收紧成精确匹配会漏判。
// 该函数被导出供测试与别处复用，改语义前要确认没有第二处依赖同一视觉约定。
export function isGlmHighspeedModel(name: string) {
  // GLM FlashX 与 Highspeed 共用视觉；只按显示名称判定，避免误命中其他品牌。
  return /glm/i.test(name) && /highspeed|flashx/i.test(name);
}

// [契约] 指示器只读 options 派生标签与进度，自身无状态；不要在组件内再加 state 承接档位。
// 紧凑布局靠 group-data 属性切换标签与竖条：两处 class 必须成对，缺一半会出现标签和竖条同时隐藏。
// 竖条高度用百分比 style 而非 class 切换，进度为 0 时仍渲染 0 高填充，便于过渡动画连续。
// highspeed 只切 data 属性交给 CSS，不在 JS 里算颜色，主题变更时无需重渲染。
export function ComposerThoughtIndicator({
  options,
  highspeed = false,
}: {
  options: ComposerModelOptions;
  highspeed?: boolean;
}) {
  const { label, progress } = getComposerThoughtDisplay(options);
  return (
    <>
      <span
        className="shrink-0 text-foreground-subtle group-data-[composer-compact=true]/combined:hidden"
        data-composer-thought-label
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        data-testid="composer-thought-meter"
        data-highspeed={highspeed}
        data-progress={progress}
        className="relative hidden h-4 w-1 shrink-0 overflow-hidden rounded-full bg-foreground/10 group-data-[composer-compact=true]/combined:block"
      >
        <span
          className="composer-thought-meter-fill absolute bottom-0 left-0 w-full rounded-full bg-success"
          style={{ height: `${progress}%` }}
        />
      </span>
    </>
  );
}

// [契约] 本组件是纯展示层：模型目录、锁定判定与选择回传全部由 props 注入，不在此处发起加载。
// onSelectModel 与 providerMenu.onSelect 是两条互斥链路，按 providerMenu 是否存在分流，不能同时写。
// renderItems 与 renderConnection 是插槽，组件不持有其内部状态；菜单重渲染不应导致插槽内容重建。
// 所有派生值（选中项、当前组、模型名、滑杆状态）都在渲染体内即时计算，不要缓存到 ref 或 state。
// 此处没有副作用与订阅；新增 effect 前先确认是否属于 owner 职责，否则会出现两份目录事实。
export function ComposerModelMenu({
  groups,
  normalizedValue,
  options,
  renderItems,
  renderConnection,
  providerFooter,
  isItemLocked,
  onSelectModel,
}: {
  groups: readonly ModelSelectGroup[];
  normalizedValue: string;
  options: ComposerModelOptions;
  renderItems: (items: ModelSelectGroup["items"]) => ReactNode;
  renderConnection: (group: ModelSelectGroup) => ReactNode;
  providerFooter?: ReactNode;
  isItemLocked: (value: string) => boolean;
  onSelectModel: (value: string) => void;
}) {
  // 无可用模型的分组仍可浏览配置；实际选择始终由 Composer owner 回传。
  // [契约] browse 只在自管分组模式（无 providerMenu）写入，记录用户刚点的分组与当时选中的模型。
  // [权衡] selection 必须与 normalizedValue 相等才认这份浏览态；不相等说明选中模型已变，浏览态自动失效。
  // 不要把 browse 提升为受控状态或持久化：它只服务于「切换分组后停在该组」的瞬时导航。
  // providerMenu 存在时该 state 永远为 null，残留值也不会生效，属于可接受的惰性失效。
  // [失败路径] 若在 onSelect 之外写入 browse，分组会在用户未导航时被强制切换，看起来像菜单自己乱跳。
  const [browse, setBrowse] = useState<{ key: string; selection: string } | null>(null);
  // [契约] 有 providerMenu 时以它下发的 groups 为准，外部 groups 仅作为无 provider 模式的数据源。
  // 两种分组类型形状兼容但语义不同：providerMenu 的 key 带注册表前缀，混用会让分隔线定位失效。
  // 这里不复制、不排序、不补齐：分组顺序即渲染顺序，调用方负责稳定排序，否则每次重渲染分组会跳位。
  // groups.length === 0 且已有当前值是「目录未就绪」而非「无模型」，由 catalogPending 单独表达。
  // [失败路径] 若在此做 fallback 合并两份分组，会出现同一 provider 两个可点条目并各自回传不同 key。
  const menuGroups: readonly ComposerPlanGroup[] = options.providerMenu?.groups ?? groups;
  // [契约] 选中项优先按 providerMenu.selectedKey 定位，其次才按 normalizedValue 在条目里反查。
  // 两级 fallback 的顺序不能调换：selectedKey 是 owner 的事实，反查只是目录里恰好同值的兜底。
  // 反查只在 items 上做存在性判断，不必取出命中的条目；缓存命中项会与目录快照脱节。
  // menuGroups 为空时 selected 为 undefined，后续 group 会落到首组，同样为 undefined。
  // [失败路径] 若这里再按显示名模糊匹配，重名模型会被解析到错误分组，选择后模型不变。
  const selected =
    menuGroups.find((group) => group.key === options.providerMenu?.selectedKey) ??
    menuGroups.find((group) => group.items.some((item) => item.value === normalizedValue));
  // [契约] 分组优先级：有效浏览态 > 选中项所属分组 > 首组；三者在同一表达式里按序短路。
  // 浏览态命中要求 browse.selection 与当前 normalizedValue 完全相等，且 key 仍能在 menuGroups 中找到。
  // 不要为「找不到浏览分组」加兜底写入，浏览态本就允许因目录变化而失效并自然回落到选中项。
  // [失败路径] 若把 browse 判断放到选中项之后，切换分组会立刻被选中项拉回，分组导航失效。
  const group =
    (browse?.selection === normalizedValue
      ? menuGroups.find((item) => item.key === browse.key)
      : undefined) ??
    selected ??
    menuGroups[0];
  // 视觉只由选中模型名称派生，避免供应商名或内部 value 含 highspeed 时误触发。
  // [契约] 视觉名只从 selected 分组里取当前 value 对应的 name，缺失则为空串。
  // normalizedValue 是跨分组唯一的模型值；不要用菜单当前 group 取 name，否则浏览别组时视觉会随之变化。
  // [权衡] 名称为空时高速判定为 false：宁可少闪一次，也不要按供应商名兜底。
  // 此处的 selected 可能来自 providerMenu，不保证 items 完整；缺失时保持空而不是回退首个模型。
  const modelName = selected?.items.find((item) => item.value === normalizedValue)?.name ?? "";
  const highspeed = isGlmHighspeedModel(modelName);
  const currentGroupSelected = group?.key === selected?.key && Boolean(selected);
  const currentIndex = options.levels.findIndex((level) => level.value === options.value);
  const { label } = getComposerThoughtDisplay(options);
  const sliderRef = useRef<HTMLInputElement>(null);
  const catalogPending = groups.length === 0 && Boolean(normalizedValue);
  const showEffort = options.levels.length > 0 || catalogPending;
  const [hoveredStop, setHoveredStop] = useState<string | null>(null);
  // [契约] 禁用由三件事合成：供应商菜单 pending、当前分组未选中、档位不足两个。
  // pending 期间必须禁用以防回传与目录重读竞态；但禁用只走 aria，不设原生 disabled。
  // currentGroupSelected 为 false 表示展示的分组并不是当前模型所属分组，此时调档会写错模型。
  // levels.length 小于 2 时无档可调；单档位走标题分支，这里仍返回 true 以统一事件拦截口径。
  // [失败路径] 若漏掉 pending，快速拖动会在目录重读窗口把旧档位写回新模型。
  const sliderDisabled =
    Boolean(options.providerMenu?.pending) || !currentGroupSelected || options.levels.length < 2;
  // [契约] 进度按 currentIndex 除以（档位数减一）归一，端点分别落在 0 与 100。
  // 分母取 `options.levels.length - 1` 而不是标签侧的思考档数量，两套口径不得互换。
  // 未选中分组或 currentIndex 为 -1 时进度为 0，视觉停在最左，避免把未知状态画成中间档。
  // 填充宽度为两端各留 14px 圆点半径，纯百分比会让拇指越出轨道边界。
  // [失败路径] 若给 0 进度也渲染填充，最左端会出现一小段绿色，被误读成已选首档。
  const sliderProgress =
    options.levels.length > 1 && currentIndex >= 0 && currentGroupSelected
      ? (currentIndex / (options.levels.length - 1)) * 100
      : 0;
  const sliderFilled =
    currentGroupSelected && currentIndex >= 0 && !isNoThoughtLevel(options.levels[currentIndex]!);
  // [契约] 调档唯一入口：校验禁用与同值后，只把档位值上抛，不在此处改任何本地状态。
  // 同值直接丢弃是必要的：keyup 与 click 会针对同一次手势重复触发，去重后才能让 owner 拿到一次性意图。
  // [并发] 目录重读期间 levels 可能已换，index 越界时档位为 undefined，必须静默返回而非回退首档。
  // 不要在其中读取事件对象：调用方传的是输入框当前数值，避免事件对象在异步回传中被复用。
  // [失败路径] 若在此做乐观更新或写浏览态，owner 拒绝变更后滑杆会停在一个不存在的档位上。
  const selectSliderValue = (index: number) => {
    const level = options.levels[index];
    if (!sliderDisabled && level && level.value !== options.value)
      options.onValueChange(level.value);
  };
  return (
    <>
      <ComposerProviderMenu
        groups={menuGroups}
        error={options.providerMenu?.error}
        disabled={options.providerMenu?.pending}
        loading={options.providerMenu?.pending}
        isDisabled={(candidate) => Boolean((candidate as ComposerPlanGroup).connection?.disabled)}
        separatorBeforeKey={
          options.providerMenu
            ? menuGroups.find(
                (candidate) =>
                  !candidate.connection && !candidate.key.startsWith("registry-provider:account:"),
              )?.key
            : undefined
        }
        group={group}
        label={options.providerLabel}
        providerFooter={providerFooter}
        onSelect={(candidate) => {
          if (options.providerMenu) {
            options.providerMenu.onSelect(candidate as ComposerPlanGroup);
            return;
          }
          setBrowse({ key: candidate.key, selection: normalizedValue });
          // 复用唯一选择链路，供应商页只负责导航，不缓存模型状态。
          // [契约] 切换分组后自动选一个可用模型：优先保留当前值，其次取该组首个未锁定项。
          // 两步都带锁定过滤，锁定项不可被自动选中；保留当前值这一步同样要求未锁定。
          // 仅在候选值与当前值不同才回传，避免点击当前分组触发一次多余的选择与重读。
          // [失败路径] 若去掉第二步的锁定过滤，进入全锁定分组会自动选中一个不可用模型并提示失败。
          // 此处不写回浏览态的 selection；它只记录进入分组时的值，由 normalizedValue 变化自然判定失效。
          const model =
            candidate.items.find(
              (item) => item.value === normalizedValue && !isItemLocked(item.value),
            ) ?? candidate.items.find((item) => !isItemLocked(item.value));
          if (model && model.value !== normalizedValue) onSelectModel(model.value);
        }}
      >
        <DropdownMenuSeparator className="bg-border/50" />
        <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
          {options.modelsLabel}
        </DropdownMenuLabel>
        {group ? renderConnection(group) : null}
        <ScrollFadeViewport
          className="max-h-60 flex-initial"
          inert={options.providerMenu?.pending || undefined}
          data-composer-model-list
        >
          {group ? renderItems(group.items) : null}
        </ScrollFadeViewport>
        {showEffort ? (
          <>
            <DropdownMenuSeparator className="bg-border/50" />
            {options.levels.length === 1 ? (
              // 单一档位没有可调范围；旧逻辑渲染禁用滑杆并提示快捷键，误导用户可调档。
              <div className="px-2 py-2">
                <ComposerEffortHeading
                  label={options.effortLabel}
                  value={currentGroupSelected ? label : "—"}
                />
              </div>
            ) : (
              <DropdownMenuItem
                className="block px-2 py-2 focus:bg-transparent"
                aria-disabled={sliderDisabled}
                onSelect={(event) => event.preventDefault()}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) sliderRef.current?.focus();
                }}
              >
                <ComposerEffortHeading
                  label={options.effortLabel}
                  value={currentGroupSelected ? label : "—"}
                  shortcut={options.effortShortcutLabel}
                />
                <div
                  className="composer-thought-slider relative h-8 w-full rounded-full"
                  data-disabled={sliderDisabled}
                >
                  <div
                    // 模型或档位目录变化时只重置视觉层，避免跨模型补间，同时保留 input 焦点。
                    key={JSON.stringify([
                      normalizedValue,
                      group?.key,
                      options.levels.map((level) => level.value),
                    ])}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                  >
                    <div
                      data-testid="composer-thought-track"
                      data-progress={sliderFilled ? sliderProgress : 0}
                      className="absolute inset-x-0 top-1 h-6 overflow-hidden rounded-full bg-foreground/10"
                    >
                      {/* 外层 border 会包住绿色填充；描边放到底层，让选中区域完全覆盖它。 */}
                      <div className="absolute inset-0 rounded-full border border-foreground/10" />
                      <div
                        className="composer-thought-slider-fill absolute inset-y-0 left-0 overflow-hidden rounded-full"
                        data-max={sliderFilled && currentIndex === options.levels.length - 1}
                        data-highspeed={highspeed && currentGroupSelected}
                        style={{
                          width: sliderFilled
                            ? `calc(14px + (100% - 28px) * ${sliderProgress / 100})`
                            : 0,
                        }}
                      >
                        {sliderFilled &&
                        currentIndex === options.levels.length - 1 &&
                        !sliderDisabled ? (
                          <div
                            data-testid="composer-thought-bubbles"
                            className="composer-thought-bubbles absolute inset-0"
                          >
                            {(highspeed ? HIGHSPEED_BUBBLES : EFFORT_BUBBLES).map(
                              (bubble, index) => (
                                <span
                                  key={index}
                                  className="composer-thought-bubble absolute inset-x-0"
                                  style={{
                                    top: bubble.top,
                                    animationDuration: `${bubble.duration}s`,
                                    animationDelay: `${bubble.delay}s`,
                                  }}
                                >
                                  <span
                                    className="block rounded-full bg-white"
                                    style={{ width: bubble.size, height: bubble.size }}
                                  />
                                </span>
                              ),
                            )}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div className="absolute inset-x-3.5 inset-y-0 flex items-center justify-between">
                      {options.levels.map((level, index) => (
                        <span
                          key={level.value}
                          data-composer-thought-stop
                          data-filled={sliderFilled && index <= currentIndex}
                          data-hovered={
                            !sliderDisabled && hoveredStop === `${normalizedValue}:${level.value}`
                          }
                          className="composer-thought-slider-stop size-1 shrink-0 rounded-full"
                        />
                      ))}
                    </div>
                    <div
                      className="composer-thought-slider-thumb absolute top-0.5 size-7 rounded-full shadow-sm"
                      style={{ left: `calc((100% - 28px) * ${sliderProgress / 100})` }}
                    />
                  </div>
                  <input
                    ref={sliderRef}
                    type="range"
                    min={0}
                    max={Math.max(0, options.levels.length - 1)}
                    step={1}
                    value={Math.max(0, currentIndex)}
                    // 目录在调档后会短暂重读；原生 disabled 会移走焦点，后续方向键落到菜单。
                    // 用 aria-disabled 保留焦点，等待期间通过事件与提交入口阻止交互。
                    aria-disabled={sliderDisabled}
                    aria-label={options.effortLabel}
                    aria-valuetext={currentGroupSelected ? label : "—"}
                    data-testid="composer-thought-slider"
                    data-levels={JSON.stringify(options.levels.map((level) => level.value))}
                    className="composer-thought-range absolute inset-0 m-0 h-8 w-full cursor-pointer appearance-none bg-transparent outline-none aria-disabled:cursor-default"
                    onPointerDown={(event) => {
                      // 拦截冒泡会让 Radix 的内部点击标记残留，导致第一次外部点击无法关闭菜单。
                      if (sliderDisabled) event.preventDefault();
                    }}
                    onPointerLeave={() => setHoveredStop(null)}
                    onPointerMove={(event) => {
                      // 原生 range 覆盖圆点，用坐标反馈悬停，避免圆点截获拖拽事件。
                      const rect = event.currentTarget.getBoundingClientRect();
                      const trackWidth = rect.width - 28;
                      const index = Math.round(
                        ((event.clientX - rect.left - 14) / trackWidth) *
                          (options.levels.length - 1),
                      );
                      const level = options.levels[index];
                      const center =
                        rect.left + 14 + (trackWidth * index) / (options.levels.length - 1);
                      setHoveredStop(
                        !sliderDisabled &&
                          event.pointerType !== "touch" &&
                          level &&
                          Math.abs(event.clientX - center) <= 10
                          ? `${normalizedValue}:${level.value}`
                          : null,
                      );
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") {
                        event.stopPropagation();
                        if (sliderDisabled && event.key !== "Tab") event.preventDefault();
                      }
                    }}
                    // 原因：缺失档位时 range 的物理位置仍为 0；Home 或点击首格不触发 change，
                    // 必须在明确完成手势时接纳首格选择，不能把展示位置提前当成用户意图。
                    onKeyUp={(event) => {
                      if (
                        [
                          "Home",
                          "End",
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                          "PageUp",
                          "PageDown",
                        ].includes(event.key)
                      )
                        selectSliderValue(Number(event.currentTarget.value));
                    }}
                    onPointerUp={(event) => {
                      selectSliderValue(Number(event.currentTarget.value));
                    }}
                    onChange={(event) => selectSliderValue(Number(event.currentTarget.value))}
                  />
                </div>
              </DropdownMenuItem>
            )}
          </>
        ) : null}
      </ComposerProviderMenu>
    </>
  );
}
