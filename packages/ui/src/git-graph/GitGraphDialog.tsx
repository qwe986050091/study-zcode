// INV-01 模块只渲染 Git 提交图对话框，数据全部经 useServices 注入的 gitService 读取，不直接触达仓库；守住位置：组件与服务之间的依赖注入边界；改错故障：直连仓库会让 Desktop 与 Web 两个平台实现分叉。
// INV-02 open 为 false 时不发起任何请求，由 useEffect 的早返回把守；守住位置：副作用入口的第一道闸门；改错故障：对话框关闭后仍会产生幽灵请求并污染状态。
// INV-03 首屏加载前先清空 commits、hasMore、selectedCommitHash，守住切换工作区时的干净起点；改错故障：上一个仓库的提交会残留并被误选中。
// INV-04 页宽常量同时用于首屏与翻页的 maxCount，守住单一分页节奏；改错故障：两处数值不一致会让 skip 与列表长度错位。
// INV-05 翻页偏移取已加载条数，守住「列表长度即下一次 skip」这一不变量；改错故障：偏移写死或按页序号推算会重复或漏读提交。
// INV-06 loadingMoreRef 是同步哨兵且先于状态置位，守住并发去重；改错故障：快速滚动会触发多条并发翻页并重复追加。
// INV-07 hasMore 为 false 时翻页立即早返回，守住列表末端；改错故障：末端之后继续请求只会拿到空页并反复刷新界面。
// INV-08 loading、loadingMore、refreshing 三态互斥使用，守住同一时刻只有一条读取链路；改错故障：刷新与翻页交叉写 commits 会互相覆盖。
// INV-09 首屏与刷新成功后都把选中项落到最新提交，守住选中值与列表同源；改错故障：选中 hash 可能指向已不存在的提交。
// INV-10 首屏失败走内联 errorMessage，守住整屏可重试的错误视图；改错故障：用户只看到空白面板而不知道失败原因。
// INV-11 刷新失败只发 toast 且不清空既有 commits，守住旧数据的可用性；改错故障：一次网络抖动就会清空整张提交图。
// INV-12 翻页失败走内联错误并保留已加载数据，守住渐进加载语义；改错故障：已读内容被丢弃，用户需要从头再滚一次。
// INV-13 首屏请求的 finally 必然复位 loading，守住加载态不可悬挂；改错故障：抛错后骨架屏会永久停留。
// INV-14 翻页的 finally 同时复位 ref 与 loadingMore，守住守卫与界面同步释放；改错故障：后续翻页会被永久拦截。
// INV-15 关闭对话框先复位内部状态再上抛 onOpenChange，守住关闭即释放；改错故障：重开时会带着上次的加载态与错误文案。
// INV-16 三条读取回调都把 workspacePath 与 gitService 放进依赖，守住工作区切换后的闭包新鲜度；改错故障：旧工作区的结果会写进新面板。
// INV-17 面向用户的错误文案统一经 intl 取 gitGraph 命名空间，守住国际化；改错故障：硬编码文案在非中文环境失效。
// INV-18 内容区按 loading、errorMessage、GitGraphPane 的优先级互斥渲染，守住三视图互斥；改错故障：错误与内容会同屏或 loader 覆盖内容。
//
// 模块职责：Git 提交图对话框，按页向 gitService 读取提交，持有列表、分页游标、加载态与选中项，并把加载、错误、内容三种视图分派给 GitGraphPane。
// 状态所有权：commits、hasMore、三种加载态与 selectedCommitHash 均由本组件局部持有，服务层只提供读请求，不在这里缓存第二份仓库事实。
// 阅读顺序：先看 GIT_GRAPH_PAGE_SIZE 与 resetGraphState，再看 loadInitialCommits、refreshCommits、loadMoreCommits 三条读取链路，最后看关闭复位与渲染优先级。
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCommitGraphCommit } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { GitGraphPane } from "@/git-graph/GitGraphPane.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { AlertCircleIcon, LoaderIcon, XIcon } from "lucide-react";

interface GitGraphDialogProps {
  open: boolean;
  workspacePath: string;
  onOpenChange: (nextOpen: boolean) => void;
}

// 页宽常量：首屏与翻页共用同一个 maxCount，调整分页节奏只需改这一处。
// 必须与 skip 语义配套理解：skip 从 0 起按已加载条数递增，页宽变化不影响偏移正确性。
// 改错故障：若首屏与翻页各写死不同数值，偏移会与列表实际长度错位，出现重复或漏读提交。
// 该常量只出现在请求参数里，不进入 React 状态，避免被误当成可响应式配置。
// 对外契约：getCommitGraph 必须同时返回 commits 与 hasMore，缺任一项列表就无法判断是否还有下一页。
const GIT_GRAPH_PAGE_SIZE = 50;

export function GitGraphDialog({ open, workspacePath, onOpenChange }: GitGraphDialogProps) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommitGraphCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  // ref 是同步哨兵，赋值立即生效、不经历状态批次，专门用来挡住同一帧内的重复翻页。
  // 仅靠 loadingMore 状态无法防重入：状态更新被批处理，快速滚动会连续触发 onLoadMore。
  // 置位发生在发请求之前，复位放在 finally，保证异常路径也能释放守卫。
  // 改错故障：把守卫退化成纯状态判断，会出现并发请求与重复追加，列表里出现重复提交。
  // 不要把 ref 当渲染数据源，它只表达「是否已有翻页在途」，不驱动任何 UI。
  const loadingMoreRef = useRef(false);

  // 关闭对话框的统一清理入口：三种加载态、翻页哨兵与错误文案一次性归零。
  // 刻意不清空 commits 与 selectedCommitHash，重开时由首屏加载覆盖，避免关闭瞬间闪白。
  // 依赖数组为空，回调身份稳定，可安全挂在 Dialog 的关闭路径上。
  // 改错故障：漏复位 loadingMoreRef，重开后第一次翻页会被永久拦下。
  // 改错故障：漏清 errorMessage，重开时会先闪一次上次的失败提示。
  const resetGraphState = useCallback(() => {
    setLoading(false);
    setLoadingMore(false);
    setRefreshing(false);
    loadingMoreRef.current = false;
    setErrorMessage(null);
  }, []);

  // 首屏加载先复位全部状态再发请求，保证切换 workspacePath 后不残留上一仓库的列表与选中项。
  // 请求参数固定 skip 为 0、页宽取常量，语义是「从来头重新读一页」。
  // 成功路径同时写入 commits 与 hasMore，并把选中项落到最新提交，避免出现空选中。
  // 失败路径用 getErrorMessage 的结果组装 gitGraph.error.requestFailed 文案，保留可重试的内联错误态。
  // finally 必然复位 loading，否则请求抛错后骨架屏会永久停留。
  const loadInitialCommits = useCallback(async () => {
    setLoading(true);
    setLoadingMore(false);
    setRefreshing(false);
    loadingMoreRef.current = false;
    setErrorMessage(null);
    setCommits([]);
    setHasMore(false);
    setSelectedCommitHash(null);

    try {
      const result = await gitService.getCommitGraph({
        workspacePath,
        maxCount: GIT_GRAPH_PAGE_SIZE,
        skip: 0,
      });
      setCommits(result.commits);
      setHasMore(result.hasMore);
      setSelectedCommitHash(result.commits[0]?.hash ?? null);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitGraphDialog] 读取 Git Graph 失败", {
        workspacePath,
        error: message,
      });
      setErrorMessage(
        intl.formatMessage({ id: "gitGraph.error.requestFailed" }, { error: message }),
      );
    } finally {
      setLoading(false);
    }
  }, [gitService, intl, workspacePath]);

  // 副作用只承担「打开时拉首屏」一件事，open 为 false 时立即早返回，关闭状态绝不发请求。
  // 依赖里放 loadInitialCommits 而不是 workspacePath，因为回调已把 gitService、intl、workspacePath 收敛为自身依赖。
  // 因此 workspacePath 变化会产生新的回调身份，进而自动触发一次新的首屏加载。
  // 改错故障：把 loadInitialCommits 从依赖中删掉，切换仓库后仍会读旧闭包里的路径。
  // 这里用 void 显式丢弃 Promise，表明不等待也不消费返回值。
  useEffect(() => {
    if (!open) {
      return;
    }

    void loadInitialCommits();
  }, [loadInitialCommits, open]);

  // `refreshCommits` 重新读第一页：成功后整体替换列表并重置选中项，不做增量合并。
  // 入口只要三种加载态任一为真就早返回，防止刷新与首屏、翻页交叉写入同一份 commits。
  // 失败只发 toast 并保留旧列表，刷新失败不应该把用户已看到的图清空。
  // 与 `loadInitialCommits` 的差异有意为之：首屏无内容用内联错误，刷新有内容用轻提示。
  // 依赖包含 loading、loadingMore、refreshing，保证守卫读到的是最新状态而非过期快照。
  const refreshCommits = useCallback(async () => {
    if (loading || loadingMore || refreshing) {
      return;
    }

    setRefreshing(true);
    setErrorMessage(null);

    try {
      const result = await gitService.getCommitGraph({
        workspacePath,
        maxCount: GIT_GRAPH_PAGE_SIZE,
        skip: 0,
      });
      setCommits(result.commits);
      setHasMore(result.hasMore);
      setSelectedCommitHash(result.commits[0]?.hash ?? null);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitGraphDialog] 刷新 Git Graph 失败", {
        workspacePath,
        error: message,
      });
      toast(intl.formatMessage({ id: "gitGraph.refreshFailed" }, { error: message }));
    } finally {
      setRefreshing(false);
    }
  }, [gitService, intl, loading, loadingMore, refreshing, workspacePath]);

  // 翻页偏移取当前已加载条数，配合后端 skip 语义实现「接着往后读」。
  // 入口同时检查三种加载态、ref 哨兵与 hasMore，任一命中即早返回，避免末端空请求与并发翻页。
  // 成功用函数式更新把新页追加到旧列表，规避闭包里 commits 过期导致的整体覆盖。
  // 失败保留已加载数据并写内联错误，让用户仍能阅读既有提交图。
  // finally 先复位 ref 再复位 loadingMore，保证守卫不会长期处于置位而锁死翻页。
  const loadMoreCommits = useCallback(async () => {
    if (loading || loadingMore || refreshing || loadingMoreRef.current || !hasMore) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setErrorMessage(null);

    try {
      const result = await gitService.getCommitGraph({
        workspacePath,
        maxCount: GIT_GRAPH_PAGE_SIZE,
        skip: commits.length,
      });
      setCommits((currentCommits) => [...currentCommits, ...result.commits]);
      setHasMore(result.hasMore);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitGraphDialog] 读取更多 Git Graph 失败", {
        workspacePath,
        loadedCommitCount: commits.length,
        error: message,
      });
      setErrorMessage(
        intl.formatMessage({ id: "gitGraph.error.requestFailed" }, { error: message }),
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [commits.length, gitService, hasMore, intl, loading, loadingMore, refreshing, workspacePath]);

  return (
    <Dialog
      open={open}
      // 对话框开关的唯一出口：关闭时先复位内部状态，再把新值上抛给父组件。
      // 复位必须排在 onOpenChange 之前，保证父组件重新渲染时看到的是已清理的局部状态。
      // 只在 nextOpen 为 false 时清理，打开动作交给 useEffect 的首屏加载，避免重复请求。
      // 改错故障：调换两行顺序，重开瞬间可能带着上次的 loading 或错误文案渲染一帧。
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          resetGraphState();
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="h-[min(78vh,720px)] max-w-5xl gap-0 overflow-hidden rounded-2xl p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{intl.formatMessage({ id: "gitGraph.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "gitGraph.dialogDescription" })}
          </DialogDescription>
        </DialogHeader>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "common.close" })}
            className="absolute right-2 top-2 z-30 bg-background/80 text-foreground-subtle hover:bg-hover hover:text-foreground [app-region:no-drag]"
          >
            <XIcon className="size-3.5" />
          </Button>
        </DialogClose>
        {loading ? (
          <div className="flex h-full items-center justify-center bg-background text-foreground-subtle">
            <LoaderIcon className="size-5 animate-spin" />
          </div>
        ) : errorMessage ? (
          <div className="flex h-full items-center justify-center bg-background p-6">
            <div className="max-w-md rounded-xl border border-border bg-card p-4 text-ui-base text-foreground">
              <div className="flex items-start gap-3">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                <p className="break-words text-foreground-subtle">{errorMessage}</p>
              </div>
            </div>
          </div>
        ) : (
          <GitGraphPane
            commits={commits}
            hasMore={hasMore}
            loadingMore={loadingMore}
            refreshing={refreshing}
            selectedCommitHash={selectedCommitHash}
            onSelectCommit={setSelectedCommitHash}
            onLoadMore={loadMoreCommits}
            onRefresh={refreshCommits}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
