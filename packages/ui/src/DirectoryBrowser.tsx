// ZCode Web 端服务端目录浏览组件 DirectoryBrowser：本文件是 UI 侧唯一入口。
// 职责：调用 fileService.readdir 逐层读取服务器目录，过滤出子目录并渲染列表，
//       最终把用户确认的绝对路径通过 onSelect 交回上层，或经 onPathChange 通知宿主。
// 适用场景：Web 端拿不到系统原生文件选择器，只能由后端代读目录结构。
// 所有导出的辅助函数都是纯函数，便于单测；只有组件内部持有可变请求状态。
//
// 不变量清单（每条标注守卫点与破坏后的具体故障）：
// INV-01 列表只含目录：filterDirectoryBrowserEntries 是唯一过滤点，只放行 type 为 directory 的条目。
//         守卫点是该 filter 的谓词；若放开文件项，选择语义退化为选任意文件路径，上层会把文件当工作区根。
// INV-02 隐藏开关的三元语义：createDirectoryBrowserReadParams 在关闭时完全省略 includeHidden 键。
//         守卫点正是这个参数构造函数；若改成显式传 false，旧服务端按“存在该键”理解，隐藏目录仍会返回。
// INV-03 图标类型不影响路径：getDirectoryBrowserEntryIconKind 只选图标，不得改动 entry.path。
//         守卫点是它的入参 Pick 只含 isSymbolicLink 与 type；若在此处解析链接，确认路径会与显示名不一致。
// INV-04 符号链接图标双条件：必须同时满足 type 为 directory 且 isSymbolicLink 为 true 才算符号链接目录。
//         守卫点在同一三元表达式；若只看 isSymbolicLink，普通文件链接会被画成目录图标并误导点击。
// INV-05 请求编号单调递增：createDirectoryBrowserRequestGuard 的 begin 只增不减，从不回绕。
//         守卫点是闭包里的 latestRequestId；若允许重置或复用编号，迟到的旧响应会被误判为最新而覆盖列表。
// INV-06 落地前必须验号：navigateTo 在 await readdir 之后、任何 setState 之前先调 isCurrent 校验。
//         守卫点是成功分支与失败分支各自的早退；漏掉任一处，过期结果会把新目录的 entries 覆盖成旧目录内容。
// INV-07 loading 归属最新请求：finally 里只有 isCurrent 成立才 setLoading 为 false。
//         守卫点是 finally 的 if 包裹；若无条件关闭，旧请求先返回会把还在飞的导航当成已完成，按钮提前可点。
// INV-08 请求路径先记账：navigateTo 第一行就写 requestedPathRef，早于任何 await 与状态更新。
//         守卫点是函数首行赋值；若挪到 await 之后，父层复读同一路径会被判成新请求，形成重复读取。
// INV-09 父层导航幂等：父层 effect 仅在 initialPath 变化或 navigationRevision 变化时才继续。
//         守卫点是双条件判断与 appliedNavigationRevisionRef；若只比路径，同路径重复点击 chip 不会重新读取。
// INV-10 版本号先消费再导航：appliedNavigationRevisionRef 在调用导航前写入当前 revision。
//         守卫点是赋值顺序；若放在导航之后，失败重试时同一 revision 会被认为已消费，chip 点击变成空操作。
// INV-11 首次装载只跑一次：初始化 effect 的依赖数组为空，忽略 exhaustive-deps 告警是刻意为之。
//         守卫点是空依赖与上方 eslint 禁用行；若把 services 加入依赖，每次父层重渲染都会重新拉取并重置路径。
// INV-12 卸载即作废旧票据：清理函数把 disposed 置真并调用 begin 抬高新编号。
//         守卫点是 return 的清理闭包；若只置 disposed，home 请求的 then 仍可能以旧票通过并改写已恢复会话的目录。
// INV-13 初始路径优先：存在 initialPath 时直接导航，不再请求 systemService 的 homedir。
//         守卫点是初始化 effect 的 if 分支；若两者都执行，homedir 的迟到响应会覆盖调用方指定的起始目录。
// INV-14 错误文案优先级：展示优先用调用方传入的 formatError，其次才回落到 i18n 文案。
//         守卫点是空值合并；若颠倒顺序，宿主自定义的错误翻译（如权限不足提示）会被通用文案覆盖。
// INV-15 导航开始即清错：setLoading 为 true 的同时把 error 清空，避免旧错误与新加载态并存。
//         守卫点在 try 之前两行；若不清空，上一目录的“不可访问”提示会压在新目录列表上方持续误导。
// INV-16 隐藏开关以 ref 为准：handleToggleHiddenDirectories 先读 showHiddenDirectoriesRef 再翻转。
//         守卫点是该 ref 的写入；若改读 state，连续快速点击会在同一渲染帧内基于旧值翻转，开关与实际请求相反。
// INV-17 切换与重读同参：翻转后的值既写入 ref 与 state，也作为 navigateTo 的第二参数直接传入。
//         守卫点是显式传参；若省略让 navigateTo 回读 ref，时序错位时可能读到旧值，列表与按钮高亮不一致。
// INV-18 确认按钮三重门禁：handleSelectCurrentPath 要求路径非空、未加载、未提交。
//         守卫点是函数开头的 return；若去掉 loading 判断，用户会在目录切换途中把旧路径交回上层。
// INV-19 上级路径解析：handleGoUp 用正则剥掉最后一段，剥空时回落为根斜杠。
//         守卫点是 replace 与或运算；若只删尾部斜杠或不做根回落，在根目录会得到空串并触发无意义 readdir。
// INV-20 嵌入与弹窗分流：embedded 为真时只渲染内容区，按 showSelectionActions 决定是否带 footer。
//         守卫点是提前 return 的分支；若两条路径都渲染遮罩，内嵌面板会盖住整个编辑器并吞掉点击。
import { useEffect, useState, useRef, useEffectEvent } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { FileEntry } from "@zcode/shared";
import { FolderIcon, FolderSymlinkIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";

export function createDirectoryBrowserReadParams(
  path: string,
  showHiddenDirectories: boolean,
): { path: string; includeHidden?: boolean } {
  return showHiddenDirectories ? { path, includeHidden: true } : { path };
}

export function filterDirectoryBrowserEntries(entries: FileEntry[]): FileEntry[] {
  return entries.filter((e) => e.type === "directory");
}

// 修复原因：远程目录条目已经携带 isSymbolicLink，这里只替换展示图标，不改变进入和选择目录的路径语义。
export function getDirectoryBrowserEntryIconKind(
  entry: Pick<FileEntry, "isSymbolicLink" | "type">,
): "folder" | "folder-symlink" {
  return entry.type === "directory" && entry.isSymbolicLink === true ? "folder-symlink" : "folder";
}

export function createDirectoryBrowserRequestGuard(): {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
} {
  let latestRequestId = 0;

  return {
    begin: () => {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent: (requestId: number) => requestId === latestRequestId,
  };
}

/**
 * 服务端目录浏览对话框。
 * 通过 fileService.readdir 浏览远程/本地服务器的目录结构，
 * 适用于 web 端无法调用系统原生文件选择器的场景。
 */
export function DirectoryBrowser({
  services,
  onSelect,
  onCancel,
  onPathChange,
  initialPath,
  onNavigationStateChange,
  navigationRevision = 0,
  embedded = false,
  showSelectionActions = false,
  selectLabel,
  selecting,
  formatError,
}: {
  services: {
    fileService: Pick<IServiceAccessor["fileService"], "readdir">;
    systemService: { info(): Promise<{ homedir: string }> };
  };
  onSelect: (path: string) => void;
  onCancel: () => void;
  onPathChange?: (path: string) => void;
  initialPath?: string;
  onNavigationStateChange?: (ready: boolean) => void;
  navigationRevision?: number;
  embedded?: boolean;
  showSelectionActions?: boolean;
  selectLabel?: string;
  selecting?: boolean;
  formatError?: (error: unknown) => string;
}) {
  // [资源] 六份 state 加五个 ref 都是实例级：挂载时从空路径与 loading 起步，卸载即丢弃。
  // [并发] showHiddenDirectoriesRef 是伪同步真值源，state 只让按钮样式重渲染，两者总成对写入。
  // [资源] requestGuardRef 用惰性初始化只造一个计数器闭包，避免重渲染换票导致在飞请求全部作废。
  const [currentPath, setCurrentPath] = useState("");
  const [inputPath, setInputPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showHiddenDirectories, setShowHiddenDirectories] = useState(false);
  const requestedPathRef = useRef("");
  const appliedNavigationRevisionRef = useRef(navigationRevision);
  const listRef = useRef<HTMLDivElement>(null);
  const showHiddenDirectoriesRef = useRef(false);
  const requestGuardRef = useRef(createDirectoryBrowserRequestGuard());
  const { intl } = useZCodeIntl();

  // 同一向导收起后会重建浏览器实例；卸载必须撤销旧请求，不能让迟到结果改写恢复后的目录。
  // [并发] 初始化先领一张门票再决定起始目录：有 initialPath 就直接导航，否则读 homedir 后导航。
  // [失败路径] systemService.info 走 catch 时先复核 disposed 与门票，再写错误并收掉 loading，杜绝已卸载实例改状态。
  // [资源] 清理函数把 disposed 置真并再领一张票，让所有在飞的 then 与 catch 立刻过期。
  // [权衡] 依赖数组刻意为空并禁用 exhaustive-deps：services 与 formatError 视为挂载期固定契约。
  // [失败路径] 若上层在重挂载后传入不同的 services，本 effect 不会重跑，需靠 navigationRevision 驱动重新导航。
  useEffect(() => {
    let disposed = false;
    const homeRequestId = requestGuardRef.current.begin();
    if (initialPath) {
      void navigateTo(initialPath);
    } else {
      void services.systemService
        .info()
        .then((info) => {
          if (!disposed && requestGuardRef.current.isCurrent(homeRequestId))
            void navigateTo(info.homedir);
        })
        .catch((err) => {
          if (disposed || !requestGuardRef.current.isCurrent(homeRequestId)) return;
          logger.error("[DirectoryBrowser] 获取系统信息失败:", err);
          setError(
            formatError?.(err) ?? intl.formatMessage({ id: "directoryBrowser.errorSystem" }),
          );
          setLoading(false);
        });
    }
    return () => {
      disposed = true;
      requestGuardRef.current.begin();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // [事务] navigateTo 把记账、领票、进入 loading、清错四步在首个 await 之前同步做完，构成一次导航的提交点。
  // [并发] requestedPathRef 首行即写：它代表最后一次发出的导航意图，先于任何异步结果，父层 effect 以此判重。
  // [事务] 成功分支按固定顺序提交：先过滤目录，再写 entries、currentPath、inputPath，随后外抛 onPathChange 与就绪。
  // [权衡] 先写 entries 再写路径，渲染间隙可能新列表配旧路径，但 React 同批合并，用户看不到中间态。
  // [失败路径] 失败分支复用同一张票校验，过期错误只打日志不写状态，避免旧目录的错误压在新列表上。
  // [资源] 滚动复位依赖 listRef 已挂载，用可选链兜底，首次导航时列表尚未渲染也不会抛错。
  // [失败路径] finally 只在持票时关闭 loading，否则旧请求的收尾会把正在飞的新导航提前标记为完成。
  const navigateTo = async (
    path: string,
    nextShowHiddenDirectories = showHiddenDirectoriesRef.current,
  ) => {
    requestedPathRef.current = path;
    const requestId = requestGuardRef.current.begin();
    onNavigationStateChange?.(false);
    setLoading(true);
    setError("");
    try {
      const result = await services.fileService.readdir(
        createDirectoryBrowserReadParams(path, nextShowHiddenDirectories),
      );
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      const dirs = filterDirectoryBrowserEntries(result);
      setEntries(dirs);
      setCurrentPath(path);
      setInputPath(path);
      onPathChange?.(path);
      onNavigationStateChange?.(true);
      // 滚动到顶部
      listRef.current?.scrollTo(0, 0);
    } catch (err) {
      if (!requestGuardRef.current.isCurrent(requestId)) {
        return;
      }
      // 用户快速切换目录或隐藏目录时，较早 readdir 可能后返回；
      // 过期错误不能覆盖最新导航状态，否则 UI 会展示和当前按钮状态不一致的目录/错误。
      logger.error("[DirectoryBrowser] readdir 失败:", err);
      setError(
        formatError?.(err) ?? intl.formatMessage({ id: "directoryBrowser.errorUnavailable" }),
      );
    } finally {
      if (requestGuardRef.current.isCurrent(requestId)) {
        setLoading(false);
      }
    }
  };

  // [并发] 用 useEffectEvent 包一层，让父层触发的导航始终读到最新闭包，而不把函数塞进依赖数组。
  // [事务] 父层 effect 的判重条件是路径变了或 revision 变了，两者满足其一才视为新导航请求。
  // [权衡] appliedNavigationRevisionRef 在导航前写入，保证同路径同版本的重复渲染不会二次读盘。
  // [失败路径] 导航失败时该 revision 已被消费，父层若想重试必须递增 revision，否则点击被静默忽略。
  const navigateFromParent = useEffectEvent((path: string) => {
    void navigateTo(path);
  });
  useEffect(() => {
    // chip 是导航请求；成功回传同一路径不能再次触发读取，旧请求仍由 guard 淘汰。
    if (
      initialPath &&
      (initialPath !== requestedPathRef.current ||
        navigationRevision !== appliedNavigationRevisionRef.current)
    ) {
      appliedNavigationRevisionRef.current = navigationRevision;
      navigateFromParent(initialPath);
    }
  }, [initialPath, navigationRevision]);

  // [失败路径] 上级路径用正则剥掉最后一段，剥成空串时回落为根斜杠，避免发出空路径的 readdir。
  // [权衡] 纯字符串截断不做规范化，冗余斜杠与尾部斜杠原样保留，真实解析交给服务端。
  // [并发] 计算同步且只依赖 currentPath，连点两次上级时后发的票会让先发请求作废。
  const handleGoUp = () => {
    // 提取父目录路径
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    navigateTo(parent);
  };

  // [失败路径] 只对 trim 后非空的输入发起导航，纯空格不触发读盘，避免把空白路径发给服务端。
  // [权衡] 输入框内容与已提交路径分离：编辑时只改 inputPath，确认后才落成 currentPath。
  const handleInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputPath.trim();
    if (trimmed) navigateTo(trimmed);
  };

  // [并发] 翻转值从 ref 读、同步写回 ref 再 setState，保证同一帧内连点两次都基于最新值翻转。
  // [事务] 只有已确定当前路径时才立即重读，否则仅记录开关，等首次导航带上新值。
  // [权衡] 切换隐藏会整表重读而非本地增删条目，换取与服务端过滤结果严格一致。
  // [失败路径] 重读失败时开关保持已翻转，此时列表与按钮语义不一致，需靠错误提示让用户再切一次。
  const handleToggleHiddenDirectories = () => {
    const nextShowHiddenDirectories = !showHiddenDirectoriesRef.current;
    showHiddenDirectoriesRef.current = nextShowHiddenDirectories;
    setShowHiddenDirectories(nextShowHiddenDirectories);

    if (currentPath) {
      void navigateTo(currentPath, nextShowHiddenDirectories);
    }
  };

  // [事务] 确认动作要求路径非空、未在加载、未在提交，三条同时成立才把路径交回上层。
  // [并发] selecting 由上层传入，本组件不自行加锁，重复点击的抑制责任在宿主侧，这里只做早退。
  // [失败路径] loading 期间确认被禁用，防止把切换前的旧路径当作最终选择提交。
  const handleSelectCurrentPath = () => {
    const selectedPath = currentPath.trim();
    if (!selectedPath || loading || selecting) {
      return;
    }

    onSelect(selectedPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  // [权衡] 内嵌模式复用同一内容区，仅由 embedded 决定外框与标题，避免两套列表逻辑分叉。
  // [资源] 输入框启用 autoFocus，弹窗打开即可键入路径，但内嵌面板会抢占编辑器已有焦点。
  const browserContent = (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3",
        embedded && "rounded-md border border-border bg-surface p-3",
      )}
    >
      <div>
        {!embedded ? (
          <div className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "directoryBrowser.title" })}
          </div>
        ) : null}

        {/* 路径输入 */}
        <form onSubmit={handleInputSubmit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="text"
            aria-label={intl.formatMessage({
              id: "directoryBrowser.pathPlaceholder",
            })}
            size="lg"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder={intl.formatMessage({
              id: "directoryBrowser.pathPlaceholder",
            })}
            className="h-9 min-w-0 flex-1 font-mono placeholder:font-sans text-ui-base max-md:text-mobile-input-safe"
            autoFocus
          />
          <div className="flex gap-2 sm:shrink-0">
            <Button
              type="submit"
              variant="secondary"
              size="lg"
              className="h-9 min-w-0 flex-1 px-4 text-ui-base sm:flex-none"
            >
              {intl.formatMessage({ id: "directoryBrowser.go" })}
            </Button>
            <Button
              type="button"
              variant={showHiddenDirectories ? "secondary" : "ghost"}
              size="lg"
              aria-pressed={showHiddenDirectories}
              className="h-9 min-w-0 flex-1 px-3 text-ui-base sm:flex-none"
              onClick={handleToggleHiddenDirectories}
            >
              {intl.formatMessage({
                id: showHiddenDirectories
                  ? "directoryBrowser.hideHidden"
                  : "directoryBrowser.showHidden",
              })}
            </Button>
          </div>
        </form>
      </div>

      {/* 错误提示 */}
      {error ? <div className="text-ui-base text-destructive">{error}</div> : null}

      {/* 目录列表；embedded 时外层 dir-shell 已带边框，列表不再叠加内层边框（原型单层框内分区）。 */}
      <div
        // [资源] listRef 指向滚动容器，导航成功后复位滚动位置，否则新目录会继承上一目录的滚动偏移。
        // [失败路径] 复位使用可选链，容器尚未挂载时静默跳过，该次复位不会补做。
        ref={listRef}
        className={cn(
          "flex-1 flex flex-col overflow-y-auto",
          embedded
            ? "min-h-24 max-h-64 rounded-md bg-background"
            : "rounded-lg border border-border bg-background",
        )}
      >
        {/* 上级目录 */}
        {currentPath && currentPath !== "/" ? (
          <button
            onClick={handleGoUp}
            // 滚动容器是纵向 flex 布局，子项默认允许 shrink；
            // 当目录很多触发滚动时，首行“返回上级”会被压缩导致高度变化。
            className="flex h-10 w-full shrink-0 cursor-pointer items-center gap-2 px-3 text-left text-ui-base transition hover:bg-hover/50"
          >
            <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="text-foreground">..</span>
          </button>
        ) : null}

        {loading ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "directoryBrowser.noSubdirs" })}
          </div>
        ) : (
          // [权衡] 列表 key 用 entry.path 而非 name，同名不同层目录不会导致复用错位。
          // [资源] 每项图标按 isSymbolicLink 动态选取，仅换图形不换点击行为，进入目录仍走同一条 navigateTo。
          entries.map((entry) => {
            const EntryIcon =
              getDirectoryBrowserEntryIconKind(entry) === "folder-symlink"
                ? FolderSymlinkIcon
                : FolderIcon;

            return (
              <button
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                className="flex w-full shrink-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-ui-base transition hover:bg-hover/50"
              >
                <EntryIcon className="size-4 shrink-0 text-foreground-subtle" />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  // [权衡] footer 只在非嵌入模式或显式要求时出现，内嵌面板默认不渲染确认按钮，由宿主决定提交时机。
  // [资源] 取消按钮直接回调 onCancel，不经过任何守卫，保证用户随时可退出，即使列表仍在加载。
  const selectionActions = (
    <>
      {" "}
      {/* Bugfix: 非嵌入模式之前只能继续进入子目录，没有确认当前目录的路径。
            Web 目录浏览器作为独立选择器使用时因此永远拿不到 onSelect 结果。
            这里把确认动作收口到弹窗 footer，选择当前浏览路径并交回上层。 */}
      <div className="mt-3 flex shrink-0 justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5 text-ui-base"
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button
          type="button"
          size="lg"
          className={cn(
            "h-10 min-w-0 px-5 text-ui-base",
            selecting !== undefined && "grid",
            selecting && "disabled:opacity-100",
          )}
          disabled={!currentPath.trim() || loading || Boolean(error) || selecting}
          aria-busy={selecting}
          data-testid="directory-browser-confirm"
          onClick={handleSelectCurrentPath}
        >
          {/* 原因：父层追加加载行会撑高弹窗且脱离点击位置；复用父层状态，在按钮内反馈。
              两种文案共用网格占位，避免加载时按钮变宽；不新增异步状态或计时器。 */}
          <span
            className={cn("col-start-1 row-start-1", selecting && "invisible")}
            aria-hidden={selecting || undefined}
          >
            {selectLabel ?? intl.formatMessage({ id: "directoryBrowser.selectDir" })}
          </span>
          {selecting !== undefined ? (
            <span
              className={cn(
                "col-start-1 row-start-1 inline-flex items-center justify-center gap-2",
                !selecting && "invisible",
              )}
              role={selecting ? "status" : undefined}
              aria-hidden={!selecting}
            >
              <LoaderIcon
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              {intl.formatMessage({ id: "directoryBrowser.opening" })}
            </span>
          ) : null}
        </Button>
      </div>
    </>
  );
  // 原因：项目编辑器已有 Dialog；嵌入选择复用相同 footer，避免叠加全屏遮罩。
  // [权衡] 嵌入分支提前返回，不带遮罩与键盘监听，避免与编辑器已有 Dialog 的 Esc 处理互相抢占。
  // [失败路径] 非嵌入分支的遮罩只在点击自身时取消，点内容区不误关，由 target 与 currentTarget 比较保证。
  if (embedded)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {browserContent}
        {showSelectionActions ? selectionActions : null}
      </div>
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-[min(36rem,calc(100vh-4rem))] w-[min(44rem,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-popover p-4 shadow-xl">
        {browserContent}
        {selectionActions}
      </div>
    </div>
  );
}
