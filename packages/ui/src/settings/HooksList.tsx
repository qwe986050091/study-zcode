// HooksList：设置页 Hooks 面板的分组列表展示层（分区头 + Hook 行 + 空态）。
// 负责：把 editableHooks / compatibilityHooks / pluginHooks 三类输入归组为有序分区，并渲染行级操作入口。
// 不负责：读写 zcode.json、执行 Hook、判定信任有效性、持久化开关；这些由上层设置页与 settings 服务负责，本文件只消费其结果。
//
// 不变量（每条都对应一个容易被顺手改掉的点）：
// INV-01 断言：分区顺序恒为「Installed → 插件分组（key 升序）→ Legacy」 —— 守住它的位置：groupHookSections 的三段 push —— 改错故障：Legacy 与 Installed 对调后，用户会把旧配置当成新装 Hook 误删。
// INV-02 断言：editableHooks 为空时不产生 Installed 分区 —— 守住它的位置：groupHookSections 中 editableHooks.length > 0 的判断 —— 改错故障：出现 0 计数空分区，与 showInstalledSection 空态叠成双空态。
// INV-03 断言：Installed 空占位只由 showInstalledSection 且 editableHooks 为空触发 —— 守住它的位置：HooksList 的 sections 三元表达式 —— 改错故障：默认页凭空冒出「Installed 0」空卡片。
// INV-04 断言：插件分组键优先取 pluginId，为空才退回 pluginName 去空白小写 —— 守住它的位置：groupHookSections 的 key 计算 —— 改错故障：同名不同 id 的插件被合并，行内 pluginId 取错，改一个牵连另一个。
// INV-05 断言：分组聚合不修改输入数组与 hook 对象 —— 守住它的位置：分组桶的展开重建 —— 改错故障：原地 push 污染上层 props，render 期间数组被改写，出现行重复或丢失。
// INV-06 断言：插件分组之间按 key 的 localeCompare 升序 —— 守住它的位置：entries 展开后的 sort —— 改错故障：顺序退化为上游 props 顺序，每次 Hook 增删列表都会跳动。
// INV-07 断言：同一插件内 Hook 保持输入顺序 —— 守住它的位置：分组循环只 append 不排序 —— 改错故障：用户按位置记住的 Hook 全部错位，操作打到相邻行。
// INV-08 断言：PluginHookRow.pluginId 允许为空串 —— 守住它的位置：分区 pluginId 取值处的空值兜底 —— 改错故障：去掉兜底后无 id 旧插件产出 undefined，参与 section key 拼接时撞键。
// INV-09 断言：section key 靠 kind 加 pluginId 或 kind 加 title 拼成唯一值 —— 守住它的位置：section 元素的 key 表达式 —— 改错故障：同 kind 同标题的两个分区 key 相撞，React 复用错行，开关状态串到别的插件上。
// INV-10 断言：requiresTrust 为真时 Switch 的 checked 强制为 false —— 守住它的位置：ConfiguredHookRow 的 checked 表达式 —— 改错故障：未信任的 workspace Hook 显示为已启用，实际被运行时丢弃。
// INV-11 断言：Switch 的 disabled 至少包含 busy、trusting、requiresTrust、readOnly 四项 —— 守住它的位置：ConfiguredHookRow 的 Switch 属性 —— 改错故障：信任审核中或只读行仍可点击，触发注定失败的写入，出现开关弹回的假故障。
// INV-12 断言：只读行仍保留 Trust 按钮 —— 守住它的位置：ConfiguredHookRow 中 readOnly 与 actions 的分离 —— 改错故障：把 readOnly 当成整行禁用后，用户失去在 Settings 完成信任的唯一入口。
// INV-13 断言：Trust 按钮在 trustActionAvailable 为假时禁用并给出不可用文案 —— 守住它的位置：Trust 按钮的 disabled 与 title —— 改错故障：按钮可点却无反应，用户重复点击或误以为已提交信任。
// INV-14 断言：行内 Trust 与 Switch 的点击都必须 stopPropagation —— 守住它的位置：两处 onClick 处理 —— 改错故障：点击冒泡到整行编辑手势，用户点开关的同时被推进编辑弹层。
// INV-15 断言：busy 时整行 onEdit 置空、行不可点击 —— 守住它的位置：HookItemFrame 的 onEdit 传参 —— 改错故障：操作进行中再次进入编辑并提交，两次写入以后写覆盖前写。
// INV-16 断言：展示命令由 command 与 args 以单空格拼成 —— 守住它的位置：两处 join 调用 —— 改错故障：漏掉 args 或多出空格后，用户拷贝界面命令执行失败，排查方向被带偏。
// INV-17 断言：pluginScope 缺失时渲染 scopeUnknown 徽标 —— 守住它的位置：PluginHookItem 的 trailingBadges 三元 —— 改错故障：静默省略后无法区分全范围插件与元数据缺失，用户误判生效范围。
// INV-18 断言：行交互属性展开必须是 HookItemFrame 的最后一项 props —— 守住它的位置：settingsResourceRowInteraction 的展开位置 —— 改错故障：外部同名属性被覆盖，行点击行为与 testId 不一致，E2E 点到错误元素。
// INV-19 断言：仅可编辑行带 hover 底色与指针反馈 —— 守住它的位置：HookItemFrame 的 className 条件片段 —— 改错故障：只读行保留 hover 高亮，用户以为可点并反复点击。
// INV-20 断言：所有异步回调都以 void 调用 —— 守住它的位置：Switch、Trust、Import 的 onClick lambda —— 改错故障：Promise 逃逸成未捕获拒绝，写入失败静默无提示。
//
// 阅读顺序：groupHookSections（分区顺序的唯一来源）→ HooksList（JSX 组装）→ ConfiguredHookRow（三态禁用）→ PluginHookItem（插件行）。
// 本文件不持状态、不发请求、不写日志；引入缓存前先确认上游确实重复渲染，否则只会掩盖数据陈旧。
// TSX 约束：新增注释只能落在语句或声明层面，行内属性区与 JSX 文本区一律不得插入注释。
// 与 WorkspaceHookTrustNotice、settingsResourceRowInteraction 是弱耦合：只调用其纯函数，不反向依赖设置页状态。
import type { ReactNode } from "react";
import { Anchor, Download, ShieldCheck } from "lucide-react";
import type { Hook, PluginHookDetail, PluginScope } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginInstallEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { requiresWorkspaceHookTrust } from "@/settings/WorkspaceHookTrustNotice.js";

// [契约] 这里的 scope 是展示分域（用户级 / 项目级），不是运行时匹配作用域；不要把它当成 PluginScope 或 workspace scope 复用。
// 需要运行时作用域判断时用 hook 自带字段与 requiresWorkspaceHookTrust，两套概念混用会让只读行被误判成可写行。
// 字符串字面量被上层开关与 i18n key 直接引用，改字面量会同时打断持久化数据与文案映射。
export type HookScope = "user" | "project";

// [契约] 这是设置页把插件 Hook 投影给本组件的最小载荷，字段全部由上层组装，本文件不回填、不推导。
// pluginScope 与 pluginIconItem 是可选：缺失分别表示元数据未知与无图标，二者在渲染层都有独立降级分支。
// pluginId 允许空串（旧插件数据没有 id），分组时才会退化成按名字；在这里补默认值会掩盖上游数据缺口。
// pluginEnabled 由本文件透传但不参与禁用判断，真正决定 Switch 状态的是 Hook.enabled 与信任标记。
export interface PluginHookRow {
  detail: PluginHookDetail;
  pluginEnabled: boolean;
  pluginId: string;
  pluginName: string;
  pluginScope?: PluginScope;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
}

// [契约] 判别联合的 kind 决定渲染分支与 key 前缀，三个分支的字段集合不同，新增字段必须三个分支同步。
// title 对 installed / legacy 是写死英文，真正展示走 intl key；只有插件分区直接用 title 原文。
// pluginId 只在 kind 为 plugin 时存在；渲染时按 kind 收窄再取，不要在外层用可选链兜底掩盖漏判。
type HookSection =
  | { kind: "installed"; title: "Installed"; count: number; hooks: Hook[] }
  | { kind: "legacy"; title: "Legacy"; count: number; hooks: Hook[] }
  | { kind: "plugin"; title: string; pluginId: string; count: number; hooks: PluginHookRow[] };

// [契约] 纯函数：只读三个入参、返回新数组，无副作用无缓存，可安全在 render 期间调用。
// 顺序契约：Installed → 各插件分组（key 升序）→ Legacy，三段 push 的先后就是最终渲染顺序。
// 不要为了「看起来更整齐」把 Legacy 提到插件前面：旧配置排在末尾是刻意设计，避免用户误把待迁移项当生效项。
// 三个入参全为空时返回空数组也是合法结果，是否补空占位分区交给 HooksList 决定。
export function groupHookSections(
  editableHooks: Hook[],
  compatibilityHooks: Hook[],
  pluginHooks: PluginHookRow[],
): HookSection[] {
  // [权衡] 用可变数组累加而不是 concat 链，是为了保持三段 push 的阅读顺序与稳定结构；不要改成单条表达式。
  // 这个局部数组只作为返回值交出，不会被其他路径共享，调用方可安全持有。
  // 顺序改动必须同步本文件的分区契约与相关快照测试，否则只会在 UI 断言上暴露差异。
  const sections: HookSection[] = [];
  if (editableHooks.length > 0) {
    sections.push({
      kind: "installed",
      title: "Installed",
      count: editableHooks.length,
      hooks: editableHooks,
    });
  }
  // [契约] 分组桶按首次出现顺序创建，遍历顺序由 Map 插入序保证，这是排序之外唯一的保序依据。
  // 只用 Map 而不是对象，避免插件 id 撞上原型属性名（constructor、__proto__）时读到脏值。
  // 桶内数组每次都是新数组（展开重建），同组多条 Hook 的先后就是 pluginHooks 的输入顺序。
  // 键类型固定为 string，不要改成 number 或复合键，排序处的 localeCompare 依赖字符串语义。
  const pluginGroups = new Map<string, PluginHookRow[]>();
  // [契约] 单次遍历 `pluginHooks` 填桶，循环内不排序也不查找；复杂度 O(n)。
  // 循环体内只写分组桶、不读分组结果，所以同批次内不存在「前一条影响后一条」的顺序依赖。
  // 如果将来要按插件启用状态过滤，应放在上层投影阶段；在这里跳过条目会让 count 与分区标题对不上实际行数。
  for (const hook of pluginHooks) {
    // [契约] 分组键退化规则：有 pluginId 用 id，没有才用去空白后的小写名字，保证同一插件的不同写法落进同一个桶。
    // 名字必须先 trim 再小写：上游偶发带尾随空格，不 trim 会把同一插件拆成两个分区并各自显示计数。
    // 不要改用 toLowerCase（无 locale）：这里只需要稳定的比较键，不需要本地化语义。
    // 空 id 且名字为空串会得到空键，所有此类 Hook 并成一个空标题分区，属于已知降级而非缺陷。
    const key = hook.pluginId || hook.pluginName.trim().toLocaleLowerCase();
    pluginGroups.set(key, [...(pluginGroups.get(key) ?? []), hook]);
  }
  // [契约] 先展开成数组再排序，不对 Map 自身重排；Map 的遍历顺序保持插入序且只读。
  // 排序键用 localeCompare 而不是减法：插件 id 可能是带连字符的字符串视图别名，相减会得到 NaN。
  // 比较函数只比较 key、不比较桶内数量，否则 Hook 增删会让分区在界面上跳位。
  // 排序发生在 push 之前，最终 sections 里插件分区天然有序，渲染层不需要再 sort。
  for (const [, hooks] of [...pluginGroups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    sections.push({
      kind: "plugin",
      pluginId: hooks[0]?.pluginId ?? "",
      title: hooks[0]?.pluginName ?? "",
      count: hooks.length,
      hooks,
    });
  }
  // [契约] Legacy 分区永远最后 push，且空数组时完全不产生分区（不像 Installed 还有占位开关）。
  // compatibilityHooks 是尚未迁移的旧格式，只有 Import 动作、没有 Switch 与 Trust，属于「只能迁不能改」。
  // 不要把它合并进 installed 分区：两者的操作列与空态语义不同，合并会让 Import 按钮出现在可配置行上。
  if (compatibilityHooks.length > 0) {
    sections.push({
      kind: "legacy",
      title: "Legacy",
      count: compatibilityHooks.length,
      hooks: compatibilityHooks,
    });
  }
  return sections;
}

// [契约] 完全受控的展示组件：开关、信任、编辑、导入全部是上层回调，本地不保存任何 Hook 状态。
// 异步回调都返回 Promise，组件只按传入的 operatingHookId、trustingHookId 计算逐行加载态，不自行维护 pending 集合。
// 不要在这里加 useMemo 缓存分组：分组是纯函数且开销与 Hook 数同级，缓存反而制造陈旧分区（增删后不刷新）。
// showInstalledSection 默认 false：只有设置页主入口需要「无 Hook 时也显示 Installed 空态」，其他调用点不应出现该分区。
export function HooksList({
  compatibilityHooks,
  editableHooks,
  operatingHookId,
  pluginHooks,
  trustActionAvailable = false,
  trustingHookId,
  onEdit,
  onImport,
  onTrust,
  onToggle,
  formatPluginName = (name) => name,
  installedAction,
  installedEmptyActions,
  installedEmptyDescription,
  installedEmptyTitle,
  showInstalledSection = false,
}: {
  compatibilityHooks: Hook[];
  editableHooks: Hook[];
  operatingHookId: string | null;
  pluginHooks: PluginHookRow[];
  trustActionAvailable?: boolean;
  trustingHookId?: string | null;
  onEdit: (hook: Hook) => void;
  onImport: (hook: Hook) => Promise<void>;
  onTrust?: (hook: Hook) => Promise<void>;
  onToggle: (hook: Hook, enabled: boolean) => Promise<void>;
  formatPluginName?: (name: string, pluginId?: string) => string;
  installedAction?: ReactNode;
  installedEmptyActions?: ReactNode;
  installedEmptyDescription?: string;
  installedEmptyTitle?: string;
  showInstalledSection?: boolean;
}) {
  // 只取 intl 做文案，不在这里读取 locale 状态；切换语言由 Provider 触发重渲染，本组件无需订阅。
  // formatMessage 的 id 全部是字面量，缺翻译时回退成 id 本身，不要拼接动态 id。
  const { intl } = useZCodeIntl();
  // [契约] 入参顺序是（editable、compatibility、plugin），与签名一致；传反会让 Legacy 落进 Installed 分区并显示错误操作列。
  // 每次渲染都重算分组是刻意为之：上游 props 变化（增删 Hook、插件重载）必须立刻反映，缓存即缺陷。
  // 结果只在本函数内使用，不要提升到模块作用域，否则跨设置页会共享上一次的数据。
  const groupedSections = groupHookSections(editableHooks, compatibilityHooks, pluginHooks);
  // [契约] 空态占位只补在最前面：showInstalledSection 为真且没有可编辑 Hook 时，插入一个 0 计数的 installed 分区。
  // 补出来的分区 hooks 为空，渲染分支会落到 PluginInstallEmptyState，这是空态的唯一入口。
  // 不要把这个占位放进 groupHookSections：它带有 UI 开关语义，纯函数不应该知道 showInstalledSection。
  // 真实 installed 非空时不会插入占位，因此不会出现「既有行又有空态」的叠加。
  const sections: HookSection[] =
    showInstalledSection && editableHooks.length === 0
      ? [{ kind: "installed", title: "Installed", count: 0, hooks: [] }, ...groupedSections]
      : groupedSections;

  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <section
          key={`${section.kind}:${section.kind === "plugin" ? section.pluginId : section.title}`}
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
              {section.kind === "plugin"
                ? formatPluginName(section.title, section.pluginId)
                : intl.formatMessage({
                    id:
                      section.kind === "installed"
                        ? "settings.hooks.group.installed"
                        : "settings.hooks.group.legacy",
                  })}
              <span className="text-ui-sm font-normal text-foreground-subtle">{section.count}</span>
            </h3>
            {section.kind === "installed" ? installedAction : null}
          </div>
          {section.kind === "installed" && section.hooks.length === 0 ? (
            <PluginInstallEmptyState
              title={installedEmptyTitle ?? ""}
              description={installedEmptyDescription ?? ""}
              actions={installedEmptyActions}
            />
          ) : (
            <div className="overflow-hidden rounded-xl bg-surface">
              {section.kind === "plugin"
                ? section.hooks.map((hook, index) => (
                    <div key={`${hook.pluginId}-${hook.detail.sourcePath}-${index}`}>
                      {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                      <PluginHookItem hook={hook} />
                    </div>
                  ))
                : section.hooks.map((hook, index) => (
                    <div key={hook.id}>
                      {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                      {section.kind === "installed" ? (
                        <ConfiguredHookRow
                          hook={hook}
                          busy={operatingHookId === hook.id}
                          readOnly={hook.editable === false}
                          requiresTrust={requiresWorkspaceHookTrust(hook)}
                          trustActionAvailable={trustActionAvailable}
                          trusting={trustingHookId === hook.id}
                          onToggle={onToggle}
                          onEdit={onEdit}
                          onTrust={onTrust}
                        />
                      ) : (
                        <CompatibilityHookRow hook={hook} busy={operatingHookId === hook.id} onImport={onImport} />
                      )}
                    </div>
                  ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// [契约] `PluginHookRow` 的三类来源共用同一骨架：图标 / 内容 / 动作 3 列，窄屏收敛为 2 列。
// [资源] settingsResourceRowInteraction(onEdit) 必须作为 props 展开的最后一项：它可能带 role、tabIndex、onClick，提前展开会被外部同名属性覆盖。
// onEdit 为空即只读行：此时不挂 hover 底色与指针反馈，视觉上必须与可编辑行有明确差异。
// testId 只用于测试定位，不要拿它驱动样式或分支；生产构建里它是静态字符串。
// pluginIconItem 缺失时渲染 Anchor 占位图标并标 aria-hidden，避免屏幕阅读器把装饰图标读成内容。
function HookItemFrame({
  actions,
  children,
  onEdit,
  pluginIconItem,
  testId,
}: {
  actions?: ReactNode;
  children: ReactNode;
  onEdit?: () => void;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
  testId?: string;
}) {
  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] ${onEdit ? "transition-colors hover:bg-hover" : ""}`}
      data-testid={testId}
      {...settingsResourceRowInteraction(onEdit)}
    >
      {pluginIconItem ? (
        <PluginStoreAvatar
          item={pluginIconItem}
          className="size-9 bg-background"
          iconClassName="size-4"
          fallbackIcon={<Anchor className="size-4" />}
        />
      ) : (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle"
          aria-hidden="true"
        >
          <Anchor className="size-4" />
        </div>
      )}
      <div className="min-w-0">{children}</div>
      {actions ? (
        <div className="col-start-2 flex shrink-0 items-center justify-end gap-2 sm:col-start-auto">{actions}</div>
      ) : null}
    </div>
  );
}

// [契约] 事件名与命令都用 truncate 单行截断，完整命令交给上层详情展示，不要在这里换行展开。
// 这样保证同一分区行高一致，列表不会因某条命令过长而参差。
// trailingBadges 允许为空节点，空时不要包一层空 div，否则会多出 gap 把标题挤偏。
function HookContent({
  event,
  command,
  trailingBadges,
}: {
  event: string;
  command: string;
  trailingBadges?: ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{event}</span>
        {trailingBadges}
      </div>
      <p className="mt-1 truncate font-mono text-ui-sm text-foreground-subtle">{command}</p>
    </>
  );
}

// [契约] 三态叠加：busy（操作中）、readOnly（上游配置只读）、requiresTrust（未信任），任一为真都会改变 Switch 的可交互性。
// 信任按钮与 Switch 是两条独立路径：只读行可以 Trust 但不能 toggle；未信任行必须先 Trust 才能 toggle。
// [失败路径] 所有点击都必须 stopPropagation，否则冒泡到整行编辑手势，用户点一次开关会被同时推进编辑弹层。
// Switch 的 onCheckedChange 只透传值、不做本地乐观更新：状态真相在上层，弹回代表写入失败而不是组件缺陷。
// 不要因为 readOnly 就把整行禁用：那会连带禁掉 Trust，用户失去在 Settings 内完成审核的唯一入口。
function ConfiguredHookRow({
  busy,
  hook,
  onEdit,
  onTrust,
  onToggle,
  readOnly = false,
  requiresTrust,
  trustActionAvailable,
  trusting,
}: {
  busy: boolean;
  hook: Hook;
  onEdit: (hook: Hook) => void;
  onTrust?: (hook: Hook) => Promise<void>;
  onToggle: (hook: Hook, enabled: boolean) => Promise<void>;
  // [契约] 这段既有注释描述 readOnly 的语义，是当前实现的依据，不要改写或删除。
  // 只读判定来自 hook.editable === false，由上层投影给出；本文件不重新推导「是否上游配置」。
  // 信任后 Switch 展示真实 enabled 但仍禁用：启用/禁用必须改源文件，Settings 刻意不提供写入口。
  // 若将来允许在 Settings 内改写上游配置，要先解决多工作区写冲突，而不是简单放开 disabled。
  /** 上游/祖先 zcode.json 的只读工作区 Hook：不可编辑、不可 toggle，但仍可逐条 Trust。 */
  readOnly?: boolean;
  requiresTrust: boolean;
  trustActionAvailable: boolean;
  trusting: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame
      testId="configured-hook-row"
      onEdit={busy || readOnly ? undefined : () => onEdit(hook)}
      actions={
        <>
          {requiresTrust && onTrust ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || trusting || !trustActionAvailable}
              title={trustActionAvailable ? undefined : intl.formatMessage({ id: "settings.hooks.review.unavailable" })}
              onClick={(event) => {
                event.stopPropagation();
                void onTrust(hook);
              }}
            >
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.review.trust" })}
            </Button>
          ) : null}
          {/* workspace-hook-trust：未通过信任审核的工作区 Hook 禁止直接启用，
              Switch 强制关闭并禁用，引导用户先完成 Trust 审核流程。
              只读行（上游 zcode.json）的 Switch 始终禁用：信任后展示真实配置状态，
              但启用/禁用必须去源文件改，Settings 不提供写入口。 */}
          <Switch
            checked={requiresTrust ? false : hook.enabled}
            onCheckedChange={(value) => void onToggle(hook, value)}
            onClick={(event) => event.stopPropagation()}
            disabled={busy || trusting || requiresTrust || readOnly}
          />
        </>
      }
    >
      <HookContent event={hook.event} command={[hook.command, ...(hook.args ?? [])].join(" ")} />
    </HookItemFrame>
  );
}

// [契约] 兼容行只有 Import 一个动作、无状态：点一次把旧配置迁移成新格式，重复点击由 busy 拦截。
// 不要给它加 Switch：旧格式没有启用语义，渲染开关会诱导用户以为可以直接生效。
// Import 的 Promise 用 void 丢弃，失败提示由外层负责，本组件不做 toast 也不吞错。
function CompatibilityHookRow({
  busy,
  hook,
  onImport,
}: {
  busy: boolean;
  hook: Hook;
  onImport: (hook: Hook) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame
      actions={
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void onImport(hook)}>
          <Download className="size-3" />
          {intl.formatMessage({ id: "settings.hooks.import" })}
        </Button>
      }
    >
      <HookContent event={hook.event} command={[hook.command, ...(hook.args ?? [])].join(" ")} />
    </HookItemFrame>
  );
}

function PluginHookItem({ hook }: { hook: PluginHookRow }) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame testId="plugin-hook-row" pluginIconItem={hook.pluginIconItem}>
      <HookContent
        event={hook.detail.event}
        command={[hook.detail.command, ...(hook.detail.args ?? [])].join(" ")}
        trailingBadges={
          !hook.pluginScope ? (
            <Badge variant="secondary" className="bg-surface text-foreground-subtle">
              {intl.formatMessage({ id: "settings.hooks.scopeUnknown" })}
            </Badge>
          ) : null
        }
      />
    </HookItemFrame>
  );
}
