// INV-01 守住位置：55 行取到的 intl 是唯一文案入口，157 与 199 行的 message id 都要经它格式化；改错故障：把文案写死成英文串会让中文界面回退为英文，且丢失缺失 key 的告警路径。
// INV-02 守住位置：56 行 diffPreviewPlan 由 getGitPaneDiffPreviewPlan 对 diffState 做纯派生，只登记在 useMemo；改错故障：把 plan 落到组件状态后，diffState 换引用时会残留一帧旧 plan，展开面板显示上一个文件的预览。
// INV-03 守住位置：57 行起的 multiFileDiffFiles 依赖数组只列 change 与 diffState 的五个字段，不列整个对象；改错故障：塞进扩散对象依赖会让每次父级渲染都重算并新建文件对，大 diff 的浅比较永久失效。
// INV-04 守住位置：58 行用 availability 与 afterContent 双条件判定能否构造 before/after 文件对；改错故障：只看 availability 会在 afterContent 为 null 时把空内容送进 DiffViewer，展开即空白或抛错。
// INV-05 守住位置：68 与 73 行 cacheKey 由 path、长度、首尾片段拼成，参与 DiffViewer 的缓存比对；改错故障：cacheKey 退化为只用 path，会让同名文件的不同版本复用旧高亮，用户看到过期的着色结果。
// INV-06 守住位置：88 到 125 行只用一个 button 承载整行 header，内部不得再放可聚焦控件；改错故障：内层再加按钮会形成嵌套交互，点击命中错误目标，展开态出现来回抖动。
// INV-07 守住位置：90 行 aria-expanded 直接取 isExpanded，95 行 onClick 只上报 nextOpen，不在本地翻转；改错故障：按钮内再存一份展开状态会与父级冲突，键盘激活与鼠标点击得到相反结果。
// INV-08 守住位置：92 行 sticky 与 z-10 挂在按钮上，滚动容器放在 154 行展开区；改错故障：把 sticky 上提或下移会让文件头在横向滚动时错位，甚至压住 diff 首行。
// INV-09 守住位置：127 到 151 行菜单项的 disabled 取决于 canRevealInFileManager 与 onRevealInFileTree；改错故障：禁用条件写成恒真会在平台不支持定位时仍可点，操作静默失败且无反馈。
// INV-10 守住位置：144 到 150 行在树定位回调缺失时仍渲染该项但置灰，不隐藏；改错故障：改为条件隐藏会让菜单项数量随平台变化，同一操作入口位置不稳定。
// INV-11 守住位置：153 行只有 isExpanded 为真才挂载 154 行容器；改错故障：常挂载再靠样式隐藏会让 Review 打开时同时创建几十个 diff 组件，主线程集中卡在提交阶段。
// INV-12 守住位置：155 行加载态判断位于所有 availability 分支之前；改错故障：把加载态放到 patch 判断之后会先渲染一帧兜底文案，再跳到 diff，出现空态闪烁。
// INV-13 守住位置：159 行 plain-text 分支排在 patch 与 before/after 分支之前；改错故障：顺序颠倒会让超大 patch 走进富渲染，点击后同步解析占满主线程。
// INV-14 守住位置：166 到 180 行 patch 分支只传 patch 字符串，高亮交给 worker 异步完成；改错故障：改回传 before/after 会同步比较整文件，大文件展开明显掉帧。
// INV-15 守住位置：181 到 196 行要求 afterContent 非空且 multiFileDiffFiles 已构造才进入该分支；改错故障：放宽任一条件会在删除或二进制变更时读到 null，diff 区域直接崩溃。
// INV-16 守住位置：197 到 203 行是唯一兜底文案出口，message id 由 availability 映射；改错故障：去掉兜底会让不可用状态渲染成空白，用户误以为还在加载。
// INV-17 守住位置：210 到 225 行子组件只做透传，不持有状态、不二次解析行数据；改错故障：在子组件里另起解析会重复消费行数组，与右侧 DiffViewer 的行号样式分叉。
// INV-18 守住位置：49 到 53 行的回调入参恒为 change，组件不直接访问服务或仓库；改错故障：组件内取服务会绕过 hook 注入边界，Web 端缺实现时整张卡片不可用。
//
// 模块职责：把单条 Git 文件变更渲染为可展开行，负责 header、右键菜单、diff 预览分支与兜底文案。
// 状态所有权：展开态、加载态、diff 数据与可定位能力全部来自 props，组件只持 memo 派生的展示投影。
// 阅读顺序：先看 55 到 82 行的派生，再看 84 到 152 行的 header 与菜单，最后看 153 到 208 行的渲染分支与子组件。
import { useMemo } from "react";
import type { GitDiffResult } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, FolderOpenIcon, ListTreeIcon } from "lucide-react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { getDiffFallbackMessageId, getGitPaneDiffPreviewPlan } from "@/GitPane/helpers.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { ResolvedTheme } from "@/useTheme.js";
import { LightweightDiffPreview } from "@/components/ui/lightweight-diff-preview.js";

export function GitPaneChangeCard({
  change,
  contextMenuLabels,
  diffState,
  isDiffLoading,
  isExpanded,
  canRevealInFileManager,
  codePreviewSettings,
  resolvedTheme,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onOpenChange,
  onRevealInFileManager,
  onRevealInFileTree,
}: {
  change: GitPaneFileChange;
  contextMenuLabels: {
    copyAbsolutePath: string;
    copyRelativePath: string;
    revealInFileManager: string;
    revealInFileTree: string;
  };
  diffState: GitDiffResult | null;
  isDiffLoading: boolean;
  isExpanded: boolean;
  canRevealInFileManager: boolean;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: ResolvedTheme;
  onCopyAbsolutePath: (change: GitPaneFileChange) => void;
  onCopyRelativePath: (change: GitPaneFileChange) => void;
  onOpenChange: (change: GitPaneFileChange, nextOpen: boolean) => void;
  onRevealInFileManager: (change: GitPaneFileChange) => void;
  onRevealInFileTree?: (change: GitPaneFileChange) => void;
}) {
  // intl 是组件的唯一文案来源，加载态与兜底态都经它格式化
  // props 里的 contextMenuLabels 只覆盖菜单文案，不接管通用提示
  // 缺失 key 由 IntlProvider 统一暴露，本卡不做英文兜底
  // 把 id 改成内联字符串会让多语言与告警链路同时失效
  const { intl } = useZCodeIntl();
  // diffPreviewPlan 是 diffState 的纯投影，kind 决定下面走轻量预览还是富 diff
  // 只依赖 diffState 引用，父级因展开态重渲染时不会重算
  // 不把 plan 写回 store，也不在渲染期再算一次行数阈值
  const diffPreviewPlan = useMemo(() => getGitPaneDiffPreviewPlan(diffState), [diffState]);
  // 这里为 before/after 模式预制文件对，供 DiffViewer 做浅比较
  // 依赖数组刻意只列 change 与 diffState 的五个字段，避免整对象替换触发重算
  // cacheKey 混入 path、长度与首尾片段，让同名文件的不同版本得到不同键
  // 返回 null 表示不具备构造条件，渲染分支据此回退到 patch 或兜底
  const multiFileDiffFiles = useMemo(() => {
    if (diffState?.availability !== "patch" || diffState.afterContent === null) {
      return null;
    }

    // DiffViewer 是 memo 组件，oldFile/newFile 如果在 JSX 里内联创建，
    // 父级任意刷新都会让大 diff 视图浅比较失效。
    return {
      oldFile: {
        name: change.workspaceRelativePath,
        contents: diffState.beforeContent ?? "",
        cacheKey: `old:${diffState.path}:${diffState.beforeContent?.length ?? 0}:${diffState.beforeContent?.slice(0, 100) ?? ""}:${diffState.beforeContent?.slice(-100) ?? ""}`,
      },
      newFile: {
        name: change.workspaceRelativePath,
        contents: diffState.afterContent,
        cacheKey: `new:${diffState.path}:${diffState.afterContent.length}:${diffState.afterContent.slice(0, 100)}:${diffState.afterContent.slice(-100)}`,
      },
    };
  }, [
    change.workspaceRelativePath,
    diffState?.afterContent,
    diffState?.availability,
    diffState?.beforeContent,
    diffState?.path,
  ]);

  return (
    <div className="w-full min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-expanded={isExpanded}
            className={cn(
              "sticky top-0 z-10 flex h-8 w-full items-center gap-3 bg-background px-3 text-left transition-colors hover:bg-surface-hover supports-[backdrop-filter]:backdrop-blur-sm",
              isExpanded && "bg-surface-hover",
            )}
            // 点击只上报期望的下一个展开态，不在本组件翻转任何状态
            // 真正的展开集合由父级持有，避免同一行存在两份真相
            // 连点由父级按幂等处理，这里不做去重也不做节流
            onClick={() => onOpenChange(change, !isExpanded)}
          >
            {/* Review 打开会一次性挂载几十个可视/overscan 行；每行都用 Radix Collapsible
                会额外创建 provider/presence 和测量链路，CDP CPU profile 里 click 后主线程集中耗在
                React 提交阶段。这里改成普通按钮 + 仅展开行渲染内容，保留交互同时减少打开成本。 */}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <FileDisplayInline
                  path={change.workspaceRelativePath}
                  options={{
                    showFilePath: true,
                    className: "inline-flex min-w-0 max-w-full items-center gap-2",
                    fileNameClassName: "truncate text-ui-base text-foreground",
                    filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                  }}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-3 pl-3">
              <div className="shrink-0 whitespace-nowrap text-ui-base">
                <span className="text-diff-added">+{change.added}</span>
                <span className="ml-2 text-diff-removed">-{change.removed}</span>
              </div>
              <ChevronDownIcon
                className={cn(
                  "size-4 shrink-0 text-foreground-subtle transition-transform",
                  isExpanded && "rotate-180",
                )}
              />
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem
            disabled={!canRevealInFileManager}
            onSelect={() => onRevealInFileManager(change)}
          >
            <FolderOpenIcon className="size-4" />
            {contextMenuLabels.revealInFileManager}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyAbsolutePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyAbsolutePath}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyRelativePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyRelativePath}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!onRevealInFileTree}
            onSelect={() => onRevealInFileTree?.(change)}
          >
            <ListTreeIcon className="size-4" />
            {contextMenuLabels.revealInFileTree}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded ? (
        <div className="w-full min-w-0 overflow-x-auto overflow-y-hidden bg-background">
          {isDiffLoading ? (
            <div className="flex items-center justify-center py-4 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          // 分支顺序是加载、轻量预览、patch 富渲染、before/after、兜底
          // 轻量预览面向超大 patch，先给出 hunk 行而不是整文件比较
          // 提前到此分支可避免富渲染在主线程同步解析
          // 调整顺序前需确认 getGitPaneDiffPreviewPlan 返回的 kind 语义
          ) : diffState?.availability === "patch" && diffPreviewPlan.kind === "plain-text" ? (
            <div className="w-full min-w-0">
              <GitPanePlainTextDiffPreview
                lines={diffPreviewPlan.lines}
                codePreviewSettings={codePreviewSettings}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffPreviewPlan.kind === "patch" &&
            diffState.patch ? (
            <div className="w-full min-w-0">
              {/* 大文件展开只需要先看到变更 hunk。继续走 before/after 的 MultiFileDiff
                会同步比较整文件并拖慢点击反馈；这里改走 patch 输入，让高亮继续由 worker 异步完成。 */}
              <DiffViewer
                patch={diffState.patch}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffState.afterContent !== null &&
            multiFileDiffFiles ? (
            <div className="w-full min-w-0">
              {/* 手机远控右侧栏宽度较窄，展开的文件 diff 不能依赖父级隐藏溢出。
                外层允许横向滚动，长行 diff 才不会在窄屏被裁掉。 */}
              <DiffViewer
                oldFile={multiFileDiffFiles.oldFile}
                newFile={multiFileDiffFiles.newFile}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : (
            // 兜底分支覆盖不可用、二进制与空结果，文案 id 由 availability 映射
            // 这是唯一展示不可用原因的位置，不向上抛错也不静默吞掉
            // 去掉兜底会让异常状态渲染成空白，用户无法分辨是否仍在加载
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: getDiffFallbackMessageId(diffState?.availability ?? "unavailable"),
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GitPanePlainTextDiffPreview({
  lines,
  codePreviewSettings,
}: {
  lines: readonly string[];
  codePreviewSettings: CodePreviewSettings;
}) {
  // 超大 patch 或深 hunk 进入富 diff 渲染会把主线程耗在同步解析/DOM 构建上。
  // 轻量 hunk 预览复用共享 diff 行号/gutter 样式，避免和右侧 DiffViewer 视觉分叉。
  return (
    <LightweightDiffPreview
      codePreviewSettings={codePreviewSettings}
      data-git-plain-text-diff-preview
      lines={lines}
    />
  );
}
