// INV-01 磁盘名取挂载点：守住位置 空值合并；改错故障 卡片只显示通用文案。
// INV-02 通用名称走国际化：守住位置 消息标识；改错故障 英文硬编码进卡片。
// INV-03 比例按总量计算：守住位置 除法分母；改错故障 分段条宽度溢出。
// INV-04 零字节不出分段：守住位置 大于零判断；改错故障 空磁盘出现全宽色块。
// INV-05 图例顺序即绘制顺序：守住位置 图例数组；改错故障 颜色与分类错位。
// INV-06 已用与可用分开显示：守住位置 两段文案；改错故障 可用空间被算成已用。
// INV-07 无卷信息给未知文案：守住位置 三元分支；改错故障 缺失卷显示为零可用。
// INV-08 剩余分类单独计数：守住位置 标识判断；改错故障 图例显示固定文案而非数量。
// INV-09 分类标题走映射：守住位置 标题函数；改错故障 新分类没有对应标题。
// INV-10 根目录逐条列出：守住位置 映射循环；改错故障 只显示第一条路径。
// INV-11 根标识参与测试标识：守住位置 测试标识生成；改错故障 自动化选不中目标行。
// INV-12 路径可悬停查看：守住位置 标题属性；改错故障 长路径被截断无法确认。
// INV-13 可选中才加指针态：守住位置 样式合并；改错故障 只读卡片出现手型光标。
// INV-14 选中态需同时可选：守住位置 双条件；改错故障 只读卡片显示选中边框。
// INV-15 选中态用属性表达：守住位置 数据属性；改错故障 自动化无法判断选中状态。
// INV-16 卡片索引参与测试标识：守住位置 字符串化索引；改错故障 多磁盘标识重复。
// INV-17 装饰图标不进读屏：守住位置 隐藏属性；改错故障 读屏重复朗读图标。
// INV-18 主体内容复用一次：守住位置 抽出的节点；改错故障 两种容器渲染不一致。
//
// 模块职责：资源管理器中的单块磁盘占用卡片。
// 状态所有权：分组数据由宿主传入，选中态由父级控制。
// 阅读顺序：先看名称与比例条，再看法例与根目录，最后看容器分支。
import { HardDrive } from "lucide-react";
import { type StorageVolumeGroup } from "@zcode/shared";
import {
  TID_RESOURCE_MANAGER_STORAGE_DISK_CARD,
  TID_RESOURCE_MANAGER_STORAGE_ROOT,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { storageCategoryTitleId, type StorageLegendItem } from "./storageCategoryPresentation.js";

// group 与 legend 全部由父级注入，卡片不自行取数。
// StorageDiskCard 自身不读取存储，只做展示。
// selected 只读，选中由父级 onSelect 控制。
// selectable 决定外层用 button 还是 div。
// index 经 String 化后拼进测试标识。
export function StorageDiskCard({
  group,
  index,
  legend,
  selected,
  selectable,
  onSelect,
}: {
  group: StorageVolumeGroup;
  index: number;
  legend: StorageLegendItem[];
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
}) {
  // intl 只在组件顶部取一次。
  // 后续文案全部走 intl.formatMessage。
  // 不缓存 intl.formatMessage 结果，每次渲染重新取。
  // 语言切换后 intl 变化立即生效。
  // 组件内不再取第二处 useZCodeIntl。
  const { intl } = useZCodeIntl();
  const label =
    group.volume?.mountPoint ?? intl.formatMessage({ id: "resourceManager.storage.disk" });
  // body 先算好，两种容器共用同一份节点。
  // label 取 volume.mountPoint，缺失时用国际化通用名。
  // 分段条按 item.bytes / group.bytes 铺满。
  // 图例按 legend 顺序逐条列出分类。
  // roots 列表附在卡片底部，每条带 testId。
  const body = (
    <>
      <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
        <HardDrive className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <span className="truncate" title={label}>
          {label}
        </span>
      </div>
      <div
        className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-surface"
        aria-hidden="true"
      >
        {legend.map((item) =>
          group.bytes > 0 ? (
            <div
              key={item.id}
              className="h-full"
              style={{ width: `${(item.bytes / group.bytes) * 100}%`, backgroundColor: item.color }}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 text-ui-caption text-foreground-subtle">
        {intl.formatMessage(
          { id: "resourceManager.storage.diskUsage" },
          { used: formatBytes(group.bytes) },
        )}
        {" · "}
        {group.volume
          ? intl.formatMessage(
              { id: "resourceManager.storage.diskFree" },
              {
                free: formatBytes(group.volume.freeBytes),
                total: formatBytes(group.volume.totalBytes),
              },
            )
          : intl.formatMessage({ id: "resourceManager.storage.diskUnknown" })}
      </div>
      <ul className="mt-3 space-y-1.5">
        {legend.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-ui-base">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-foreground-subtle">
              {item.id === "rest"
                ? intl.formatMessage(
                    { id: "resourceManager.storage.legendMore" },
                    { count: item.restCount ?? 0 },
                  )
                : intl.formatMessage({ id: storageCategoryTitleId(item.id) })}
            </span>
            <span className="tabular-nums text-foreground">{formatBytes(item.bytes)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 border-t border-border pt-3">
        <div className="text-ui-caption font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "resourceManager.storage.roots" })}
        </div>
        <ul className="mt-1.5 space-y-1">
          {group.roots.map((root) => (
            <li
              key={root.id}
              data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_ROOT, root.id)}
              className="flex items-center gap-2 text-ui-caption"
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-foreground-subtle"
                title={root.path}
              >
                {root.path}
              </span>
              <span className="tabular-nums text-foreground">{formatBytes(root.bytes)}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
  // className 对 button 与 div 两种容器一致。
  // selectable 为 true 才加 cursor-pointer 与 hover 样式。
  // selected 且 selectable 才加 bg-card-selected 高亮。
  // className 用 cn 在渲染前算好。
  // 两种容器共用同一份 className。
  const className = cn(
    "w-full rounded-xl border border-card-border bg-card p-4 text-left",
    selectable && "cursor-pointer transition-colors hover:bg-surface-hover",
    selected && selectable && "bg-card-selected border-brand",
  );
  return selectable ? (
    <button
      type="button"
      data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_DISK_CARD, String(index))}
      data-selected={selected ? "true" : "false"}
      className={className}
      onClick={onSelect}
    >
      {body}
    </button>
  ) : (
    <div
      data-testid={testId(TID_RESOURCE_MANAGER_STORAGE_DISK_CARD, String(index))}
      className={className}
    >
      {body}
    </div>
  );
}
