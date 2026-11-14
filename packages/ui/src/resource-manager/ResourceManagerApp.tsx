// INV-01 外壳只做窗口骨架、数据编排与 tab 分发，采样、扫盘、抓包细节全部落在子区或 Host；守住位置：ResourceManagerApp 的返回结构与正文三元分发；改错故障：把扫盘或抓包逻辑内联进外壳，子区无法单测，生命周期也与秒级轮询绑死。
// INV-02 快照只有一个写入点；守住位置：refresh 成功分支里的 setSnapshot 与初始 snapshot 为 null；改错故障：子组件各自拉取或另存副本，进程计数与分组列表出现两份真相。
// INV-03 [并发] 请求必须串行，上一轮未归不叠加；守住位置：refresh 开头对 inFlight 的检查与 finally 里的复位；改错故障：Host 采样变慢时请求堆叠，迟到的旧结果覆盖新结果，指标来回跳。
// INV-04 [失败路径] 卸载后不得再写状态；守住位置：disposed 标志在 await 之后的两处提前返回与清理函数里的置真；改错故障：窗口关闭后仍写快照或错误，渲染进程已销毁，日志刷警告且可能泄漏整棵子树。
// INV-05 [资源] 轮询只在 cpu 与内存两个 tab 运行；守住位置：pollingActive 的取值与 effect 中非激活即返回的分支；改错故障：切到存储 tab 后仍每秒采集进程快照，与扫盘争抢磁盘 IO，扫盘明显变慢。
// INV-06 [资源] 采样开关必须成对且跟随 effect 生命周期；守住位置：effect 建立前的置真与清理函数里的置假；改错故障：只开不关，Host 采样常驻，窗口关闭后 CPU 仍被周期性采样。
// INV-07 [失败路径] 桥缺失要显式报不可用；守住位置：effect 开头 !getSnapshot 分支写入的 resourceManager.unavailable；改错故障：直接静默返回，副标题永远停在加载中，用户以为采样卡死。
// INV-08 [状态] 当前 tab 只由本组件持有；守住位置：tab 的 useState 与头部 Tabs 的 onValueChange；改错故障：子区另存一份选中项，切换标签后正文不跟随，出现两个高亮。
// INV-09 [状态] 折叠表以三个固定分类为键且默认全开；守住位置：expanded 的初始对象字面量；改错故障：新增分类却忘了补键，读到 undefined 后该分组永远处于折叠，列表看起来是空的。
// INV-10 [事务] 折叠必须不可变更新；守住位置：toggleGroup 里基于 current 展开再覆盖目标键的写法；改错故障：原地改对象引用不变，React 跳过重渲染，点击箭头没有任何反应。
// INV-11 [权衡] 分组只做派生不做存储；守住位置：groups 的 useMemo 仅依赖 snapshot；改错故障：把分组结果写进 state 并在 effect 里同步，每轮轮询多一次无谓渲染，还可能出现快照与分组不同步的一帧。
// INV-12 [失败路径] 错误一律落成可渲染字符串；守住位置：catch 里对 Error 实例取 message、其余走 String 的三元；改错故障：把异常对象直接放进状态并渲染，React 抛错整页白屏，连错误横幅都看不到。
// INV-13 [事务] 成功必须清掉旧错误；守住位置：refresh 成功分支里与快照同一轮写入的 setError(null)；改错故障：一次超时后横幅常驻，后续数据恢复正常但用户仍以为服务不可用。
// INV-14 [权衡] 刷新间隔可注入并带默认；守住位置：refreshIntervalMs 的默认值 DEFAULT_REFRESH_INTERVAL_MS 与定时器创建处；改错故障：把间隔写死在 effect 内部，测试只能真实等待，慢机器上还会拖慢用例。
// INV-15 [并发] 轮询依赖必须完整；守住位置：effect 依赖数组里的 getSnapshot、intl、pollingActive、refreshIntervalMs、setSamplingActive；改错故障：漏掉桥或语言，父层换实现后仍用旧闭包，数据源切换不生效。
// INV-16 [边界] 两个子区各自接收自己的桥；守住位置：正文分发里 StorageSection 的 bridge 与 active、NetworkSection 的 bridge；改错故障：外壳代理子区数据或漏传 active，扫盘在隐藏后继续，切回时状态陈旧。
// INV-17 [契约] 无快照时统一用占位常量；守住位置：UsageTabContent 里 cpu 与内存两处对 UNSAMPLED_PLACEHOLDER 的引用；改错故障：外壳另写一套「--」占位，与采样中文案风格不一致，切 tab 时文案跳动。
// INV-18 [失败路径] 内存百分比必须防除零；守住位置：UsageTabContent 中 memoryTotalBytes 大于 0 的两处判断；改错故障：总内存读到 0 时直接相除，得到 NaN 或 Infinity，进度条宽度与文本一起异常。
//
// 模块职责：资源管理器窗口的应用外壳，负责 tab 切换、CPU 与内存快照轮询、错误与空态投影，并把存储、网络两个子区按注入的桥分发出去。
// 状态所有权：tab、snapshot、error 与三分类折叠表由本组件独占；分组是快照的派生；扫盘与抓包状态留在子组件与 Host。
// 阅读顺序：先看 props 契约与常量表，再看主组件的状态与轮询 effect，随后是派生与折叠回调，最后是 cpu 与内存共用正文与错误横幅。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ResourceUsageCategory,
  type ResourceUsageSnapshot,
  type StorageManagementBridge,
  type NetworkCaptureBridge,
} from "@zcode/shared";
import { TID_RESOURCE_MANAGER_TAB, testId } from "@zcode/shared/test-ids";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/index.js";
import { StorageSection } from "./storage/StorageSection.js";
import { NetworkSection } from "./NetworkSection.js";
import { UNSAMPLED_PLACEHOLDER, UsageGroup, UsageMeter } from "./resourceUsageParts.js";
import {
  clampPercent,
  formatBytes,
  formatPercent,
  groupResourceUsage,
  type ResourceUsageGroupView,
} from "./resourceUsageView.js";

// [契约] props 全部可选：桥缺省即代表该能力不可用，本文件不提供任何真实实现。
// [契约] getSnapshot 是唯一数据入口，返回整份快照，外壳既不拼接也不缓存副本。
// [边界] storage 与 network 是两条独立桥，分别对应正文里的存储与网络两个 tab。
// [资源] refreshIntervalMs 允许调用方放慢轮询，桌面默认一秒，测试可传更大值减少真实等待。
// [状态] initialTab 只在首次挂载时生效，之后由内部 tab 状态接管，父层再改不会切换页面。
// [契约] setSamplingActive 只是开关通知，外壳按时开与关，采样实现完全留在 Host 侧。
export interface ResourceManagerAppProps {
  /** 缺省表示桥接不可用（例如非桌面环境） */
  getSnapshot?: () => Promise<ResourceUsageSnapshot>;
  setSamplingActive?: (active: boolean) => void;
  /** 存储管理桥（window.resourceManager.storage）；缺省时「存储」tab 显示接口不可用 */
  storage?: StorageManagementBridge;
  network?: NetworkCaptureBridge;
  refreshIntervalMs?: number;
  /** 初始 tab，默认 CPU */
  initialTab?: ResourceManagerTab;
}

export type ResourceManagerTab = "cpu" | "memory" | "storage" | "network";
// [契约] 四个 tab 的顺序即按钮渲染顺序，增删必须同步标签映射与正文分发两处。
// [契约] ResourceManagerTab 联合类型是唯一定义，props 与内部状态共用同一份枚举。
// [渲染] 头部按钮按该数组映射生成，key 与 value 同取枚举值，不使用索引键。
// [契约] 标签文案只走 i18n id 表，文件内不出现面向用户的中文字面量。
// [边界] 存储与网络只在正文分发中被特判，标签映射本身保持无分支。
const RESOURCE_MANAGER_TABS: ResourceManagerTab[] = ["cpu", "memory", "storage", "network"];
const TAB_LABEL_IDS: Record<ResourceManagerTab, string> = {
  cpu: "resourceManager.cpu",
  memory: "resourceManager.memory",
  storage: "resourceManager.storage",
  network: "resourceManager.network",
};

// [权衡] 默认秒级刷新是采样开销与感知延迟的折中，再快会明显抬高 Host 的 CPU 占用。
// [契约] 三分类标签映射覆盖 ResourceUsageCategory 的全部取值，漏一项会让该分组在格式化时抛错。
// [渲染] 分类英文键只在此处映射一次，分组标题与折叠头共用同一查表结果。
// [资源] 常量与类型同文件声明，不为几个短名字另建模块，减少循环依赖面。
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const CATEGORY_LABEL_IDS: Record<ResourceUsageCategory, string> = {
  base: "resourceManager.category.base",
  "builtin-plugin": "resourceManager.category.builtinPlugin",
  "community-plugin": "resourceManager.category.communityPlugin",
};

/**
 * 资源管理器窗口 UI。
 * 组件放在 packages/ui 内是为了纳入 Tailwind 扫描；desktop 的独立 renderer 入口只负责挂载。
 */
// [契约] 组件是有状态外壳，只接收注入的桥与展示参数，不读任何全局单例。
// [状态] 四样本地状态：当前 tab、最近快照、错误文案、三分类折叠表，均不派生自外部。
// [派生] pollingActive 由 tab 现算，不另存状态，避免同一事实出现两份真相。
// [资源] 快照只服务 cpu 与内存两个 tab，切走后立即停轮询，把 IO 让给存储扫盘。
// [契约] 外壳只做分发：cpu 与内存共用一份正文，存储与网络各自路由到子组件。
// [边界] 桥通过 props 注入，组件不直接触碰 window 上的资源管理器对象。
// [渲染] 根节点撑满视口并锁定纵向布局，头部固定，正文区独立滚动。
// [渲染] 头部无条件渲染，副标题随快照在加载中与进程数之间切换，非采样 tab 不显示副标题。
export function ResourceManagerApp({
  getSnapshot,
  setSamplingActive,
  storage,
  network,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  initialTab = "cpu",
}: ResourceManagerAppProps) {
  const { intl } = useZCodeIntl();
  const [tab, setTab] = useState<ResourceManagerTab>(initialTab);
  // CPU / 内存共用一份进程快照；存储 tab 激活时停止轮询，避免和扫盘争抢 IO。
  const pollingActive = tab === "cpu" || tab === "memory";
  const [snapshot, setSnapshot] = useState<ResourceUsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<ResourceUsageCategory, boolean>>({
    base: true,
    "builtin-plugin": true,
    "community-plugin": true,
  });

  // [事务] effect 先判断桥是否存在，缺失时写错误并直接返回，不建立任何定时器。
  // [资源] 非 cpu 与内存 tab 直接返回，既不置采样开关也不订阅，避免无谓的 Host 负担。
  // [并发] refresh 用 inFlight 做串行闸门，上一轮未归时不叠加新请求。
  // [失败路径] 请求回来先看 disposed，已卸载则丢弃结果，不向失效的渲染进程写状态。
  // [事务] 成功分支先写快照再清错误，顺序反了会短暂出现有数据却仍报错的组合。
  // [失败路径] 异常统一转成字符串进 error，Error 实例取 message，其余值走 String。
  // [资源] 清理函数清掉定时器，并用 disposed 封住所有迟到回调。
  // [资源] 清理函数同时把采样开关置假，renderer 停表不等于 Host 停采样。
  // [权衡] 依赖数组含 intl，语言变化会重建 effect 并重置定时器，换来文案即时更新。
  // [事务] `getSnapshot` 首轮立即执行一次再起定时器，界面不必先空等一个完整间隔。
  useEffect(() => {
    if (!getSnapshot) {
      setError(intl.formatMessage({ id: "resourceManager.unavailable" }));
      return;
    }
    if (!pollingActive) return;
    setSamplingActive?.(true);
    let disposed = false;
    let inFlight = false;

    async function refresh() {
      // 请求串行：上一轮未返回（Host 采样慢）时不叠加新请求。
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await getSnapshot!();
        if (disposed) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), refreshIntervalMs);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      // 停止 renderer 定时器还不够，Host 在途采样也必须随页面生命周期取消。
      setSamplingActive?.(false);
    };
  }, [getSnapshot, intl, pollingActive, refreshIntervalMs, setSamplingActive]);

  // [派生] 分组由快照的进程数组实时计算，快照为空时回落到空数组，首帧不渲染分组。
  // [事务] 折叠回调以函数式更新写回 `groups`，先展开最新表再翻转目标分类。
  // [事务] 翻转只作用于目标键，其余分类的展开状态在合并时原样保留。
  // [权衡] 折叠表按分类存而非按分组实例存，同一分类的所有分组共用一个开合状态。
  // [契约] 回调依赖为空，跨轮询保持同一引用，避免子列表因回调变化整体重渲染。
  // [并发] 折叠是纯本地交互，不触发轮询也不重置快照，切换时数据保持连续。
  const groups = useMemo(() => groupResourceUsage(snapshot?.processes ?? []), [snapshot]);
  const toggleGroup = useCallback((category: ResourceUsageCategory) => {
    setExpanded((current) => ({ ...current, [category]: !current[category] }));
  }, []);

  return (
    <main
      className="flex h-dvh min-h-0 flex-col bg-background text-foreground"
      data-testid="resource-manager"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-header px-4">
        <div className="min-w-0">
          <h1 className="truncate text-ui-base font-medium">
            {intl.formatMessage({ id: "resourceManager.title" })}
          </h1>
          {pollingActive ? (
            <div className="text-ui-xs text-foreground-subtle">
              {snapshot
                ? intl.formatMessage(
                    { id: "resourceManager.processCount" },
                    { count: snapshot.processes.length },
                  )
                : intl.formatMessage({ id: "resourceManager.loading" })}
            </div>
          ) : null}
        </div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as ResourceManagerTab)}>
          <TabsList variant="line" className="h-8 gap-1 p-0">
            {RESOURCE_MANAGER_TABS.map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                data-testid={testId(TID_RESOURCE_MANAGER_TAB, item)}
                className="h-8 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
              >
                {intl.formatMessage({ id: TAB_LABEL_IDS[item] })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-background-alt p-4">
        {tab === "storage" ? (
          <StorageSection bridge={storage} active={tab === "storage"} />
        ) : tab === "network" ? (
          <NetworkSection bridge={network} />
        ) : (
          <UsageTabContent
            metric={tab}
            snapshot={snapshot}
            error={error}
            groups={groups}
            expanded={expanded}
            onToggleGroup={toggleGroup}
          />
        )}
      </div>
    </main>
  );
}

/** CPU / 内存 tab 的正文：左侧对应指标卡，右侧分组列表只显示当前指标列。 */
// [契约] 正文组件是 cpu 与内存的共用渲染层，metric 决定指标卡内容与列表列。
// [渲染] 错误横幅只在 error 非空时挂载，位于网格之上，不遮挡下方指标卡。
// [失败路径] 错误与空快照可以同时存在，横幅与占位文案各自独立，互不吞并。
// [契约] 指标卡按 metric 分别取百分比或字节，分组列表透传同一 metric 以保持列口径一致。
// [渲染] 折叠状态与切换回调均由外壳传入，正文组件不持有任何可写状态。
function UsageTabContent({
  metric,
  snapshot,
  error,
  groups,
  expanded,
  onToggleGroup,
}: {
  metric: "cpu" | "memory";
  snapshot: ResourceUsageSnapshot | null;
  error: string | null;
  groups: ResourceUsageGroupView[];
  expanded: Record<ResourceUsageCategory, boolean>;
  onToggleGroup: (category: ResourceUsageCategory) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      {error ? (
        <div
          className="rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive"
          data-testid="resource-manager-error"
        >
          {error}
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-4">
          {metric === "cpu" ? (
            <UsageMeter
              testId="resource-manager-cpu"
              label={intl.formatMessage({ id: "resourceManager.cpu" })}
              appValue={snapshot ? formatPercent(snapshot.app.cpuPercent) : UNSAMPLED_PLACEHOLDER}
              systemValue={
                snapshot ? formatPercent(snapshot.system.cpuPercent) : UNSAMPLED_PLACEHOLDER
              }
              appPercent={snapshot ? clampPercent(snapshot.app.cpuPercent) : 0}
              systemPercent={snapshot ? clampPercent(snapshot.system.cpuPercent) : 0}
              appLabel={intl.formatMessage({ id: "resourceManager.appUsage" })}
              systemLabel={intl.formatMessage({ id: "resourceManager.systemUsage" })}
            />
          ) : (
            <UsageMeter
              testId="resource-manager-memory"
              label={intl.formatMessage({ id: "resourceManager.memory" })}
              appValue={snapshot ? formatBytes(snapshot.app.memoryBytes) : UNSAMPLED_PLACEHOLDER}
              systemValue={
                snapshot
                  ? `${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`
                  : UNSAMPLED_PLACEHOLDER
              }
              appPercent={
                snapshot && snapshot.system.memoryTotalBytes > 0
                  ? clampPercent(
                      (snapshot.app.memoryBytes / snapshot.system.memoryTotalBytes) * 100,
                    )
                  : 0
              }
              systemPercent={
                snapshot && snapshot.system.memoryTotalBytes > 0
                  ? clampPercent(
                      (snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes) * 100,
                    )
                  : 0
              }
              appLabel={intl.formatMessage({ id: "resourceManager.appUsage" })}
              systemLabel={intl.formatMessage({ id: "resourceManager.systemUsage" })}
            />
          )}
        </aside>

        <section className="flex min-w-0 flex-col gap-3">
          {groups.map((group) => (
            <UsageGroup
              key={group.category}
              group={group}
              metric={metric}
              title={intl.formatMessage({ id: CATEGORY_LABEL_IDS[group.category] })}
              expanded={expanded[group.category]}
              onToggle={() => onToggleGroup(group.category)}
              emptyText={intl.formatMessage({ id: "resourceManager.empty" })}
              samplingText={intl.formatMessage({ id: "resourceManager.sampling" })}
              columns={{
                process: intl.formatMessage({ id: "resourceManager.column.process" }),
                pid: intl.formatMessage({ id: "resourceManager.column.pid" }),
                cpu: intl.formatMessage({ id: "resourceManager.cpu" }),
                memory: intl.formatMessage({ id: "resourceManager.memory" }),
              }}
            />
          ))}
        </section>
      </div>
    </>
  );
}
