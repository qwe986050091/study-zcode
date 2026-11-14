/* eslint-disable max-lines -- 商店详情页把 hero/示例提示词/组件分区/信息区/高级折叠组织为一个连贯页面，与截图 1:1 对齐。 */
// 插件商店详情页：把 listing、运行时 info 与按需 describe 结果投影成一屏可读的详情视图。
// 做：展示名/描述/hero/示例提示词/组件分区/信息行/高级折叠的纯渲染与交互转发。
// 不做：安装、卸载、更新、启停、describe 拉取——一律经 actions / onRetryDescribe 上抛。
// 依赖：pluginStoreListing（展示名/描述/分类/信任判定）、pluginManagedResourceGroups（分组）、
//       PluginStoreCard（按钮族）、ZCodeIntl（文案）、useOptionalPlatform（外链）。
// 边界：本组件不持有安装态、不订阅 store、不构造第二份服务；item/describeEntry 是父级只读快照。
//
// INV-01 断言：组件分区顺序必须等于 SECTION_ORDER（mcp→skill→command→agent→hook） —— 守住它的位置：SECTION_ORDER 与 orderedGroups —— 改错故障：分区顺序与资源设置页、设计稿错位，E2E 快照同时失效。
// INV-02 断言：已安装项的组件数据必须优先取 item.info，不得先看 describeEntry —— 守住它的位置：componentGroups 三元表达式 —— 改错故障：已安装插件显示 describe 的陈旧或空清单。
// INV-03 断言：componentsLoading 只有在没有 item.info 时才可为真 —— 守住它的位置：componentsLoading 定义 —— 改错故障：已安装插件闪加载骨架，已知组件被遮住。
// INV-04 断言：componentsFailed 与 componentsLoading 必须互斥，error 优先 —— 守住它的位置：两个布尔与渲染分支 —— 改错故障：失败态被 loading 覆盖，重试按钮消失。
// INV-05 断言：信息区取值优先级固定为 listing → item.info → describeMetadata —— 守住它的位置：developer/version/linkRows —— 改错故障：商店权威文案被本地旧 manifest 覆盖。
// INV-06 断言：外链只放行 https:// 前缀 —— 守住它的位置：pickHttpsUrl —— 改错故障：javascript:/data: 进入 openExternal，形成注入面。
// INV-07 断言：pickHttpsUrl 必须「首个合格即返回」而不是返回最后一个 —— 守住它的位置：return candidates.find —— 改错故障：低优先级回退值覆盖商店权威链接。
// INV-08 断言：示例提示词图标判定顺序必须是 pdf → spreadsheets → documents —— 守住它的位置：resolveExamplePromptDocumentIcon —— 改错故障：含 excel 的 PDF 导出提示词显示表格图标。
// INV-09 断言：图标正则必须保留词边界，不得退化成 includes —— 守住它的位置：两个 /\b/u 正则 —— 改错故障：pdfx、mycsv 之类子串被误判。
// INV-10 断言：Hero 只在「有可信图 URL」或「有示例提示词」时渲染 —— 守住它的位置：HeroSection 调用点条件 —— 改错故障：空 Hero 把页面撑出空白横幅。
// INV-11 断言：showHeroImage 必须同时要求 isTrustedImageUrl 与 !heroFailed —— 守住它的位置：showHeroImage 定义 —— 改错故障：破图持续占位并触发重复 onError。
// INV-12 断言：图片加载失败只允许置 heroFailed，不得改 item 或上抛 —— 守住它的位置：img onError —— 改错故障：一张图 404 让整页报错。
// INV-13 断言：无图但有提示词时必须退化为纯胶囊列表且不渲染 overlay —— 守住它的位置：HeroSection 内部条件 —— 改错故障：无图时叠黑色蒙层，胶囊对比度崩。
// INV-14 断言：预览 Dialog 的 open 必须与 showHeroImage 相与 —— 守住它的位置：Dialog open 属性 —— 改错故障：图失效后仍可打开空预览。
// INV-15 断言：示例提示词的 key 必须用 prompt 文本本身 —— 守住它的位置：prompts.map 的 key —— 改错故障：重复 prompt 触发 key 冲突，点击串到别的提示词。
// INV-16 断言：点击试用必须走父级 onUsePrompt，不得在本地拼 mention —— 守住它的位置：onClick —— 改错故障：canonical 构造分叉，预填内容与顶部按钮不一致。
// INV-17 断言：UI 插件优先渲染 onOpenUi，非 UI 插件才回落立即试用 —— 守住它的位置：isUiPluginItem 分支 —— 改错故障：UI 插件被当普通插件试用，或打开不存在的界面。
// INV-18 断言：信息区必须整块省略，不得渲染空行或空标题 —— 守住它的位置：rows/linkRows 双空早退 —— 改错故障：出现空 section 与空 dt/dd。
// INV-19 断言：分区图标必须复用 SECTION_ICONS 同一映射 —— 守住它的位置：SECTION_ICONS 与 ComponentSection —— 改错故障：详情页与资源设置页图标语义不一致。
// INV-20 断言：高级折叠内容只能由父级注入，本文件不得自取 rootPath/Hook 明细 —— 守住它的位置：PluginStoreAdvancedSection —— 改错故障：详情页越权读运行时，出现双份数据源。
//
// 阅读顺序：先看 INV 清单，再看各渲染块的 [契约]/[权衡] 标注，最后才是布局细节。
// 约束：新增注释必须保持整行 // 形式；调整顺序前先确认不破坏上面任何一条 INV。
import { useState, type ReactNode } from "react";
import {
  Anchor,
  ArrowRight,
  Bot,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Server,
  Terminal,
  TriangleAlert,
  WandSparkles,
  Maximize2,
  RotateCcw,
} from "lucide-react";
import type { ZCodePluginComponentKind, ZCodePluginsDescribeResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/index.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import { ThemeHeroVisual } from "@/openWorkspacePageThemeHero.js";
import documentsIconUrl from "@/assets/document-skill-icons/documents@2x.png";
import pdfIconUrl from "@/assets/document-skill-icons/pdf@2x.png";
import spreadsheetsIconUrl from "@/assets/document-skill-icons/spreadsheets@2x.png";
import {
  PluginStoreInstallButton,
  PluginStoreItemMenu,
  PluginStorePaidPlanBadge,
  PluginStoreOpenUiButton,
  PluginStoreUpdateButton,
  type PluginStoreActions,
} from "@/settings/PluginStoreCard.js";
import {
  isItemBusy,
  isTrustedImageUrl,
  isUiPluginItem,
  KNOWN_CATEGORY_LABEL_IDS,
  resolveItemDescription,
  resolveStoreCategory,
  resolveItemDisplayName,
  resolveLocalizedList,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import {
  buildInstalledPluginDisplayGroups,
  describeResultToDisplayGroups,
} from "@/settings/pluginManagedResourceGroups.js";
import type { PluginComponentDisplayGroup } from "@/settings/PluginComponentGroups.js";
import type { PluginDescribeEntry } from "@/store/pluginManagementStore.js";

// 组件分区顺序与截图一致：MCP 服务器 → 技能 → 命令 → 子智能体 → Hooks。
// [契约] 该数组是分区顺序的唯一真相，必须与设计稿及资源设置页一致。
// [权衡] 用显式字面量而不是读枚举 key 顺序：TS 枚举顺序不是契约。
// [失败路径] 调整顺序会同时改变 Hero 下方的阅读路径与 E2E 快照。
// [边界] 增删 kind 前先确认 shared 中的联合类型已同步。
// [资源] 模块级常量只读，禁止在渲染期排序或 splice。
const SECTION_ORDER: ZCodePluginComponentKind[] = ["mcp", "skill", "command", "agent", "hook"];

// [契约] 每 kind 必须有且只有一条 i18n id，缺 key 会在 Record 上直接报错。
// [权衡] 不在此处调用 formatMessage：常量表保持纯数据，便于对照设计稿。
// [失败路径] id 拼错不会编译失败，只在运行时显示原始 key。
// [边界] 标题文案不参与排序，顺序由 SECTION_ORDER 决定。
const SECTION_TITLE_IDS: Record<ZCodePluginComponentKind, string> = {
  mcp: "settings.plugins.store.section.mcp",
  skill: "settings.plugins.store.section.skills",
  command: "settings.plugins.store.section.commands",
  agent: "settings.plugins.store.section.agents",
  hook: "settings.plugins.store.section.hooks",
};

// 与各资源设置列表共用同一图标语义，避免详情页用近似图标造成识别不一致。
const SECTION_ICONS: Record<ZCodePluginComponentKind, typeof Server> = {
  mcp: Server,
  skill: WandSparkles,
  command: Terminal,
  agent: Bot,
  // [契约] 图标映射必须覆盖完整联合类型，缺项会让索引结果变成 undefined。
  // [失败路径] 新增 kind 只改 SECTION_ORDER 不改这里，渲染期抛「Icon 不是组件」。
  // [权衡] 复用 lucide 同语义图标，不引入自绘图标，避免两套视觉语言。
  hook: Anchor,
};

type ExamplePromptDocumentIcon = "documents" | "pdf" | "spreadsheets";

const EXAMPLE_PROMPT_DOCUMENT_ICON_URLS: Record<ExamplePromptDocumentIcon, string> = {
  // [契约] 三种文档图标必须覆盖 ExamplePromptDocumentIcon 的完整联合类型。
  // [资源] 图片走打包器静态 import，保证产物 hash 与按需加载。
  // [失败路径] 改成运行时拼字符串路径会在打包后 404，且类型层不报错。
  // [边界] 这里只做映射，不校验图片是否可解码。
  documents: documentsIconUrl,
  pdf: pdfIconUrl,
  spreadsheets: spreadsheetsIconUrl,
};

// [契约] 导出给详情页内部与测试共用：输入是原始提示词文本，输出只有三种文档图标。
// [权衡] 不读 locale、不读 item，纯函数才能让卡片与详情页共享同一判定。
// [失败路径] 无匹配一律回落 documents，调用方无需处理 undefined。
// [边界] 这里只决定图标，不校验提示词是否真的可执行。
export function resolveExamplePromptDocumentIcon(prompt: string): ExamplePromptDocumentIcon {
  // [契约] pdf 判定必须排在 spreadsheets 之前：同时出现 pdf 与 xlsx 时按 PDF 文档呈现。
  // [权衡] u 标志让 \b 按 Unicode 词边界切分，中文紧邻 pdf 时仍能命中。
  // [失败路径] 顺序颠倒后，含 pdf 的 excel 导出提示词会显示表格图标。
  // [边界] 正则只做首命中判定，不做全量扫描。
  if (/\bpdf\b/iu.test(prompt)) {
    return "pdf";
  }
  // [契约] 表格判定同时接受 csv/xlsx/excel 三个词，与商店分类文案保持一致。
  // [权衡] 不扩写 openxml 等别名：图标是展示辅助，多认词会稀释 pdf 优先级。
  // [失败路径] 移除任一别名都会让对应提示词回落 documents，视觉回归失败。
  if (/\b(?:csv|xlsx|excel)\b/iu.test(prompt)) {
    return "spreadsheets";
  }
  return "documents";
}

export function PluginStoreDetailView({
  item,
  actions,
  describeEntry,
  onRetryDescribe,
  onUsePrompt,
  advanced,
}: {
  item: StorePluginItem;
  actions: PluginStoreActions;
  describeEntry?: PluginDescribeEntry;
  onRetryDescribe: () => void;
  /** 试用：标准新建任务并预填 canonical Plugin 引用 + 示例提示词（不自动发送）；未安装时先引导安装。 */
  onUsePrompt: (item: StorePluginItem, prompt: string) => void;
  /** 高级折叠区（rootPath/Hook 明细/配置项），仅已安装且有运行时信息时由父级注入。 */
  advanced?: ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const displayName = resolveItemDisplayName(item, locale);
  const description = resolveItemDescription(item, locale);
  const heroImage = item.listing?.heroImage;
  // [契约] 示例提示词只能来自 listing 的 i18n 覆盖 + 基础列表 + resolveLocalizedList 兜底。
  // [权衡] 兜底成空数组而不是 undefined，后续 length 判定与 map 无需再判空。
  // [失败路径] 直接透传 undefined，Hero 条件里的 examplePrompts.length 会抛 TypeError。
  // [边界] 不在这里过滤空串或去重：数据侧负责，展示侧保持原序。
  // [资源] 该数组每轮渲染重建、不缓存，避免 locale 切换后拿到旧文案。
  const examplePrompts =
    resolveLocalizedList(locale, item.listing?.examplePrompts, item.listing?.examplePromptsI18n) ??
    [];
  // [契约] describeMetadata 只在 status === "loaded" 时存在，其余状态一律 undefined。
  // [并发] describe 是异步按需拉取，这里只读当前 describeEntry 快照，不另开缓存。
  // [失败路径] 把 loading 的 data 也读出来，会在重试瞬间把上一次结果混进当前视图。
  // [权衡] 不向下传 status：子组件只关心「有没有 metadata」。
  // [边界] 该值只用于信息区回退，不参与组件分区决策。
  const describeMetadata =
    describeEntry?.status === "loaded" ? describeEntry.data?.metadata : undefined;

  // [契约] 组件数据源优先级固定：已安装 info → describe 成功结果 → 空数组。
  // [并发] 两者可能同时存在，必须以 item.info 为准，describe 只能作为候选态回退。
  // [失败路径] 顺序写反会让已安装插件展示 describe 的旧快照，组件增删不可见。
  // [权衡] describeEntry.data 已 loaded 才用，避免半成品 data 混入分区。
  // [边界] 不在这里做 kind 过滤，顺序与去重交给 orderedGroups。
  const componentGroups: PluginComponentDisplayGroup[] = item.info
    ? buildInstalledPluginDisplayGroups(item.info)
    : describeEntry?.status === "loaded" && describeEntry.data
      ? describeResultToDisplayGroups(describeEntry.data)
      : [];
  // [契约] 渲染顺序只由 SECTION_ORDER 决定，与数据源返回顺序无关。
  // [契约] find 未命中的 kind 必须被 filter 掉，不允许渲染空分区。
  // [权衡] 用 map+find 而非数据侧排序：路由表是唯一的顺序真相。
  // [失败路径] 改成直接 map componentGroups，分区顺序随数据源抖动，截图对比失败。
  // [边界] 该过滤只处理 undefined，不改变 group 内部 items 顺序。
  const orderedGroups = SECTION_ORDER.map((kind) =>
    componentGroups.find((group) => group.kind === kind),
  ).filter((group): group is PluginComponentDisplayGroup => group !== undefined);
  // [契约] 仅在「没有 item.info」且 describe 处于 loading 或未开始时才算加载中。
  // [契约] describeEntry 缺省按 loading 处理，保持首帧骨架而不是瞬间空态。
  // [失败路径] 去掉 !item.info，已安装插件会在 describe 未返回时闪骨架。
  // [并发] 与 componentsFailed 共享同一前提，两者不可同时为真。
  // [边界] 加载态只影响组件区，不阻塞信息区与 Hero。
  const componentsLoading = !item.info && (describeEntry?.status ?? "loading") === "loading";
  // [契约] 失败态只在「没有 item.info」且 describe status === "error" 时成立。
  // [失败路径] 忽略 !item.info 会把失败态盖在权威数据之上。
  // [权衡] 不细分 error 原因：对用户而言文案与重试按钮是同一个动作。
  // [边界] 失败不自动重试，必须由 onRetryDescribe 显式触发。
  const componentsFailed = !item.info && describeEntry?.status === "error";

  return (
    <div className="space-y-8" data-testid="plugin-store-detail" data-plugin-id={item.id}>
      {/* 头部：大图标后，显示名与菜单/主按钮同排；简介和来源提示另起一行。 */}
      <div className="space-y-3">
        <PluginStoreAvatar item={item} className="size-16 rounded-2xl" iconClassName="size-6" />
        <div
          className="flex min-w-0 items-center justify-between gap-3"
          data-testid="plugin-store-title-actions"
        >
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 truncate text-ui-xl font-semibold tracking-tight text-foreground">
              {displayName}
            </h1>
            <PluginStorePaidPlanBadge item={item} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <PluginStoreUpdateButton item={item} actions={actions} />
            {item.installed ? (
              <>
                <PluginStoreItemMenu
                  item={item}
                  actions={actions}
                  triggerVariant="outline"
                  triggerSize="icon-lg"
                />
                {/* 顶部试用与示例提示词共用同一 canonical 构造；空 prompt 表示只预填 Plugin mention。 */}
                {/* 只有会话右侧市场提供 onOpenUi；主导航详情保留普通插件的「立即试用」。 */}
                {isUiPluginItem(item) && actions.onOpenUi ? (
                  <PluginStoreOpenUiButton item={item} actions={actions} />
                ) : (
                  <Button
                    type="button"
                    variant="default"
                    size="lg"
                    data-testid="plugin-store-try-now"
                    data-plugin-id={item.id}
                    onClick={() => onUsePrompt(item, "")}
                  >
                    <MessagesSquare className="size-3.5" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.plugins.store.tryNow" })}
                  </Button>
                )}
              </>
            ) : (
              <>
                <PluginStoreInstallButton item={item} actions={actions} size="lg" />
              </>
            )}
          </div>
        </div>
        {description ? (
          <p data-testid="plugin-store-description" className="text-ui-base text-foreground-subtle">
            {description}
          </p>
        ) : null}
        {item.orphaned ? (
          <p
            data-testid="plugin-store-source-degraded"
            data-plugin-id={item.id}
            className="flex items-center gap-1.5 text-ui-base text-warning"
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.store.sourceMissing" })}
          </p>
        ) : null}
      </div>

      {/* Hero 区：横幅图上垂直堆叠示例提示词胶囊；无图但有提示词 → 纯胶囊列表；两者皆无 → 不渲染。 */}
      {isTrustedImageUrl(heroImage) || examplePrompts.length > 0 ? (
        <HeroSection
          item={item}
          displayName={displayName}
          examplePrompts={examplePrompts}
          heroImage={heroImage}
          onUsePrompt={onUsePrompt}
        />
      ) : null}

      {/* 组件分区：已安装走权威枚举（ZCodePluginInfo.components），候选走 plugins/describe 按需拉取。 */}
      {componentsLoading ? (
        <div
          className="flex items-center gap-2 py-2 text-ui-base text-foreground-subtle"
          data-testid="plugin-store-components-loading"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          <span>
            {intl.formatMessage({ id: "settings.plugins.marketplace.componentsLoading" })}
          </span>
        </div>
      ) : componentsFailed ? (
        <div
          className="flex items-center justify-between gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-ui-base text-foreground-subtle"
          data-testid="plugin-store-components-error"
        >
          <span>{intl.formatMessage({ id: "settings.plugins.marketplace.componentsError" })}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="plugin-store-components-retry"
            onClick={onRetryDescribe}
          >
            <RefreshCw className="size-3" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.plugins.marketplace.componentsRetry" })}
          </Button>
        </div>
      ) : (
        orderedGroups.map((group) => <ComponentSection key={group.kind} group={group} />)
      )}

      {/* 信息区：listing 优先，manifest（运行时/describe）回退；无值整行省略（ADR-0001）。 */}
      <InfoSection item={item} describeMetadata={describeMetadata} />

      {isUiPluginItem(item) ? (
        <section data-testid="plugin-store-ui-capability" className="space-y-2">
          <h2 className="text-ui-lg font-semibold">
            {intl.formatMessage({ id: "settings.plugins.store.ui.capability" })}
          </h2>
          {item.info?.uiSurfaces?.map((surface) => (
            <p key={surface.id} className="text-ui-base text-foreground-subtle">
              {resolvePluginUiSurfaceTitle(surface.title, locale)}
            </p>
          ))}
        </section>
      ) : null}
      {actions.onResetConfig ? (
        <Button
          variant="outline"
          data-testid="plugin-store-reset-config"
          disabled={isItemBusy(item, actions)}
          onClick={() => actions.onResetConfig?.(item.id)}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.plugins.scope.restoreUserDefault" })}
        </Button>
      ) : null}

      {advanced}
    </div>
  );
}

function HeroSection({
  item,
  displayName,
  examplePrompts,
  heroImage,
  onUsePrompt,
}: {
  item: StorePluginItem;
  displayName: string;
  examplePrompts: string[];
  heroImage: string | undefined;
  onUsePrompt: (item: StorePluginItem, prompt: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // [契约] heroFailed 是组件本地态，只表示当前 heroImage 加载失败。
  // [权衡] 不做失败重试计数：一次失败即退化，避免弱网下反复打图。
  // [并发] 与 previewOpen 分离：图片失败不应自动关闭已打开的预览。
  // [失败路径] 若把失败写进 item，会污染父级商店列表的共享数据。
  // [边界] 组件卸载即丢弃，不需要持久化。
  const [heroFailed, setHeroFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // [契约] 渲染 hero 必须同时满足「URL 可信」与「未失败」，缺一不可。
  // [契约] isTrustedImageUrl 是唯一信任判定，不允许在此另写前缀白名单。
  // [失败路径] 漏掉 !heroFailed 会让 404 图持续占位并重复 onError。
  // [失败路径] 漏掉 isTrustedImageUrl 会让任意协议进入 img src。
  // [边界] 该布尔同时控制 img、蒙层与预览入口，三者不能各自判断。
  const showHeroImage = isTrustedImageUrl(heroImage) && !heroFailed;
  // [契约] 每个提示词对应一个按钮，key 与展示文本都用 prompt 原文。
  // [权衡] 在 map 内解析图标而不预先建索引：提示词量级是个位数。
  // [失败路径] key 用 index 会在列表变化时把点击事件串到相邻提示词。
  // [边界] 胶囊样式固定深色半透明，不随是否有底图切换。
  // [资源] 按钮内图片走静态导入 `EXAMPLE_PROMPT_DOCUMENT_ICON_URLS`，不产生额外网络请求。
  const prompts = examplePrompts.map((prompt) => {
    const documentIcon = resolveExamplePromptDocumentIcon(prompt);
    return (
      <button
        key={prompt}
        type="button"
        data-testid="plugin-store-example-prompt"
        data-plugin-id={item.id}
        // 彩色 Hero 上统一使用参考图的深色半透明胶囊，不随底图有无切换为普通卡片。
        className="group/prompt flex w-fit max-w-2xl items-center gap-2.5 rounded-3xl bg-black/75 px-3.5 py-2.5 text-left text-ui-base text-white shadow-lg backdrop-blur-md transition-colors hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        onClick={() => onUsePrompt(item, prompt)}
      >
        <img
          src={EXAMPLE_PROMPT_DOCUMENT_ICON_URLS[documentIcon]}
          alt=""
          aria-hidden="true"
          className="size-7 shrink-0 object-contain"
        />
        <span className="shrink-0 font-medium text-white/70">{displayName}</span>
        <span className="min-w-0 whitespace-normal">{prompt}</span>
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15 transition-colors group-hover/prompt:bg-white/25"
        >
          <ArrowRight className="size-4" />
        </span>
      </button>
    );
  });

  // [失败路径] 这是 Hero 的唯一早退点：既无图又无提示词时必须返回 null。
  // [契约] 判定只依赖 showHeroImage 与 prompts 长度，不看 item 是否存在。
  // [权衡] 早退放在 prompts 构造之后，复用同一份提示词判定。
  // [边界] 早退与外层调用点的条件必须同时成立才会渲染。
  if (!showHeroImage && prompts.length === 0) return null;

  return (
    <Dialog open={previewOpen && showHeroImage} onOpenChange={setPreviewOpen}>
      <div
        className="relative min-h-72 overflow-hidden rounded-xl sm:aspect-[3/1] sm:min-h-0"
        data-testid="plugin-store-hero"
      >
        <ThemeHeroVisual className="pointer-events-none absolute inset-0" />
        {showHeroImage ? (
          <img
            src={heroImage}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="absolute inset-0 size-full select-none object-cover opacity-80"
            onError={() => setHeroFailed(true)}
          />
        ) : null}
        <div
          className="absolute inset-0 bg-black/15"
          data-testid="plugin-store-hero-overlay"
          aria-hidden="true"
        />
        {prompts.length > 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-5 sm:p-8">
            {prompts}
          </div>
        ) : null}
        {showHeroImage ? (
          <DialogTrigger asChild>
            <Button
              variant="secondary"
              className="absolute right-3 top-3"
              size="icon-md"
              data-testid="plugin-store-preview-open"
              aria-label={intl.formatMessage({ id: "settings.plugins.store.ui.preview" })}
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </Button>
          </DialogTrigger>
        ) : null}
      </div>
      <DialogContent className="max-w-5xl" aria-describedby={undefined}>
        <DialogTitle>{displayName}</DialogTitle>
        <img src={heroImage} alt={displayName} className="max-h-[80vh] w-full object-contain" />
      </DialogContent>
    </Dialog>
  );
}

function ComponentSection({ group }: { group: PluginComponentDisplayGroup }) {
  const { intl } = useZCodeIntl();
  // [契约] 分区图标必须从 SECTION_ICONS 取，不能在分区内另写映射。
  // [失败路径] 换成条件表达式会让新增 kind 静默回落到默认图标。
  // [权衡] 先取出组件再渲染，避免在 JSX 属性里做索引产生新引用。
  // [边界] 该值只用于列表项前置图标。
  const Icon = SECTION_ICONS[group.kind];
  return (
    <section data-testid="plugin-store-component-section" data-component-kind={group.kind}>
      <div className="flex items-baseline gap-2 border-b border-border pb-2">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: SECTION_TITLE_IDS[group.kind] })}
        </h2>
        <span className="text-ui-base text-foreground-subtle">{group.count}</span>
      </div>
      <ul className="mt-1 divide-y divide-border/60">
        {group.items.map((componentItem) => (
          <li key={componentItem.name} className="flex min-w-0 items-center gap-3 py-2.5">
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle"
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-ui-base font-medium text-foreground">
                {componentItem.name}
              </div>
              {componentItem.description ? (
                <div className="mt-0.5 line-clamp-1 text-ui-base text-foreground-subtle">
                  {componentItem.description}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InfoSection({
  item,
  describeMetadata,
}: {
  item: StorePluginItem;
  describeMetadata: ZCodePluginsDescribeResult["metadata"];
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const listing = item.listing;
  // [契约] 开发者字段回退链固定为 listing → 运行时 info → describe 元数据。
  // [失败路径] 调换前两级会让本地 manifest 覆盖商店权威署名。
  // [权衡] `PluginStoreDetailView` 用 `??` 而非 `||`：空串是否有值交给下游判定。
  // [边界] 三处都缺时得到 undefined，信息区整行省略。
  // [并发] 三个来源可能不同步到达，这里只读当前渲染快照。
  const developer = listing?.author ?? item.info?.author ?? describeMetadata?.author;
  const category = resolveStoreCategory(listing?.category);
  const categoryLabelId = category ? KNOWN_CATEGORY_LABEL_IDS[category] : undefined;
  // [契约] 分类标签优先取 i18n 文案，未知分类回落到原始分类字符串。
  // [失败路径] 只认 KNOWN_CATEGORY_LABEL_IDS 会让新分类整行消失。
  // [权衡] 不做分类别名归一：归一属于 listing 侧，展示侧保持透传。
  // [边界] category 为空时该行不进入 rows。
  const categoryLabel = category
    ? categoryLabelId
      ? intl.formatMessage({ id: categoryLabelId })
      : category
    : undefined;
  // [契约] 版本回退链固定为 info → installedMeta → summary → describe。
  // [失败路径] 把 describe 提前会让候选插件显示远端最新版，与本地已安装版混淆。
  // [权衡] 四级回退都是真实数据来源，删任何一级都会出现空版本。
  // [边界] 版本只做展示，不参与升级判断。
  // [资源] 该值来自已加载快照，不触发额外请求。
  const version =
    item.info?.version ??
    item.installedMeta?.version ??
    item.summary?.version ??
    describeMetadata?.version;
  // [契约] 官网按 listing → info → describe 顺序取首个 https 值。
  // [契约] 隐私政策与条款只认 listing：这两项是商店侧法务信息。
  // [失败路径] 给 privacyPolicy 加 info 回退会把作者自填链接当法务链接。
  // [权衡] 三个调用分开写，避免合并成配置对象后丢失来源语义。
  // [边界] 非 https 一律视为无值，信息区不渲染该行。
  const website = pickHttpsUrl(listing?.homepage, item.info?.homepage, describeMetadata?.homepage);
  const privacyPolicy = pickHttpsUrl(listing?.privacyPolicy);
  const termsOfService = pickHttpsUrl(listing?.termsOfService);

  // [契约] 文本行与链接行必须分成两个数组：渲染结构与交互不同。
  // [失败路径] 合并成一个数组会让链接行退化成纯文本，外链按钮消失。
  // [权衡] 用 push 顺序构造而不记忆化：依赖都是已解析标量。
  // [边界] 两个数组都为空时整块返回 null，不渲染空标题。
  // [资源] 每次渲染重建数组，长度是个位数，不构成热点。
  const rows: Array<{ key: string; label: string; value: ReactNode }> = [];
  if (developer) {
    rows.push({
      key: "developer",
      label: intl.formatMessage({ id: "settings.plugins.store.info.developer" }),
      value: developer,
    });
  }
  // [契约] 分类行只在能解析出展示文本时 push，且 key 固定为 category。
  // [失败路径] key 用 label 文案会让 locale 切换后行身份变化。
  // [权衡] 行顺序固定为开发者 → 分类 → 版本，与设计稿一致。
  // [边界] 该顺序不随数据缺失重排。
  if (categoryLabel) {
    rows.push({
      key: "category",
      label: intl.formatMessage({ id: "settings.plugins.store.info.category" }),
      value: categoryLabel,
    });
  }
  if (version) {
    rows.push({
      key: "version",
      label: intl.formatMessage({ id: "settings.plugins.store.info.version" }),
      value: version,
    });
  }
  const linkRows: Array<{ key: string; label: string; url: string }> = [];
  // [契约] 链接行顺序固定为官网 → 隐私政策 → 服务条款。
  // [失败路径] 打乱顺序会让 E2E 的行索引断言失效。
  // [边界] 每行独立判定，缺一项只跳过该项。
  if (website) {
    linkRows.push({
      key: "website",
      label: intl.formatMessage({ id: "settings.plugins.store.info.website" }),
      url: website,
    });
  }
  if (privacyPolicy) {
    linkRows.push({
      key: "privacyPolicy",
      label: intl.formatMessage({ id: "settings.plugins.store.info.privacyPolicy" }),
      url: privacyPolicy,
    });
  }
  if (termsOfService) {
    linkRows.push({
      key: "termsOfService",
      label: intl.formatMessage({ id: "settings.plugins.store.info.termsOfService" }),
      url: termsOfService,
    });
  }
  // [契约] 双空才省略整块；任一非空都要渲染标题与 dl 骨架。
  // [失败路径] 写成 || 会让只有链接的插件丢掉整块信息区。
  // [权衡] 早退必须在 return JSX 之前，不能靠 CSS 隐藏空 section。
  // [边界] 该判定不看 describeEntry 状态，只看最终解析结果。
  if (rows.length === 0 && linkRows.length === 0) return null;

  return (
    <section>
      <div className="border-b border-border pb-2">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.plugins.store.info.title" })}
        </h2>
      </div>
      <dl className="mt-3 space-y-2.5">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3">
            <dt className="text-ui-base text-foreground-subtle">{row.label}</dt>
            <dd className="min-w-0 truncate text-ui-base text-foreground">{row.value}</dd>
          </div>
        ))}
        {linkRows.map((row) => (
          <div key={row.key} className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-3">
            <dt className="text-ui-base text-foreground-subtle">{row.label}</dt>
            <dd className="min-w-0">
              <button
                type="button"
                title={row.url}
                aria-label={`${row.label}: ${row.url}`}
                className="inline-flex items-center gap-1 rounded-md text-ui-base text-foreground transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                onClick={() => platform?.openExternal(row.url)}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** 外链只放行 https（信息区渲染层统一收口，schema 不做校验）。 */
function pickHttpsUrl(...candidates: Array<string | undefined>): string | undefined {
  // [契约] 返回第一个以 https:// 开头的候选，顺序即优先级。
  // [契约] 类型谓词只放行 string，过滤 undefined 与非法协议。
  // [失败路径] 改成 filter(...)[0] 语义等价但多分配；改成 findLast 会反转优先级。
  // [权衡] 不做 URL 规范化：规范化属于数据侧职责，展示侧只信任原值。
  // [边界] 全不命中返回 undefined，调用方按假值省略。
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.startsWith("https://"),
  );
}

/** 高级折叠区外壳：详情页底部的「更多详情」，内容由父级注入（rootPath/Hook 明细/配置）。 */
// [契约] 高级区是受控外壳：内容由父级注入，`PluginStoreDetailView` 不取数。
// [失败路径] 在此读运行时会造出第二个数据源，出现双份真相。
// [权衡] 用原生 details/summary 而不是受控折叠：无额外状态且保留可访问性。
// [边界] 仅已安装且父级拿到运行时信息时才会挂载本组件。
export function PluginStoreAdvancedSection({ children }: { children: ReactNode }) {
  const { intl } = useZCodeIntl();
  return (
    <details
      className="group/advanced border-t border-border pt-4"
      data-testid="plugin-store-advanced"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-ui-base font-medium text-foreground-subtle transition-colors hover:text-foreground">
        <ChevronRight
          className="size-3.5 transition-transform group-open/advanced:rotate-90"
          aria-hidden="true"
        />
        {intl.formatMessage({ id: "settings.plugins.detail.moreDetails" })}
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}
