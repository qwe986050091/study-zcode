// INV-01 [边界] 本组件只消费 useStorageUsage 的投影，不直接读 StorageService 或 preload 桥；守住位置：组件内唯一的 hook 调用；改错故障：出现第二条读取路径，快照与清理结果互相矛盾。
// INV-02 [状态] 选择态三项都留在组件内，服务快照不复制进本地 state；守住位置：selectedGroupKey、detailCategory、confirmTarget 三个 useState；改错故障：把快照写进本地 state，重扫后展示过期容量。
// INV-03 [契约] 容量与时间只经 formatBytes、formatDateTime 输出，不手工拼单位；守住位置：总量、类别列表、toast 文案；改错故障：同一数字出现两种单位写法，用户对不上。
// INV-04 [事务] 清理只有 runClean 一条写路径，列表与确认框共用；守住位置：requestClean 与对话框 onConfirm；改错故障：新增第二条删除入口后确认语义分叉。
// INV-05 [并发] 全组件只有一个 busy 闸，源自 cleaningCategory；守住位置：busy 常量与三处 disabled；改错故障：清理与重扫并发，旧快照覆盖新结果。
// INV-06 [失败路径] 桥不可用是唯一提前返回分支，其余异常在 runClean 内收敛；守住位置：bridge 守卫与 catch 块；改错故障：渲染中途抛错，整块 tab 白屏。
// INV-07 [权衡] 选中卷失效时在渲染期回落首项，不写回 state；守住位置：selectedGroup 的两级兜底；改错故障：用 effect 回写引起选中抖动甚至自激。
// INV-08 [资源] 容量汇总按卷边界进行，跨根合并只发生在同一卷内；守住位置：sumCategoriesAcrossRoots 的两处调用；改错故障：图例与总量口径不一，占比失真。
// INV-09 [顺序] 状态文案优先级为扫描中、最后扫描时间、失败、空闲；守住位置：状态区嵌套三元；改错故障：失败态遮掉时间戳，用户失去上次扫描参照。
// INV-10 [契约] 清理动作只认 cleanability 字段，不按类别 id 硬编码；守住位置：requestClean 的两个分支；改错故障：新增类别漏配确认，直接被无提示删除。
// INV-11 [失败路径] 部分失败必须可见，提示里带失败条数；守住位置：cleanPartial 分支；改错故障：失败被当成功，用户以为空间已释放。
// INV-12 [事务] 逐根清理串行执行，合并结果在循环结束后统一提示；守住位置：runClean 的 for 循环与三态 toast；改错故障：边清边报，提示与实际总释放量不符。
// INV-13 [状态] 明细类别只在切卷时重置，返回列表不清空选中卷；守住位置：StorageDiskCard 的 onSelect；改错故障：返回后重进丢失上下文，或详情串到别的卷。
// INV-14 [契约] 测试定位点固定四个 TID，父容器不重复挂；守住位置：section、total、status、rescan；改错故障：E2E 取到多个节点，断言不稳定。
// INV-15 [资源] 磁盘卡片图例复用同一汇总结果，避免二次遍历；守住位置：buildStorageLegend 的实参；改错故障：两处各自计算，图例与数字漂移。
// INV-16 [失败路径] reveal 在无桥时降级为空操作，不阻塞详情；守住位置：onReveal 的兜底；改错故障：抛错打断返回与清理交互。
// INV-17 [权衡] 估算说明紧跟磁盘卡片而非沉到页脚；守住位置：左栏卡片列末尾的说明块；改错故障：说明与数字分离，用户误读容量含义。
// INV-18 [顺序] 错误横幅位于头部与主体之间，主体不因错误落空；守住位置：errors 条件渲染；改错故障：横幅挤占主体，或出错时整个列表消失。
//
// 模块职责：资源管理器「存储」tab 的总览与操作入口，编排总量、扫描状态、磁盘卡片、类别列表、明细与清理确认。
// 状态所有权：snapshot、scanning、rescan、clean 归 useStorageUsage；组件只持有选中卷、明细类别、确认目标与清理中的类别。
// 阅读顺序：先看 hook 与派生值，再读 runClean 的逐根合并与三态提示，最后看 bridge 守卫、头部状态区与右栏二选一。
/**
 * 资源管理器「存储」tab。
 * 数据来自 useStorageUsage（main 进程 StorageService 经 preload 桥的投影）；本组件只持有 UI 选择态：
 * 选中的磁盘、打开的类别明细、待确认的清理目标。
 */
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  groupStorageRootsByVolume,
  type StorageCategoryId,
  type StorageCleanResult,
  type StorageManagementBridge,
  type StorageRootId,
} from "@zcode/shared";
import {
  TID_RESOURCE_MANAGER_STORAGE_RESCAN,
  TID_RESOURCE_MANAGER_STORAGE_SECTION,
  TID_RESOURCE_MANAGER_STORAGE_STATUS,
  TID_RESOURCE_MANAGER_STORAGE_TOTAL,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useStorageUsage } from "./useStorageUsage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { StorageCategoryDetail } from "./StorageCategoryDetail.js";
import { StorageCategoryList } from "./StorageCategoryList.js";
import {
  StorageCleanConfirmDialog,
  type StorageCleanConfirmTarget,
} from "./StorageCleanConfirmDialog.js";
import { StorageDiskCard } from "./StorageDiskCard.js";
import { buildStorageLegend, sumCategoriesAcrossRoots } from "./storageCategoryPresentation.js";

export function StorageSection({
  bridge,
  active,
}: {
  /** preload 暴露的 window.resourceManager.storage；缺省表示桥接不可用 */
  bridge: StorageManagementBridge | undefined;
  /** tab 是否处于激活态：激活才扫描，切走即取消 */
  active: boolean;
}) {
  // [状态] intl 从 useZCodeIntl 取，文案一律走消息 id 与参数，组件内不拼字符串。
  // [状态] snapshot、scanning、rescan、clean 全部来自 useStorageUsage，enabled 绑定 active，切走即停扫。
  // [状态] selectedGroupKey 记录用户点选，null 表示尚未选择，交给派生逻辑回落。
  // [状态] detailCategory 为 null 时右栏显示类别列表，非 null 时显示该类别明细。
  // [事务] confirmTarget 与 cleaningCategory 分离：前者是待确认意图，后者是正在执行的类别。
  const { intl } = useZCodeIntl();
  const { snapshot, scanning, rescan, clean } = useStorageUsage({ bridge, enabled: active });
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [detailCategory, setDetailCategory] = useState<StorageCategoryId | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<StorageCleanConfirmTarget | null>(null);
  const [cleaningCategory, setCleaningCategory] = useState<StorageCategoryId | null>(null);

  // [资源] groups 按卷分组后缓存在 useMemo 中，依赖只有 snapshot，重扫换代才重算。
  // [状态] selectedGroup 在渲染期回落：key 命中优先，其次首项，都没有则为 null。
  // [权衡] 这里刻意不用 effect 回写 selectedGroupKey，避免重扫后选中项抖动。
  // [资源] categories 只汇总当前选中卷的 roots，切卷即换口径。
  // [契约] totalBytes 汇总全部 roots 的 bytes，是整机口径，与选中卷无关。
  // [契约] status 由 scanning 抢占，其次读 snapshot.status，缺省 idle。
  const groups = useMemo(() => groupStorageRootsByVolume(snapshot?.roots ?? []), [snapshot]);
  // 选中卷在渲染期派生：用户点过的 key 失效（重扫后卷变化）时自动回落到第一张卡片，不用 effect 回写 state。
  const selectedGroup = groups.find((group) => group.key === selectedGroupKey) ?? groups[0] ?? null;
  const categories = useMemo(
    () => (selectedGroup ? sumCategoriesAcrossRoots(selectedGroup.roots) : []),
    [selectedGroup],
  );
  const totalBytes = (snapshot?.roots ?? []).reduce((sum, root) => sum + root.bytes, 0);
  const status = scanning ? "scanning" : (snapshot?.status ?? "idle");

  // [并发] 入口先判 selectedGroup，缺失直接返回，避免置了 cleaningCategory 却无人收尾。
  // [事务] 进入即置 cleaningCategory，它是 busy 的唯一来源，同时禁用重扫与清理按钮。
  // [事务] rootIds 取自选中卷全部 roots，同一类别逐根清理，不假设只有 home 一根。
  // [契约] merged 以全零结果起步，四类计数每轮重建，失败明细逐轮累积。
  // [失败路径] 逐根调用 clean，任何一根抛错都由外层 catch 统一兜底，不会留下半截提示。
  // [失败路径] 零删除零失败提示无可清理，存在失败则提示部分完成并带失败条数。
  // [失败路径] 全部成功才提示释放容量，容量经 formatBytes 输出，保持单位一致。
  // [事务] finally 同时清 cleaningCategory 与 confirmTarget，无论成功失败都解锁界面。
  const runClean = useCallback(
    async (categoryId: StorageCategoryId) => {
      if (!selectedGroup) return;
      setCleaningCategory(categoryId);
      try {
        // 同一卷上可能有两个根（home 与自定义数据路径）：逐根清理同一类别。
        const rootIds: StorageRootId[] = selectedGroup.roots.map((root) => root.id);
        let merged: StorageCleanResult = {
          freedBytes: 0,
          deletedCount: 0,
          skippedCount: 0,
          failures: [],
        };
        for (const rootId of rootIds) {
          const result = await clean({ rootId, categoryId });
          merged = {
            freedBytes: merged.freedBytes + result.freedBytes,
            deletedCount: merged.deletedCount + result.deletedCount,
            skippedCount: merged.skippedCount + result.skippedCount,
            failures: [...merged.failures, ...result.failures],
          };
        }
        if (merged.deletedCount === 0 && merged.failures.length === 0) {
          toast(intl.formatMessage({ id: "resourceManager.storage.cleanNothing" }));
        } else if (merged.failures.length > 0) {
          toast(
            intl.formatMessage(
              { id: "resourceManager.storage.cleanPartial" },
              { size: formatBytes(merged.freedBytes), count: merged.failures.length },
            ),
          );
        } else {
          toast(
            intl.formatMessage(
              { id: "resourceManager.storage.cleanSuccess" },
              { size: formatBytes(merged.freedBytes) },
            ),
          );
        }
      } catch (error) {
        logger.error("[storage] clean failed", { categoryId, error });
        toast(intl.formatMessage({ id: "resourceManager.storage.cleanFailed" }));
      } finally {
        setCleaningCategory(null);
        setConfirmTarget(null);
      }
    },
    [clean, intl, selectedGroup],
  );

  // [事务] 先按 id 在当前 categories 里找类别，找不到直接返回，防止伪造 id 触发删除。
  // [契约] cleanability 为 none 时不提供动作，连确认框都不弹。
  // [事务] cleanability 为 confirm 时只登记 confirmTarget，附带当次 bytes 供对话框展示。
  // [权衡] 其余可清理类别直接执行以省一次点击：删除不可撤销，`cleanability` 已在前一步分流。
  // [并发] 依赖数组含 categories 与 runClean，保证回调看到最新选中卷的分类。
  const requestClean = useCallback(
    (categoryId: StorageCategoryId) => {
      const category = categories.find((item) => item.id === categoryId);
      if (!category || category.cleanability === "none") return;
      if (category.cleanability === "confirm") {
        setConfirmTarget({ categoryId, bytes: category.bytes });
        return;
      }
      void runClean(categoryId);
    },
    [categories, runClean],
  );

  const busy = cleaningCategory !== null;

  // [失败路径] bridge 缺失时整块渲染为不可用提示，不再往下读 snapshot。
  // [契约] 该分支仍挂 section 测试点，E2E 可在无桥环境断言提示存在。
  // [权衡] 提示用 destructive 配色，说明这是能力缺失而非加载中。
  // [事务] 提前返回放在所有 hook 调用之后，避免条件调用 hook 破坏顺序。
  if (!bridge) {
    return (
      <div
        data-testid={TID_RESOURCE_MANAGER_STORAGE_SECTION}
        className="rounded-xl border border-destructive/30 bg-card px-4 py-3 text-ui-sm text-destructive"
      >
        {intl.formatMessage({ id: "resourceManager.unavailable" })}
      </div>
    );
  }

  return (
    <div data-testid={TID_RESOURCE_MANAGER_STORAGE_SECTION} className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "resourceManager.storage.summaryTotal" })}
          </div>
          <div
            // [契约] 总量直接展示 formatBytes 的结果，数字用 tabular-nums 保证跳动时不抖宽。
            // [契约] 状态节点的 data-state 取 status，供样式与 E2E 断言当前扫描轮次。
            // [顺序] 文案四级回退：扫描中、最后扫描时间、失败、空闲，顺序不可调换。
            // [资源] 重扫按钮在 scanning 或 busy 时禁用，点击后只触发不等待，结果回到 snapshot。
            data-testid={TID_RESOURCE_MANAGER_STORAGE_TOTAL}
            className="text-ui-xl font-semibold tabular-nums text-foreground"
          >
            {formatBytes(totalBytes)}
          </div>
        </div>
        <div
          data-testid={TID_RESOURCE_MANAGER_STORAGE_STATUS}
          data-state={status}
          className="flex items-center gap-1.5 text-ui-caption text-foreground-subtle"
        >
          {scanning ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {scanning
            ? intl.formatMessage({ id: "resourceManager.storage.scanning" })
            : snapshot?.finishedAt
              ? intl.formatMessage(
                  { id: "resourceManager.storage.lastScanned" },
                  {
                    time: formatDateTime(snapshot.finishedAt),
                  },
                )
              : snapshot?.status === "failed"
                ? intl.formatMessage({ id: "resourceManager.storage.failed" })
                : intl.formatMessage({ id: "resourceManager.storage.idle" })}
        </div>
        <div className="ml-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={TID_RESOURCE_MANAGER_STORAGE_RESCAN}
            disabled={scanning || busy}
            onClick={() => void rescan()}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "resourceManager.storage.rescan" })}
          </Button>
        </div>
      </div>

      {snapshot && snapshot.errors.length > 0 ? (
        <div className="text-ui-caption text-warning">
          {intl.formatMessage(
            { id: "resourceManager.storage.errors" },
            { count: snapshot.errors.length },
          )}
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          {groups.map((group, index) => (
            <StorageDiskCard
              key={group.key}
              group={group}
              index={index}
              legend={buildStorageLegend(sumCategoriesAcrossRoots(group.roots))}
              selected={group.key === selectedGroup?.key}
              selectable={groups.length > 1}
              onSelect={() => {
                setSelectedGroupKey(group.key);
                setDetailCategory(null);
              }}
            />
          ))}
          {/* 估算说明紧跟磁盘卡片，和它解释的数字放在一起，而不是沉到页面底部 */}
          <div className="px-1 text-ui-caption text-foreground-subtlest">
            {intl.formatMessage({ id: "resourceManager.storage.estimate" })}
          </div>
        </div>
        <div className="min-w-0">
          {selectedGroup && detailCategory ? (
            <StorageCategoryDetail
              categoryId={detailCategory}
              roots={selectedGroup.roots}
              cleaning={cleaningCategory === detailCategory}
              disabled={busy || scanning}
              onBack={() => setDetailCategory(null)}
              onClean={() => requestClean(detailCategory)}
              onReveal={(absolutePath) => bridge?.revealPath(absolutePath) ?? Promise.resolve()}
            />
          ) : (
            <StorageCategoryList
              categories={categories}
              cleaningCategory={cleaningCategory}
              disabled={busy || scanning}
              onOpen={setDetailCategory}
              onClean={requestClean}
            />
          )}
        </div>
      </div>

      <StorageCleanConfirmDialog
        target={confirmTarget}
        pending={busy}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (confirmTarget) void runClean(confirmTarget.categoryId);
        }}
      />
    </div>
  );
}
