// 工作区插件预览：输入框旁的插件入口按钮与弹出面板，列出当前工作区可引用的插件。
// 三态渲染、mention 构造与商店跳转都在本文件闭合，组件只消费 hook，不直接接触服务。
// INV-01 [不变量] 只有已启用且冲突列表为空的插件才可被引用；守住位置：isWorkspacePluginReferenceable 的联合判断；改错故障：用户可选中冲突插件，插入后运行时解析到不确定版本。
// INV-02 [不变量] mention 的 id 恒为 plugin 前缀加 pluginId，value 存原始 pluginId；守住位置：buildWorkspacePluginMention 的返回对象；改错故障：同一插件产生两个 mention 身份，去重失效。
// INV-03 [不变量] label 取 manifest 原始 name，本地化显示名只用于菜单展示；守住位置：buildWorkspacePluginMention 的 label 字段；改错故障：切换语言后已插入的 mention 文本与历史消息不一致。
// INV-04 [失败路径] icon 缺失时不写入 data，由下游回退默认图标；守住位置：条件展开运算符；改错故障：空字符串图标覆盖默认图标，列表出现空白方块。
// INV-05 [不变量] 身份 key 固定为 identity 去空白优先、路径兜底，再拼远程会话 id；守住位置：workspaceKey 表达式；改错故障：同一工作区的本地与远程会话共用缓存。
// INV-06 [并发] 目录快照只在 authority 非空时写入；守住位置：useEffect 内的 setLastCatalog 分支；改错故障：中间态覆盖成功结果，缩略图标成批闪烁。
// INV-07 [不变量] 快照仅在 workspaceKey 相等时生效；守住位置：previewEntries 三元判断；改错故障：切换工作区后仍展示上一个工作区的插件。
// INV-08 [资源] 刷新期间优先复用同一工作区的最近成功快照；守住位置：previewEntries 的回退分支；改错故障：重试时面板整块退回骨架屏。
// INV-09 [不变量] 可见列表由公开商店条目与非公开条目两段拼成，公开段在前；守住位置：visibleEntries 的返回数组；改错故障：商店插件被非公开插件挤到列表末尾。
// INV-10 [不变量] 公开条目排序同时受 locale 与办公/代码模式影响；守住位置：sortPluginStoreEntries 调用的参数；改错故障：切换模式后顺序停在旧值。
// INV-11 [不变量] 公开段内部再按文档插件优先级稳定排序；守住位置：publicEntries 的 toSorted；改错故障：同分插件每次渲染顺序抖动。
// INV-12 [事务] 打开面板且不在加载中时自增刷新版本；守住位置：onOpenChange 内的条件自增；改错故障：新安装的插件在面板里长期不可见。
// INV-13 [不变量] 加载、错误、列表三态互斥，加载优先于错误；守住位置：CommandList 内的三元链；改错故障：失败时骨架屏与错误文案同时出现。
// INV-14 [资源] 加载态固定渲染 8 行占位且不读真实数据；守住位置：loading 分支的 Array.from；改错故障：首帧高度塌陷后又撑开，列表剧烈跳动。
// INV-15 [失败路径] 错误态只给统一文案，不暴露底层信息也不自动重试；守住位置：error 分支；改错故障：失败后无限重试打爆目录接口。
// INV-16 [不变量] 空态文案按可见条目数切换搜索无命中与未安装两种表述；守住位置：CommandEmpty 的 id 三元；改错故障：用户分不清是没装插件还是搜索词写错。
// INV-17 [事务] 选中插件先关面板再交给外部回调；守住位置：selectPlugin；改错故障：面板遮挡输入框，焦点落空。
// INV-18 [事务] 商店跳转严格按关面板、请求打开、通知外部三步执行；守住位置：browse；改错故障：商店页与预览面板两个浮层叠加。
// INV-19 [不变量] 触发器最多展示 3 个缩略图标且 key 用 pluginId；守住位置：visibleEntries 的 slice 渲染；改错故障：图标按位置复用，重排后闪现错误插件。
//
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  compareDocumentPluginPriority,
  isPublicStoreMarketplaceId,
  resolvePluginDisplayName,
  sortPluginStoreEntries,
} from "@zcode/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from "@/components/ui/command.js";
import { PluginIcon } from "@/components/PluginIcon.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { Button } from "@/components/ui/button.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

import type { WorkspacePluginPreviewProps } from "./contract.js";

// [不变量] 目录条目类型直接从 hook 返回值推导，避免手写结构与之漂移。
// [权衡] 代价是 hook 返回类型变更会静默扩散到这里，改动 hook 需回看本文件的字段用法。
type WorkspacePluginPreviewEntry = ReturnType<typeof usePluginReferenceCatalog>["entries"][number];

// [不变量] 禁用或存在冲突的插件在过滤阶段就被剔除，不会进入列表。
// [失败路径] 若放开这一判断，用户会把冲突插件插入输入框，运行时解析到不确定版本。
export function isWorkspacePluginReferenceable(entry: WorkspacePluginPreviewEntry): boolean {
  return entry.enabled && entry.conflictingPluginIds.length === 0;
}

// [不变量] mention 的 id 恒为 plugin 前缀加 pluginId，value 存原始 pluginId。
// [事务] 该函数是纯构造，不发请求也不改状态，便于在选中回调里直接调用。
export function buildWorkspacePluginMention(
  entry: WorkspacePluginPreviewEntry,
): ComposerMentionPrefill {
  return {
    id: `plugin:${entry.pluginId}`,
    category: "plugins",
    // canonical mention 使用 manifest name；本地化显示名只用于菜单展示。
    // [不变量] label 固定取 manifest 原始 name，本地化显示名只用于菜单可见文本。
    // [失败路径] 若改用显示名，切换语言后已插入的 mention 文本会与历史消息不一致。
    label: entry.name,
    value: entry.pluginId,
    markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
    data: {
      pluginId: entry.pluginId,
      ...(entry.icon ? { icon: entry.icon } : {}),
    },
  };
}

// [不变量] 入参全部来自 props，内部不补造 workspacePath，缺省降级交给目录 hook。
// [失败路径] workspacePath 为空时 hook 自行返回错误态，本组件不额外拦截以免遮住真实错误。
export function WorkspacePluginPreview({
  onOpen,
  onSelectPlugin,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: WorkspacePluginPreviewProps) {
  const { intl, locale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const { order } = usePluginStoreOrder();
  const [open, setOpen] = useState(false);
  // [事务] retryRevision 只做自增，作为目录 hook 的刷新版本号，不承载业务数据。
  // [权衡] 用数值而非布尔，保证连续多次刷新都能触发一次新的请求。
  const [retryRevision, setRetryRevision] = useState(0);
  const [lastCatalog, setLastCatalog] = useState<{
    workspaceKey: string;
    entries: ReturnType<typeof usePluginReferenceCatalog>["entries"];
  } | null>(null);
  // [不变量] 身份 key 固定为 identity 去空白优先、workspacePath 兜底，再拼远程会话 id。
  // [并发] 本地会话统一记为 local，远程会话切换必须让 key 变化，否则缓存目录会串会话。
  const workspaceKey = `${workspaceIdentity?.trim() || workspacePath}|${remoteSessionId ?? "local"}`;
  // [资源] 目录请求由 hook 统一发起与取消，本组件只消费条目与三个状态位。
  // [不变量] 第四个参数为 true 表示允许按需加载，刷新版本通过 refreshRevision 透传。
  const { entries, authority, loading, error } = usePluginReferenceCatalog(
    workspacePath,
    workspaceIdentity,
    null,
    true,
    {
      preferredRemoteSessionId: remoteSessionId,
      refreshRevision: retryRevision,
    },
  );
  // [事务] 该副作用只做快照同步，不发起请求，依赖变化时整体重跑一次。
  // [不变量] 依赖为 authority、entries 与 workspaceKey，三者任一变化才允许覆盖快照。
  useEffect(() => {
    // [并发] 仅在 authority 非空、即目录已就绪时写入快照，避免把中间态当成成功结果。
    // [失败路径] 过早写入会让缩略图标在半成品列表上渲染，随后又整批替换，产生闪烁。
    if (authority !== null) setLastCatalog({ workspaceKey, entries });
  }, [authority, entries, workspaceKey]);
  // 刷新时目录 hook 会隔离旧请求；仅为同一 workspace 保留已成功加载的缩略图。
  // [并发] 刷新时 hook 会隔离旧请求，此处只回退到同一 workspaceKey 的最近成功快照。
  // [不变量] key 不匹配时一律使用 hook 当前条目，绝不跨工作区复用。
  // [权衡] 用快照换取重试期间图标不消失，代价是短暂展示的数据可能已过期。
  const previewEntries =
    authority === null && lastCatalog?.workspaceKey === workspaceKey
      ? lastCatalog.entries
      : entries;
  // [资源] 过滤与排序都在 useMemo 内完成，依赖不变时复用同一数组引用。
  // [不变量] 依赖只列 previewEntries、模式、locale 与排序配置，漏项会导致列表不刷新。
  const visibleEntries = useMemo(() => {
    // [不变量] 办公模式取 work 排序，其余取 code 排序，两者都缺失时交给默认比较。
    // [失败路径] 排序配置尚未加载时为 undefined，下游需容忍而不是直接抛错。
    const modeOrder = isOfficeMode ? order?.work : order?.code;
    const referenceableEntries = previewEntries.filter(isWorkspacePluginReferenceable);
    // [不变量] 只有公开商店来源的条目参与商店排序，非公开条目保持原始相对顺序。
    // [权衡] 排序键同时带 category 与本地化显示名，保证同一语言下结果稳定。
    const publicEntries = sortPluginStoreEntries(
      referenceableEntries.filter((entry) => isPublicStoreMarketplaceId(entry.marketplace)),
      (entry) => ({
        id: entry.pluginId,
        category: entry.category,
        displayName: resolvePluginDisplayName(
          {
            name: entry.name,
            listing: {
              displayName: entry.displayName,
              displayNameI18n: entry.displayNameI18n,
            },
          },
          locale,
        ),
      }),
      locale,
      modeOrder,
    );
    return [
      // [不变量] 公开条目在商店排序之上再按文档插件优先级稳定排序，同分保持相对次序。
      // [并发] toSorted 返回新数组，不改动 useMemo 内的中间结果，可安全重复渲染。
      ...publicEntries.toSorted((left, right) =>
        compareDocumentPluginPriority(left.pluginId, right.pluginId),
      ),
      ...referenceableEntries.filter((entry) => !isPublicStoreMarketplaceId(entry.marketplace)),
    ];
  }, [previewEntries, isOfficeMode, locale, order]);
  // [事务] 先关面板、再请求打开商店、最后通知外部，三步顺序固定。
  // [失败路径] 顺序颠倒会导致两个浮层叠加，或关闭动画与商店页面互相抢焦点。
  const browse = (pluginId?: string) => {
    setOpen(false);
    requestPluginStoreOpen(pluginId);
    onOpen();
  };
  // [事务] 选中即关闭面板，并把构造好的 mention 交给外部回调，本组件不写任何状态。
  // [不变量] 回调参数取自可见列表的元素类型，字段变动会在类型层暴露。
  const selectPlugin = (entry: (typeof visibleEntries)[number]) => {
    setOpen(false);
    onSelectPlugin(buildWorkspacePluginMention(entry));
  };
  return (
    <Popover
      open={open}
      // [不变量] 面板开关只由受控 open 状态驱动，弹层库的变更回调负责同步。
      // [并发] 打开与刷新在同一回调内串联，先置 open 再自增版本，避免读到旧 loading。
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        // [事务] 仅在打开且不在加载中时自增版本，重复打开不会并发叠加请求。
        // [失败路径] 加载中再自增会被 hook 合并或取消，首屏请求白跑一次。
        if (nextOpen && !loading) setRetryRevision((current) => current + 1);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="shrink-0 gap-1.5 rounded-full bg-transparent pl-3 pr-2 text-ui-base/relaxed text-foreground hover:bg-surface-hover focus-visible:bg-surface-hover"
          data-workspace-plugin-preview=""
        >
          <span className="isolate flex shrink-0 items-center -space-x-1" aria-hidden="true">
            {visibleEntries.slice(0, 3).map((entry) => (
              <PluginIcon
                key={entry.pluginId}
                pluginId={entry.pluginId}
                src={entry.icon}
                className="relative size-5 shrink-0 rounded-lg bg-card ring-1 ring-inset ring-border/30"
                iconClassName="size-4"
              />
            ))}
          </span>
          <span className="whitespace-nowrap">
            {intl.formatMessage({ id: "settings.plugin.tab.plugins" })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-72 max-w-[calc(100vw-2rem)] gap-0 rounded-2xl bg-menu p-0 shadow-xs"
      >
        <Command className="bg-menu pb-0 [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:p-0">
          <CommandInput
            placeholder={intl.formatMessage({
              id: "settings.plugin.plugins.searchPlaceholder",
            })}
          />
          <CommandList
            className="h-64 max-h-[min(16rem,calc(var(--radix-popover-content-available-height,100vh)-7rem))]"
            aria-busy={loading}
          >
            {loading ? (
              <div role="status" aria-label={intl.formatMessage({ id: "common.loading" })}>
                {Array.from({ length: 8 }, (_, index) => (
                  <div
                    key={index}
                    aria-hidden="true"
                    className="my-px flex h-8 items-center gap-3 px-3 motion-safe:animate-pulse"
                  >
                    <span className="size-5 shrink-0 rounded-md bg-surface-hover" />
                    <span className="h-3 w-28 rounded-sm bg-surface-hover" />
                  </div>
                ))}
              </div>
            // [失败路径] 错误态只显示统一文案，不暴露底层错误细节，也不自动重试。
            // [权衡] 重试交给用户再次打开面板触发，避免失败后无限循环打接口。
            ) : error ? (
              <div role="status" className="p-3 text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "chat.plugins.loadError" })}
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {intl.formatMessage({
                    id: visibleEntries.length
                      ? "settings.plugins.store.searchEmpty"
                      : "settings.plugin.plugins.emptyInstalledTitle",
                  })}
                </CommandEmpty>
                {visibleEntries.map((entry) => {
                  // [不变量] 列表项显示名同样走显示名解析函数，与排序键保持同一口径。
                  // [失败路径] 显示名与排序名不一致时，用户看到的顺序会与字母序对不上。
                  const name = resolvePluginDisplayName(
                    {
                      name: entry.name,
                      listing: {
                        displayName: entry.displayName,
                        displayNameI18n: entry.displayNameI18n,
                      },
                    },
                    locale,
                  );
                  return (
                    <CommandItem
                      key={entry.pluginId}
                      value={entry.pluginId}
                      keywords={[name, entry.name, ...Object.values(entry.displayNameI18n ?? {})]}
                      // [事务] `selectPlugin` 只做一次转发：不记录最近使用，也不写任何持久化。
                      onSelect={() => selectPlugin(entry)}
                      className="my-px h-8 gap-3 rounded-xl px-3 py-0 hover:bg-hover data-selected:bg-selected"
                    >
                      <PluginIcon
                        pluginId={entry.pluginId}
                        src={entry.icon}
                        className="size-5 rounded-lg bg-card ring-1 ring-inset ring-border/30"
                        iconClassName="size-4"
                      />
                      <span className="truncate">{name}</span>
                    </CommandItem>
                  );
                })}
              </>
            )}
          </CommandList>
        </Command>
        <div className="mx-1 mt-3 border-t border-border py-1">
          <Button
            variant="ghost"
            className="h-8 w-full justify-between rounded-xl px-3 py-1 text-ui-base/relaxed"
            onClick={() => browse()}
          >
            {intl.formatMessage({ id: "chat.plugins.browseMarketplace" })}
            <ArrowUpRight className="size-4" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
