// INV-01 意图回传：守住位置 全部组件的回调；改错故障：组件内部直接翻页或导入，Shell 无法统一编排。
// INV-02 单次取图：守住位置 观察器断开时机；改错故障：每页缩略图被重复请求。
// INV-03 预取距离：守住位置 rootMargin；改错故障：滚动到位时缩略图仍是空白。
// INV-04 失败静默：守住位置 thumbnail 的拒绝分支；改错故障：缩略图失败弹出错误打断阅读。
// INV-05 标签回退：守住位置 shown 的推导；改错故障：切到无内容标签后抽屉全空。
// INV-06 比例按种类：守住位置 ratio 的三元；改错故障：幻灯片缩略图被压成 A4 竖版。
// INV-07 打开即定位：守住位置 effect 的滚动计算；改错故障：抽屉打开后停在第一页。
// INV-08 大纲就近匹配：守住位置 currentOutline 的循环；改错故障：章节大纲永远不高亮。
// INV-09 非法页码不高亮：守住位置 found 初值；改错故障：无页码大纲高亮到末项。
// INV-10 层级夹紧：守住位置 Math.min 与 Math.max；改错故障：大纲层级越界导致样式失效。
// INV-11 导入中禁用：守住位置 按钮 disabled；改错故障：连续点击触发多次导入。
// INV-12 骨架分形态：守住位置 kind 分支；改错故障：表格文档显示文字行骨架。
// INV-13 骨架不虚构页数：守住位置 固定占位规模；改错故障：按真实页数生成骨架造成卡顿。
// INV-14 错误可播报：守住位置 role=alert；改错故障：读屏用户不知道加载失败。
// INV-15 不自动重试：守住位置 错误态按钮；改错故障：打开失败的文件被反复重载。
// INV-16 同文件可重选：守住位置 value 清空；改错故障：第二次选择同一文件没有反应。
// INV-17 体积前置校验：守住位置 导入前的上限判断；改错故障：超大文件进入导入流程后才失败。
// INV-18 状态复位：守住位置 finally；改错故障：导入失败后按钮永久停在导入中。
//
// 模块职责：提供文档面板的抽屉、空态、骨架、错误、变更横幅与本地文件导入入口。
// 状态所有权：文档、页状态与抽屉开关归 Shell；本文件只持有缩略图槽位与输入引用。
// 阅读顺序：缩略图 → 抽屉 → 空态 → 骨架 → 错误与横幅 → 文件导入。
// 面板的导航与状态界面：页缩略图抽屉、文件选择、空态、骨架、错误与文件变更提示。
// 边界：组件只展示并回传意图（翻页、选文件、切标签），抽屉开关、加载与导入流程由 Shell 编排。
// 副作用：缩略图懒加载按页调用 handle.thumbnail（每页一次），其余不发起 RPC、不写全局状态。
import { importSelectedFile } from "#ui/rpc.ts";
import { useEffect, useRef, useState, type RefObject } from "react";
import { DOC_KINDS, MAX_FILE_BYTES, type DocKind, type DocumentInfo } from "#office/contract.ts";
import { type Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import type { PageState, ViewerHandle } from "#ui/viewers/types.ts";

// 面板的文档导航与状态界面（抽屉、文件选择、空态、骨架、错误、文件变更提示），从 parts.tsx 拆出以控制单文件规模。
// 这些组件都只做展示并回传意图：加载、抽屉开关、导入流程由 main.tsx 的 Shell 编排。
// 唯一副作用是缩略图的懒加载 RPC 与文件输入的本地读取，二者都不改全局状态。

/* ---------------------------------------------------------------- Drawer */

// 抽屉的两个标签页；缺内容时 Drawer 会自动回退到可用的一侧。
export type DrawerTab = "pages" | "outline";

// 单页缩略图：进入视口附近才向查看器取图，避免长文档一次性渲染几十页。
// 失败不重试也不报错，槽位保持空白（缩略图只是导航辅助，不能阻断浏览）。
// 副作用：观察器在首次可见后即断开，保证每页只请求一次。
// 进入视口附近才取图，长文档不会一次性渲染几十页。
// 首次可见后立即断开观察器，保证每页只请求一次。
// 取图失败保持空白，不重试也不报错，缩略图不能阻断浏览。
// 取图成功后把槽位高度清空，交给 <img> 按自身比例占位。
//
function Thumbnail({
  handle,
  page,
  width,
  ratio,
  current,
  onPick,
  root,
}: {
  handle: ViewerHandle;
  page: number;
  width: number;
  ratio: number;
  current: boolean;
  onPick(page: number): void;
  root: RefObject<HTMLElement | null>;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = slot.current;
    if (!element || !handle.thumbnail) return;
    let done = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((entry) => entry.isIntersecting)) return;
        done = true;
        observer.disconnect();
        void handle.thumbnail!(page, width).then(
          (thumb) => {
            element.replaceChildren(thumb);
            element.style.height = "";
          },
          () => undefined,
        );
      },
      // 提前 300px 预取，滚动到位时缩略图通常已就绪。
      { root: root.current, rootMargin: "300px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [handle, page, width, root]);
  return (
    <button
      type="button"
      className={`thumb${current ? " on" : ""}`}
      aria-current={current ? "page" : undefined}
      onClick={() => onPick(page)}
      data-page={page}
    >
      <div ref={slot} className="mini" style={{ width, height: Math.round(width * ratio) }} />
      <span>{page}</span>
    </button>
  );
}

// 从大纲锚点里提取页码/幻灯片号；格式不匹配（章节锚点）时返回空串，UI 据此不显示数字。
// 只认页码与幻灯片号两种前缀，章节锚点返回空串。
// 返回空串时 UI 不显示数字，而不是显示 0。
//
const outlinePage = (at: string) => /^(?:page|slide):(\d+)/.exec(at)?.[1] ?? "";

// 抽屉：左侧/浮层的页缩略图或大纲。同时具备两种内容时显示分段切换，否则直接展示唯一可用项。
// 当前页高亮由 page.current 决定；点击只回传 onPage/onOutline，滚动与跳转由查看器执行。
// docked 只影响样式与是否带遮罩，不改变内容。
// shown 在期望标签不可用时回退到有内容的一侧。
// shown 变化触发 useEffect，把当前页滚到抽屉上方三分之一。
// docked 只改样式与遮罩，不改 DOM 结构。
//
export function Drawer({
  t,
  info,
  handle,
  page,
  tab,
  docked,
  onTab,
  onPage,
  onOutline,
}: {
  t: Strings;
  info: DocumentInfo;
  handle: ViewerHandle | null;
  page: PageState | null;
  tab: DrawerTab;
  docked: boolean;
  onTab(tab: DrawerTab): void;
  onPage(page: number): void;
  onOutline(at: string): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // hasPages 要求 handle.thumbnail 与 page 同时存在。
  // 两个条件都由父层传入，Drawer 不探测查看器能力。
  // hasPages 为假时 Drawer 只展示 outline 或空列表。
  //
  const hasPages = Boolean(handle?.thumbnail && page);
  const hasOutline = info.outline.length > 0;
  // 期望标签不存在时回退：没有缩略图就显示大纲，没有大纲就显示缩略图。
  const shown: DrawerTab = hasPages && (tab === "pages" || !hasOutline) ? "pages" : "outline";
  // 缩略图宽高比：pptx 用 16:9，其余（pdf/docx 等）按 A4 纵向约 1.294。
  const ratio = info.kind === "pptx" ? 9 / 16 : 1.294;
  // 当前页定位到抽屉上方三分之一处，留出上下文；依赖 shown，切换标签时也会重新对齐。
  // Bring the current page into the drawer's view when it opens or switches tab.
  useEffect(() => {
    const current = scroller.current?.querySelector<HTMLElement>("[aria-current=page]");
    if (current && scroller.current)
      scroller.current.scrollTop = current.offsetTop - scroller.current.clientHeight / 3;
  }, [shown]);
  // 大纲高亮取“最后一个页码不超过当前页”的条目：章节级大纲也能标出所处段落；
  // 无页码信息或页码非法时 found 保持 -1（不高亮任何项）。
  // currentOutline 取最后一个页码不超过 page 的条目。
  // found 初值 -1，页码缺失或非法时不高亮任何项。
  // 同一页码对应多条时取靠后的一条，符合大纲由粗到细的顺序。
  //
  const currentOutline = (() => {
    if (!page) return -1;
    let found = -1;
    info.outline.forEach((item, i) => {
      const n = Number(outlinePage(item.at));
      if (n && n <= page.current) found = i;
    });
    return found;
  })();
  return (
    <nav className={`drawer${docked ? " docked" : ""}`} aria-label={t.pagesAndOutline}>
      {hasPages && hasOutline ? (
        <div className="seg" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={shown === "pages"}
            className={shown === "pages" ? "on" : ""}
            onClick={() => onTab("pages")}
          >
            {info.kind === "pptx" ? t.slides : t.pages}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={shown === "outline"}
            className={shown === "outline" ? "on" : ""}
            onClick={() => onTab("outline")}
          >
            {t.outline}
          </button>
        </div>
      ) : null}
      <div ref={scroller} className={shown === "pages" ? "thumbs" : "outline"}>
        {shown === "pages" && handle && page
          ? Array.from({ length: page.count }, (_, i) => (
              <Thumbnail
                key={i}
                handle={handle}
                page={i + 1}
                width={136}
                ratio={ratio}
                current={page.current === i + 1}
                onPick={onPage}
                root={scroller}
              />
            ))
          : info.outline.map((item, i) => (
              <button
                type="button"
                key={`${item.at}-${i}`}
                className={`oi level-${Math.min(3, Math.max(1, item.level))}${i === currentOutline ? " on" : ""}`}
                aria-current={i === currentOutline ? "page" : undefined}
                title={item.label}
                onClick={() => onOutline(item.at)}
              >
                <span className="label">{item.label}</span>
                <span className="n">{outlinePage(item.at)}</span>
              </button>
            ))}
      </div>
    </nav>
  );
}

/* ---------------------------------------------------------------- Empty, picker, skeleton, error */

// 空态：无文档时显示打开入口；importing 期间按钮禁用并换成“导入中”文案，防止重复选择。
// 同时承担“没有任何可打开文档”的提示：accepted 来自 DOC_KINDS，文案由 i18n 的 strings 注入。
// 只渲染提示与按钮，不自行发起导入；browse 在 input 未挂载时静默无效。
// 按钮同时候选打开与导入中两种文案，由禁用态表达进行中。
// 接受类型来自文档种类常量，避免两处枚举漂移。
//
export function EmptyState({
  t,
  onBrowse,
  importing,
}: {
  t: Strings;
  onBrowse(): void;
  importing: boolean;
}) {
  return (
    <div className="empty">
      <div className="empty-content">
        <h3>{t.emptyTitle}</h3>
        <p className="empty-description">{t.emptyDescription}</p>
        <button type="button" className="btn empty-open" onClick={onBrowse} disabled={importing}>
          <Icon name="folder-open" size={16} />
          {importing ? t.importing : t.openFile}
        </button>
        <p className="empty-caption">{t.emptyCaption}</p>
      </div>
    </div>
  );
}

// 骨架行的形状序列（标题/副标题/正文/短行/小标题/图表），只用于 docx 与 pdf 的观感占位。
const SKELETON_LINES = [
  "title",
  "subtitle",
  "line",
  "line",
  "short",
  "heading",
  "line",
  "line",
  "line",
  "mid",
  "figure",
];

// 加载占位：kind 决定形态（xlsx 用行网格、pptx 用幻灯片框、其余用文字行）；kind 为 null 时按普通页处理。
// 纯装饰，aria-busy 提示读屏器当前在加载。
// kind 只影响骨架形态，不感知真实页数/表数；加载完成后由 Shell 卸载，不留占位。
// xlsx 用 18 行网格；pptx 用两个幻灯片框，其余按文字行铺。
// kind 只决定骨架形态，加载完成后由 Shell 卸载。
//
export function Skeleton({ kind }: { kind: DocKind | null }) {
  if (kind === "xlsx")
    return (
      <div className="skeleton sheet" aria-busy="true">
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className="skel-row" />
        ))}
      </div>
    );
  const slide = kind === "pptx";
  return (
    <div className="skeleton" aria-busy="true">
      {[0, 1].map((n) => (
        <div key={n} className={`skelpage${slide ? " slide" : ""}`}>
          {n === 0 && !slide
            ? SKELETON_LINES.map((line, i) => <div key={i} className={`skel ${line}`} />)
            : null}
          {n === 0 && slide ? (
            <>
              <div className="skel title left" />
              <div className="skel line" />
              <div className="skel mid" />
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// 失败态：role=alert 让读屏器立即播报；detail 可空（为空时只显示标题）。
// “打开另一个”按钮复用浏览入口，不自动重试失败的文件。
// 文案已由 describeFailure 归一为非空 title/detail，这里只负责呈现与派发 browse。
export function ErrorState({
  t,
  title,
  detail,
  onOpenAnother,
}: {
  t: Strings;
  title: string;
  detail: string;
  onOpenAnother(): void;
}) {
  return (
    <div className="failed" role="alert">
      <Icon name="file-text" size={28} className="subtlest" />
      <div>
        <h3>{title}</h3>
        {detail ? <p>{detail}</p> : null}
      </div>
      <button type="button" className="btn secondary" onClick={onOpenAnother}>
        {t.openAnother}
      </button>
    </div>
  );
}

// 磁盘文件变更横幅：重载会重新拉取文档，忽略则把该 revision 记为已忽略（不再提示同一版本）。
// 只提示不自动重载，避免打断用户阅读；同一 revision 被忽略后不再重复出现。
// 组件不持有忽略状态，ignored 的持久化由 Shell 负责，横幅卸载不会丢信息。
export function ChangedBanner({
  t,
  onReload,
  onDismiss,
}: {
  t: Strings;
  onReload(): void;
  onDismiss(): void;
}) {
  return (
    <div className="banner" role="status">
      <span>{t.changed}</span>
      <button type="button" className="btn sm primary" onClick={onReload}>
        {t.reloadShort}
      </button>
      <button
        type="button"
        className="btn icon sm dim"
        title={t.dismiss}
        aria-label={t.dismiss}
        onClick={onDismiss}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

// 文件输入：accepted 类型由 DOC_KINDS 推导；导入走受限接口（服务端决定落盘位置），成功后回调新路径。
// 取消选择（无文件）不改动当前文档；先清空 value 才能重复选择同一文件。
// 失败（体积超限、格式不支持、IO 错误）统一交给 onError，由 Shell 转成可读文案。
// 使用系统文件选择器，取消时不改变当前文档；选中的内容通过受限导入接口进入工作区。
// 选中即清空 value，允许连续两次选择同一文件。
// 体积超限在导入前抛出，由统一错误回调转成可读文案。
//
export function NativeFileInput({
  inputRef,
  t,
  importing,
  onImporting,
  onOpen,
  onError,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  t: Strings;
  importing: boolean;
  onImporting(value: boolean): void;
  onOpen(path: string): void;
  onError(error: unknown, name: string): void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      hidden
      accept={DOC_KINDS.map((kind) => `.${kind}`).join(",")}
      disabled={importing}
      onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        onImporting(true);
        try {
          if (file.size > MAX_FILE_BYTES) throw new Error(t.importTooLarge);
          onOpen(await importSelectedFile(file));
        } catch (error) {
          onError(error, file.name);
        } finally {
          onImporting(false);
        }
      }}
    />
  );
}

/**
 * 管理“导入本地文件”的隐藏 input 与选择器动作。
 * 输入：`t` 文案表；`onOpen` 导入成功后回调（参数为文件路径）；`onError` 失败回调（带文件名）。
 * 输出：`{importing, browse, input}`；`browse` 在 input 尚未挂载时静默无效。
 * 副作用：选择后按 `MAX_FILE_BYTES` 校验并导入；选择即清空 value，允许重复选中同一文件。
 * 失败语义：读取/导入异常交给 `onError`，不向调用方抛出，`importing` 在 finally 复位。
 */
// 把隐藏输入与选择动作打包成一个 hook，Shell 不必重复样板。
// 输入未挂载时浏览静默无效，不抛错也不排队。
//
export function useNativeFileInput(
  t: Strings,
  onOpen: (path: string) => void,
  onError: (error: unknown, name: string) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, onImporting] = useState(false);
  return {
    importing,
    // 打开系统选择器；input 未挂载时静默无效。
    browse: () => inputRef.current?.click(),
    input: <NativeFileInput {...{ inputRef, t, importing, onImporting, onOpen, onError }} />,
  };
}
