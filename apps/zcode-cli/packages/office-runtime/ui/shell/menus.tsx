// 标题栏下拉菜单：切换文档（最近列表 + 打开入口）与更多操作（缩放、适配、重新加载等）。
// 边界：纯展示与意图派发，菜单开关由 Shell 的 menu 字段持有；不发起加载/缩放，也不读写存储。
// 副作用：无；所有动作经 props 回调回传，关闭统一通过 onClose 通知 Shell。
import type { DocKind } from "#office/contract.ts";
import type { Strings } from "#ui/i18n.ts";
import { FileType, Icon } from "#ui/icons.tsx";
import { baseName, dirName } from "#ui/rpc.ts";
import { Menu, MenuItem } from "#ui/shell/parts.tsx";
import type { FitMode } from "#ui/viewers/types.ts";

// 面板标题栏的两个下拉菜单（切换文档、更多操作），从 main.tsx 拆出以控制单文件规模，行为不变。
// 两个菜单都是纯展示 + 回调，不持有状态：开关由 Shell 的 menu 字段控制，关闭通过 onClose 回传。
// 所有可选项的点击只负责派发意图，加载/缩放等副作用由 Shell 执行。

// 切换文档菜单：先列最近打开（最多 5 条，含类型角标），再给“打开文件”入口。
// recent 为空时不渲染分组标题与分隔线，菜单只剩打开文件，符合空态语义。
// currentPath 用于标记当前项（勾选 + 只关闭不重载）。
export function SwitchMenu({
  t,
  recent,
  currentPath,
  onOpen,
  onBrowse,
  onClose,
}: {
  t: Strings;
  recent: { path: string; kind: DocKind }[];
  currentPath: string | undefined;
  onOpen(path: string): void;
  onBrowse(): void;
  onClose(): void;
}) {
  return (
    <Menu className="switcher" label={t.switchDocument} onClose={onClose}>
      {recent.length ? <div className="mlabel">{t.recent}</div> : null}
      {recent.map((item) => (
        // 选中当前文档只关菜单，避免重复加载并保住当前滚动位置。
        <MenuItem
          key={item.path}
          icon={<FileType kind={item.kind} />}
          hint={
            item.path === currentPath ? (
              <Icon name="check" size={16} />
            ) : (
              baseName(dirName(item.path))
            )
          }
          onSelect={() => (item.path === currentPath ? onClose() : onOpen(item.path))}
        >
          {baseName(item.path)}
        </MenuItem>
      ))}
      {recent.length ? <div className="msep" /> : null}
      <MenuItem icon={<Icon name="folder-open" size={16} />} onSelect={onBrowse}>
        {t.openFile}
      </MenuItem>
    </Menu>
  );
}

// 更多菜单：缩放组只对 zoomable 的查看器出现（pdf/docx），其余类型只有查找与刷新。
// zoomMode 为 null 表示当前是手动百分比，三个 fit 项都不打勾。
// 菜单项的状态由父组件持有，本组件不记忆选择；点击后只回调，定位仍走外壳统一样式。
export function MoreMenu({
  t,
  zoomable,
  zoomMode,
  onFit,
  onFind,
  onReload,
  onClose,
}: {
  t: Strings;
  zoomable: boolean;
  zoomMode: FitMode | null | undefined;
  onFit(mode: FitMode): void;
  onFind(): void;
  onReload(): void;
  onClose(): void;
}) {
  return (
    <Menu className="more" label={t.more} onClose={onClose}>
      {zoomable ? (
        <>
          <MenuItem checked={zoomMode === "width"} onSelect={() => onFit("width")}>
            {t.fitWidth}
          </MenuItem>
          <MenuItem checked={zoomMode === "page"} onSelect={() => onFit("page")}>
            {t.fitPage}
          </MenuItem>
          <MenuItem checked={zoomMode === "actual"} hint="100%" onSelect={() => onFit("actual")}>
            {t.actualSize}
          </MenuItem>
          <div className="msep" />
        </>
      ) : null}
      <MenuItem icon={<Icon name="search" size={16} />} hint="⌘F" onSelect={onFind}>
        {t.find}
      </MenuItem>
      <MenuItem icon={<Icon name="rotate-cw" size={16} />} onSelect={onReload}>
        {t.reload}
      </MenuItem>
    </Menu>
  );
}
