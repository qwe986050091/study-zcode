// INV-01 分类图标只从集中映射读取：守住位置 图标查找；改错故障 新增分类缺少图标时整页崩溃。
// INV-02 每个根只展示字节数为正的目标分类：守住位置 perRoot 过滤；改错故障 空分类占据版面。
// INV-03 总字节数是各根同类分类之和：守住位置 reduce；改错故障 头部数字与明细不一致。
// INV-04 可清理性取首个根的声明：守住位置 cleanability；改错故障 不同根状态不一致时按钮闪烁。
// INV-05 清理按钮只在可清理且总量为正时出现：守住位置 条件渲染；改错故障 对不可清理分类展示按钮。
// INV-06 清理中必须显示旋转图标并替换文案：守住位置 cleaning 分支；改错故障 用户重复点击。
// INV-07 清理按钮的禁用态由外部统一控制：守住位置 disabled 入参；改错故障 清理中仍可再次触发。
// INV-08 返回按钮始终可用：守住位置 顶部按钮；改错故障 清理进行中无法离开详情。
// INV-09 根路径必须单行截断并保留完整悬停标题：守住位置 title 与类名；改错故障 长路径撑破布局。
// INV-10 条目列表允许为空：守住位置 空数组兜底；改错故障 缺少条目时渲染异常。
// INV-11 更多条目使用固定相对路径识别：守住位置 isMore 判断；改错故障 汇总行被当成普通文件。
// INV-12 更多条目展示条目数而不是路径：守住位置 条件文案；改错故障 出现内部占位路径。
// INV-13 更多条目不得显示定位按钮：守住位置 isMore 分支；改错故障 点击定位到不存在的路径。
// INV-14 定位按钮必须同时提供标题与读屏标签：守住位置 两个属性；改错故障 图标按钮无含义。
// INV-15 定位路径由根路径与相对路径统一拼接：守住位置 joinStoragePath；改错故障 分隔符重复或缺失。
// INV-16 所有字节展示都走统一格式化：守住位置 三处 formatBytes；改错故障 单位与精度不一致。
// INV-17 所有文案都走国际化：守住位置 全部 formatMessage；改错故障 多语言下出现硬编码英文。
// INV-18 列表键使用根标识与相对路径：守住位置 两个 key；改错故障 重复渲染或状态错位。
//
// 模块职责：StorageCategoryDetail 负责单分类的根路径与条目列表渲染，清理与定位入口由父组件提供。
// 状态所有权：roots / cleaning / disabled 均来自入参，本组件不持有可变状态（INV-01）。
// 阅读顺序：先看分类聚合，再读头部操作区，最后看按根分组的条目列表。
import { ChevronLeft, FolderOpen, Loader2 } from "lucide-react";
import {
  type StorageCategoryId,
  type StorageRootUsage,
  STORAGE_MORE_ENTRIES_PATH,
} from "@zcode/shared";
import {
  TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK,
  TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import {
  STORAGE_CATEGORY_ICONS,
  joinStoragePath,
  storageCategoryDescriptionId,
  storageCategoryTitleId,
} from "./storageCategoryPresentation.js";

// StorageCategoryDetail 入参只有 categoryId / roots / cleaning / disabled / onBack / onClean / onReveal：
// onReveal 返回 Promise，失败由调用方兜底；组件不订阅全局状态，所有展示值在一次渲染内聚合完成，
// 渲染结果只依赖入参，因此父组件重渲即等价刷新。
export function StorageCategoryDetail({
  categoryId,
  roots,
  cleaning,
  disabled,
  onBack,
  onClean,
  onReveal,
}: {
  categoryId: StorageCategoryId;
  roots: StorageRootUsage[];
  cleaning: boolean;
  disabled: boolean;
  onBack: () => void;
  onClean: () => void;
  onReveal: (absolutePath: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const Icon = STORAGE_CATEGORY_ICONS[categoryId];
  // perRoot 只保留当前分类存在且 bytes > 0 的根（INV-02），并保留 root 供分组渲染；
  // totalBytes 由 perRoot 累加（INV-03），必须与头部数字同源，否则明细与合计对不上。
  const perRoot = roots
    .map((root) => ({ root, category: root.categories.find((item) => item.id === categoryId) }))
    .filter((item) => item.category && item.category.bytes > 0);
  const totalBytes = perRoot.reduce((sum, item) => sum + (item.category?.bytes ?? 0), 0);
  // cleanability 取 perRoot[0]?.category?.cleanability，没有根时回退 none（INV-04）：
  // 它只控制清理按钮是否出现（INV-05），实际清理动作仍由 onClean 交给父组件。
  const cleanability = perRoot[0]?.category?.cleanability ?? "none";

  return (
    <div data-testid={TID_RESOURCE_MANAGER_STORAGE_DETAIL} className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK}
          onClick={onBack}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "resourceManager.storage.detailBack" })}
        </Button>
        <span className="flex size-8 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: storageCategoryTitleId(categoryId) })}
          </div>
          <div className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: storageCategoryDescriptionId(categoryId) })}
          </div>
        </div>
        <span className="text-ui-base tabular-nums text-foreground">{formatBytes(totalBytes)}</span>
        {cleanability !== "none" && totalBytes > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN, categoryId)}
            disabled={disabled}
            onClick={onClean}
          >
            {cleaning ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({
              id: cleaning ? "resourceManager.storage.cleaning" : "resourceManager.storage.clean",
            })}
          </Button>
        ) : null}
      </div>
      {perRoot.map(({ root, category }) => (
        <div key={root.id} className="overflow-hidden rounded-xl border border-card-border bg-card">
          <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-ui-caption">
            <span
              className="min-w-0 flex-1 truncate font-mono text-foreground-subtle"
              title={root.path}
            >
              {root.path}
            </span>
            <span className="tabular-nums text-foreground">
              {formatBytes(category?.bytes ?? 0)}
            </span>
          </div>
          {(category?.entries ?? []).map((entry) => {
            // isMore 用 entry.relativePath === STORAGE_MORE_ENTRIES_PATH 识别汇总占位（INV-11）：
            // 为真时文案显示 entry.fileCount（INV-12）且不渲染定位按钮（INV-13），否则按相对路径展示。
            const isMore = entry.relativePath === STORAGE_MORE_ENTRIES_PATH;
            return (
              <div
                key={entry.relativePath}
                data-testid={TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY}
                className="flex items-center gap-3 border-t border-border px-4 py-2 first:border-t-0"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate font-mono text-ui-base text-foreground"
                    title={entry.relativePath}
                  >
                    {isMore
                      ? intl.formatMessage(
                          { id: "resourceManager.storage.moreEntries" },
                          { count: entry.fileCount },
                        )
                      : entry.relativePath}
                  </span>
                  <span className="block text-ui-caption text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "resourceManager.storage.filesCount" },
                      { count: entry.fileCount },
                    )}
                  </span>
                </span>
                <span className="text-ui-base tabular-nums text-foreground">
                  {formatBytes(entry.bytes)}
                </span>
                {isMore ? null : (
                  <button
                    type="button"
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-foreground-subtlest hover:bg-surface-hover"
                    title={intl.formatMessage({ id: "resourceManager.storage.reveal" })}
                    aria-label={intl.formatMessage({ id: "resourceManager.storage.reveal" })}
                    onClick={() => void onReveal(joinStoragePath(root.path, entry.relativePath))}
                  >
                    <FolderOpen className="size-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
