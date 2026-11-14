// INV-01 官方不可删：守住位置 可移除判断；改错故障：删掉官方市场后启动又被补回。
// INV-02 默认不可删：守住位置 默认市场比较；改错故障：默认市场被移除，推荐列表失效。
// INV-03 只列已登记：守住位置 数据来源；改错故障：弹窗自行拼装出未登记市场。
// INV-04 标识回传：守住位置 两个回调参数；改错故障：上层按展示名匹配，重名时删错。
// INV-05 排序稳定：守住位置 排序函数；改错故障：列表顺序随输入抖动。
// INV-06 语言即时：守住位置 locale 依赖；改错故障：切换语言后排序不更新。
// INV-07 空态引导：守住位置 空列表分支；改错故障：弹窗只显示一块空白。
// INV-08 操作前缀：守住位置 进行中操作的匹配；改错故障：刷新与移除互相误判。
// INV-09 进行中禁用：守住位置 按钮禁用条件；改错故障：连点触发重复请求。
// INV-10 移除必有反馈：守住位置 移除按钮的图标分支；改错故障：删除过程中没有任何进度。
// INV-11 官方失败静默：守住位置 失败提示条件；改错故障：官方市场每次刷新都弹红字。
// INV-12 失败可读：守住位置 时间与原文拼接；改错故障：用户不知道何时失败、为何失败。
// INV-13 文案走字典：守住位置 全部格式调用；改错故障：界面出现硬编码语言。
// INV-14 测试定位：守住位置 数据集属性；改错故障：端到端选择器失效。
// INV-15 无障碍名：守住位置 图标按钮标签；改错故障：读屏只念出通用按钮。
// INV-16 破坏性配色：守住位置 移除按钮样式；改错故障：删除入口与刷新入口视觉相同。
// INV-17 时间容错：守住位置 无效日期分支；改错故障：显示无效日期文本。
// INV-18 无本地状态：守住位置 组件体；改错故障：弹窗缓存市场列表，与外部不同步。
//
// 模块职责：展示已登记插件市场源，支持刷新与移除，并呈现刷新失败。
// 状态所有权：市场列表与进行中操作归调用方；本组件无本地状态。
// 阅读顺序：可移除判断 → 失败提示 → 弹窗 → 排序与空态 → 行内操作 → 时间格式。
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";
import { CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveMarketplaceDisplayName } from "@/settings/pluginSourceLabel.js";
import {
  isPublicStoreMarketplaceId,
  sortMarketplaceSources,
} from "@/settings/pluginStoreListing.js";
import { DEFAULT_MARKETPLACE_ID } from "@/settings/recommendedPlugins.js";

// 官方市场不可移除：移除后启动时会被重新补种，只会造成「删了又回来」的困惑。
// `isPublicStoreMarketplaceId` 命中的公共市场与 `DEFAULT_MARKETPLACE_ID` 都不可移除。
// 移除后会被重新补种，避免删了又回来的困惑。
//
function isRemovableMarketplace(marketplace: ZCodePluginMarketplaceSummary): boolean {
  if (isPublicStoreMarketplaceId(marketplace.id)) return false;
  if (marketplace.id === DEFAULT_MARKETPLACE_ID) return false;
  return true;
}

// 失败提示带时间与原文，不做截断以外的处理。
// 破坏性配色只用于提示块，不影响其他行样式。
//
export function PluginStoreSourceRefreshFailure({
  failure,
}: {
  failure: NonNullable<ZCodePluginMarketplaceSummary["refreshFailure"]>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="mt-1 flex min-w-0 items-start gap-1 text-ui-base text-destructive"
      data-testid="plugin-store-source-refresh-failure"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {intl.formatMessage(
          { id: "settings.plugins.store.sources.refreshFailed" },
          { time: formatSourceTime(failure.failedAt) },
        )}
        {`: ${failure.message}`}
      </span>
    </div>
  );
}

/** 顶栏店铺图标 → 市场源管理：列出已登记市场，支持刷新与移除（新增走 New 按钮）。 */
// 弹窗只管理 `marketplaces` 里已登记的市场，新增走外部 New 按钮。
// 所有操作都以标识回传，不在本地缓存列表。
//
export function PluginStoreSourcesDialog({
  open,
  onOpenChange,
  marketplaces,
  onUpdateMarketplace,
  onRemoveMarketplace,
  activeOperations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplaces: ZCodePluginMarketplaceSummary[];
  onUpdateMarketplace: (marketplace: string) => void;
  onRemoveMarketplace: (marketplace: string) => void;
  activeOperations: ReadonlyArray<{ id: string }>;
}) {
  const { intl, locale } = useZCodeIntl();
  const claudeCodePlugins = intl.formatMessage({
    id: "settings.plugins.marketplace.claudeCodePlugins",
  });
  // `sortMarketplaceSources` 按 `locale` 排序，切换语言立即重排。
  // 排序为纯函数，不修改传入数组。
  //
  const sortedMarketplaces = sortMarketplaceSources(marketplaces, locale);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(480px,calc(100vw-2rem))] max-w-none"
        data-testid="plugin-store-sources-dialog"
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.plugins.store.sources.title" })}
        </DialogTitle>
        <div className="max-h-[min(420px,60vh)] space-y-1 overflow-y-auto">
          {sortedMarketplaces.length === 0 ? (
            <p className="px-1 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.plugins.store.sources.empty" })}
            </p>
          ) : (
            sortedMarketplaces.map((marketplace) => {
              // 更新与移除各自按标识前缀匹配进行中操作。
              // 匹配到即禁用按钮，防止重复提交。
              //
              const updating = activeOperations.some(
                (operation) => operation.id === `marketplace:update:${marketplace.id}`,
              );
              const removing = activeOperations.some(
                (operation) => operation.id === `marketplace:remove:${marketplace.id}`,
              );
              return (
                <div
                  key={marketplace.id}
                  data-testid="plugin-store-source-row"
                  data-marketplace-id={marketplace.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-ui-base font-medium text-foreground">
                        {resolveMarketplaceDisplayName(
                          marketplace.id,
                          [marketplace],
                          claudeCodePlugins,
                        )}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-ui-base text-foreground-subtle">
                      {intl.formatMessage(
                        { id: "settings.plugins.store.sources.pluginCount" },
                        { count: String(marketplace.pluginCount) },
                      )}
                      {marketplace.lastUpdated
                        ? ` · ${intl.formatMessage(
                            { id: "settings.plugins.store.sources.lastUpdated" },
                            { time: formatSourceTime(marketplace.lastUpdated) },
                          )}`
                        : ""}
                    </div>
                    {marketplace.refreshFailure &&
                    // claude-plugins-official 的刷新失败不提示（同 pluginManagementStore.updateMarketplace）。
                    marketplace.id !== CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID ? (
                      <PluginStoreSourceRefreshFailure failure={marketplace.refreshFailure} />
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    data-testid="plugin-store-source-update"
                    data-marketplace-id={marketplace.id}
                    variant="ghost"
                    size="icon-lg"
                    aria-label={intl.formatMessage({
                      id: "settings.plugins.store.sources.update",
                    })}
                    disabled={updating}
                    onClick={() => onUpdateMarketplace(marketplace.id)}
                  >
                    <RefreshCw
                      className={updating ? "size-3.5 animate-spin" : "size-3.5"}
                      aria-hidden="true"
                    />
                  </Button>
                  {isRemovableMarketplace(marketplace) ? (
                    <Button
                      type="button"
                      data-testid="plugin-store-source-remove"
                      data-marketplace-id={marketplace.id}
                      variant="ghost"
                      size="icon-lg"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      aria-label={intl.formatMessage({
                        id: "settings.plugins.store.sources.remove",
                      })}
                      disabled={removing}
                      onClick={() => onRemoveMarketplace(marketplace.id)}
                    >
                      {removing ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      )}
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 时间无效时原样返回，避免显示无效日期。
// `formatSourceTime` 用 `toLocaleString()` 按当前区域设置格式化。
//
function formatSourceTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleString();
}
