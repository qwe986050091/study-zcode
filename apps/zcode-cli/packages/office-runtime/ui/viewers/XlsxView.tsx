// INV-01 1-based 边界：守住位置 对外定位器的生成处；改错故障：shell 与查看器的行列差一。
// INV-02 共享加载：守住位置 模块级 wasm Promise；改错故障：每个查看器各建一个 worker。
// INV-03 失败不重试：守住位置 loadXlsxWasm 的返回；改错故障：打开失败后无限重试拖慢面板。
// INV-04 选区归一：守住位置 anchorOf 的取小取大；改错故障：反向拖选得到非法锚点。
// INV-05 异步降级：守住位置 cellSnapshot 的 catch；改错故障：单格读取失败导致整段文本为空。
// INV-06 取数上限：守住位置 rangeText 的行列夹紧；改错故障：大区域复制卡死主线程。
// INV-07 单格带公式：守住位置 single 判断；改错故障：整片区域被公式文本淹没。
// INV-08 高亮优先级：守住位置 getCellStyle 的三段返回；改错故障：当前命中与普通命中颜色互换。
// INV-09 未命中放手：守住位置 返回 undefined；改错故障：主题切换后单元格底色不跟随。
// INV-10 跨表不串色：守住位置 inside 的表名比较；改错故障：同名区域在另一张表也高亮。
// INV-11 画布识别：守住位置 gridCanvas 的最大面积选择；改错故障：取到滚动条或缩略图，定位偏移。
// INV-12 滚动补偿：守住位置 pressBox 的位移叠加；改错故障：滚动后选区条与手指位置分离。
// INV-13 单击可见：守住位置 最小宽高；改错故障：单击不拖动时选区条不可见。
// INV-14 状态驱动重绘：守住位置 reveal 与 found 都走 setState；改错故障：改了引用但画布不重绘。
// INV-15 只读打开：守住位置 readOnly；改错故障：预览可编辑源工作簿。
// INV-16 键盘活动：守住位置 keydown 分支；改错故障：键盘选区被误判为用户点击而弹条。
// INV-17 监听清理：守住位置 effect 返回值；改错故障：卸载后仍响应指针事件。
// INV-18 句柄契约：守住位置 clearSelection 空实现；改错故障：调用方按格式特判清选区。
//
// 模块职责：以 canvas 方式只读渲染 XLSX，并提供定位、截图、查找与缩放命令。
// 状态所有权：工作簿归 react-xlsx 控制器；高亮与查找结果归本组件状态。
// 阅读顺序：共享加载 → 定位与取值 → 高亮样式 → 画布与选区 → 事件与样式 → 命令式接口。
// XLSX 查看器（react-xlsx）：工作簿由 wasm 在 worker 里解析，表格绘制在 canvas 上，
// 因此没有单元格 DOM，选区与高亮都通过控制器的 range API + 单元格样式回调表达。
// 副作用：加载 wasm/worker（ObjectURL）、创建 viewer、把选区与位置变化回调给 shell。
// 不变量：对外定位器一律 1-based 行列；控制器里的行列是 0-based，转换只在边界发生。
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  XlsxViewer,
  setWasmSource,
  useXlsxViewerController,
  type XlsxCellRange,
  type XlsxCellStyleContext,
  type XlsxViewerController,
} from "@extend-ai/react-xlsx";
import { formatCell, formatLocator, parseLocator } from "#office/domain/anchor.ts";
import { readBinary, readText } from "#ui/assets.ts";
import { boxOf, installLinkGuard } from "#ui/dom.ts";
import { rasterize } from "#ui/raster.ts";
import type { RevealedTarget, ViewerHandle, ViewerProps } from "#ui/viewers/types.ts";

// 模块级 Promise 是共享句柄，多个查看器实例只触发一次资源读取。
// 失败后保持拒绝状态，重试必须重新挂载面板，不在加载函数内部重试。
//
let wasm: Promise<void> | undefined;
// 一次性加载表格运行所需的 wasm 与 worker，并把 worker 以 ObjectURL 交给库；
// 返回的是共享 Promise，重复调用不会重复读取资源，失败后也会保留 rejection（需要重新挂载才能重试）。
/**
 * react-xlsx parses workbooks with wasm in a module worker. The sandbox cannot fetch, so hand it the
 * wasm bytes and a blob URL for the worker (the build points the library at `__officeXlsxWorkerUrl`).
 */
// 缓存变量 wasm 置为模块级：同一面板内多个表格查看器共享一次加载，避免每个实例各建一个 worker。
// 输入无参数，输出共享 Promise；重复调用复用同一次资源读取与 worker URL 初始化。
// 失败后 Promise 保持 rejected，不会静默重试；调用方需把它当作打开文档的致命前置失败。
// 首次调用创建 Promise，后续调用直接复用，避免重复创建 worker 地址。
// 资源读取并行发起：wasm 二进制与 worker 脚本互不依赖。
// worker 通过对象地址交给库，沙箱内无法从网络拉取。
// 设置 wasm 源必须早于查看器创建，否则控制器初始化拿不到解析器。
//
export function loadXlsxWasm(): Promise<void> {
  return (wasm ??= Promise.all([readBinary("sheets.wasm"), readText("xlsx-worker.js")]).then(
    ([bytes, worker]) => {
      (globalThis as { __officeXlsxWorkerUrl?: string }).__officeXlsxWorkerUrl =
        URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
      setWasmSource(bytes);
    },
  ));
}

// 控制器返回的选区是 0-based 且起止可能反向；这里归一成左上/右下并 +1，再格式化为锚点定位器。
/** 0-based viewer range → 1-based anchor locator. */
// controller range 可能反向，先对 row/col 取 min/max 再统一加一。
// 输出锚点定位器，1-based 转换只发生在这一处边界。
//
function anchorOf(sheet: string, range: XlsxCellRange): string {
  return formatLocator({
    kind: "xlsx",
    sheet,
    range: {
      start: {
        row: Math.min(range.start.row, range.end.row) + 1,
        col: Math.min(range.start.col, range.end.col) + 1,
      },
      end: {
        row: Math.max(range.start.row, range.end.row) + 1,
        col: Math.max(range.start.col, range.end.col) + 1,
      },
    },
  });
}

// 读取单元格显示值与公式。worker 解析的工作簿只能异步取快照，读取失败降级为空值，
// 不因单格异常打断整段文本生成；非 worker 模式直接走同步 API。
/** Display value and formula of a cell; worker-backed workbooks only answer asynchronously. */
// worker 模式只能异步取快照，读取失败降级为空值而不打断整段文本。
// 非 worker 模式走同步接口，复制与查找在两种模式下行为一致。
//
async function cellSnapshot(controller: XlsxViewerController, row: number, col: number) {
  const sheet = controller.activeSheet;
  if (controller.getCellSnapshotAsync && sheet && controller.isWorkerBacked)
    return controller
      .getCellSnapshotAsync(sheet.workbookSheetIndex, row, col)
      .catch(() => ({ displayValue: "", formula: "" }));
  return {
    displayValue: controller.getCellDisplayValue({ row, col }),
    formula: controller.getCellFormula({ row, col }),
  };
}

// 取区域内的值拼成 TSV：行列上限 50×20（超出部分截断），单格时额外附带 `(=公式)`，
// 便于 Agent 看到公式语义。空区域返回空串，调用方按「无文本选区」处理。
/** Values of a range as tab-separated text (capped at 50 rows × 20 columns). */
// 行列同时按上下限夹紧，最多五十行二十列，超出部分直接截断。
// 单格选区才附带公式，避免大区域文本被公式撑爆。
// 每行并行取格，行之间再并行汇总，最后按换行拼接并去掉首尾空白。
// 空区域得到空串，调用方据此判定没有文本选区。
//
async function rangeText(controller: XlsxViewerController, range: XlsxCellRange): Promise<string> {
  const top = Math.min(range.start.row, range.end.row);
  const bottom = Math.min(Math.max(range.start.row, range.end.row), top + 49);
  const left = Math.min(range.start.col, range.end.col);
  const right = Math.min(Math.max(range.start.col, range.end.col), left + 19);
  const single = top === bottom && left === right;
  const rows: Promise<string>[] = [];
  for (let row = top; row <= bottom; row++) {
    const cells: Promise<string>[] = [];
    for (let col = left; col <= right; col++)
      cells.push(
        cellSnapshot(controller, row, col).then(({ displayValue, formula }) =>
          formula && single ? `${displayValue} (=${formula.replace(/^=/, "")})` : displayValue,
        ),
      );
    rows.push(Promise.all(cells).then((values) => values.join("\t")));
  }
  return (await Promise.all(rows)).join("\n").trim();
}

// 一个高亮区域（工作表名 + 0-based 闭区间行列）；绘制时通过 getCellStyle 逐格判定是否落在区间内。
interface Highlight {
  // 工作表名（控制器 tabs 里的原始名称），用于跨表匹配。
  sheet: string;
  // 0-based 起始行（含）。
  top: number;
  // 0-based 起始列（含）。
  left: number;
  // 0-based 结束行（含）。
  bottom: number;
  // 0-based 结束列（含）。
  right: number;
}

// 三种高亮样式：Agent 标记（橙）、普通查找命中（黄）、当前命中（深橙 + 描边），
// 与 CSS 侧保持同一套颜色语义，避免深色主题下不可见。
const REVEAL_STYLE: CSSProperties = {
  backgroundColor: "rgba(255, 179, 0, 0.38)",
  boxShadow: "inset 0 -2px 0 #e59a00",
};
const FIND_STYLE: CSSProperties = { backgroundColor: "rgba(255, 213, 0, 0.45)" };
const FIND_CURRENT_STYLE: CSSProperties = {
  backgroundColor: "rgba(255, 140, 0, 0.6)",
  boxShadow: "inset 0 0 0 1px #e07b00",
};

// 判断单元格是否落在高亮区间内：表名必须同名，行列按闭区间比较。
const inside = (item: Highlight, sheet: string, row: number, col: number) =>
  item.sheet === sheet &&
  row >= item.top &&
  row <= item.bottom &&
  col >= item.left &&
  col <= item.right;

// 网格主画布（面积最大的那个 canvas），随表格滚动移动；找不到返回 null。
/** The grid's drawing surface (the largest canvas); it moves as the sheet scrolls. */
// 网格画布是面积最大的那个画布，按需遍历不缓存节点。
// 找不到根节点或没有画布时返回空，调用方需要容忍。
//
function gridCanvas(root: HTMLElement | null): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let area = 0;
  for (const canvas of root?.querySelectorAll<HTMLCanvasElement>(".xlsx-grid canvas") ?? []) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width * rect.height > area) {
      area = rect.width * rect.height;
      best = canvas;
    }
  }
  return best;
}

interface Press {
  // 按下时指针的视口坐标。
  start: { x: number; y: number };
  // 抬起（或最后一次移动）时的视口坐标；未拖动时等于 start。
  end: { x: number; y: number };
  // 按下瞬间网格画布的位置；后续滚动造成画布偏移，需要据此补偿选区框。
  /** Grid surface position when pressed, to follow later scrolling. */
  surface: DOMRect | null;
}

// 由按下/拖动坐标推出选区框：叠加「按下后画布位移」补偿，最小宽 2px、高 16px，
// 保证单击也能显示一个可点击的选区条；画布位置未知时不做补偿。
/**
 * The grid is drawn on canvas, so cells have no boxes; the selection bar anchors to where the
 * user pressed (or dragged), shifted by however far the sheet has scrolled since.
 */
// 画布位置未知时位移按零处理，不阻断选区展示。
//
function pressBox(root: HTMLElement | null, press: Press): DOMRect | null {
  const now = boxOf(gridCanvas(root));
  const dx = press.surface && now ? now.left - press.surface.left : 0;
  const dy = press.surface && now ? now.top - press.surface.top : 0;
  const left = Math.min(press.start.x, press.end.x) + dx;
  const top = Math.min(press.start.y, press.end.y) + dy;
  return new DOMRect(
    left,
    top - 8,
    Math.max(2, Math.abs(press.end.x - press.start.x)),
    Math.max(16, Math.abs(press.end.y - press.start.y) + 16),
  );
}

// 底部工作表切换条；只有工作表时才渲染，否则返回 null（单表时避免多余占位）。
function SheetTabs({ controller }: { controller: XlsxViewerController }) {
  if (controller.tabs.length <= 1) return null;
  return (
    <div className="sheet-tabs" role="tablist">
      {controller.tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={index === controller.activeTabIndex}
          className={index === controller.activeTabIndex ? "active" : ""}
          onClick={() => controller.setActiveTabIndex(index)}
          title={tab.name}
        >
          {tab.name}
        </button>
      ))}
    </div>
  );
}

// XLSX 查看器主体。输入 bytes 与 info.path（文件名影响公式/格式解析），只读打开；
// 输出 ViewerHandle，并回调 onReady/onError/onLocation/onSelect/onLink。
// 不变量：所有对外 at 都是 1-based；revealed/found 用状态驱动 canvas 重绘，因此改高亮必须走 setState。
export const XlsxView = forwardRef<ViewerHandle, ViewerProps>(function XlsxView(props, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const controller = useXlsxViewerController({
    file: props.bytes,
    fileName: props.info.path,
    readOnly: true,
  });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const [revealed, setRevealed] = useState<Highlight[]>([]);
  /** Agent targets with a cell range, by their position in the last reveal result. */
  const revealHits = useRef<{ item: Highlight; index: number }[]>([]);
  const [found, setFound] = useState<{ items: Highlight[]; current: number }>({
    items: [],
    current: -1,
  });
  const foundRef = useRef(found);
  foundRef.current = found;
  const readyRef = useRef(false);
  /** Set by a pointer or key action in the grid; selections without one open no selection bar. */
  /** Last pointer or key action in the grid; selections long after one open no selection bar. */
  const acted = useRef<{ time: number; press: Press | null }>({ time: 0, press: null });
  /** Bumped by every press in the grid so clicking the selected cell shows the bar again. */
  const [presses, setPresses] = useState(0);

  // 就绪/失败上报：error 优先；首次加载完成且已有工作表时只回调一次 onReady，避免重复初始化。
  useEffect(() => {
    if (controller.error) callbacks.current.onError(controller.error);
    else if (!controller.isLoading && controller.sheets.length && !readyRef.current) {
      readyRef.current = true;
      callbacks.current.onReady();
    }
  }, [controller.error, controller.isLoading, controller.sheets.length]);

  const sheetName = controller.activeSheet?.name ?? controller.activeTab?.name ?? "";

  // 位置上报：有活动单元格时上报精确单元格，否则只上报工作表。
  // Location: active sheet and cell.
  useEffect(() => {
    if (!sheetName) return;
    const cell = controller.activeCell;
    callbacks.current.onLocation(
      cell
        ? formatLocator({
            kind: "xlsx",
            sheet: sheetName,
            range: {
              start: { row: cell.row + 1, col: cell.col + 1 },
              end: { row: cell.row + 1, col: cell.col + 1 },
            },
          })
        : formatLocator({ kind: "xlsx", sheet: sheetName }),
    );
  }, [sheetName, controller.activeCell?.row, controller.activeCell?.col]);

  // 选区上报：把选区（无选区时用活动单元格）连同取值回调给 shell。
  // user 仅在最近 1.5s 内有指针/键盘操作时为 true，避免程序化恢复选区时弹出选择条；
  // 点击落在 Agent 标记范围内则先触发 onRevealHit，命中后不再显示选择条。
  // 异步取值的回调用 current 标记，effect 清理后丢弃过期结果。
  // Selection: report the selected range (or active cell) with its values.
  const selectionKey = controller.selection
    ? JSON.stringify(controller.selection)
    : controller.activeCellAddress;
  useEffect(() => {
    if (!sheetName || !readyRef.current) return;
    const range =
      controller.selection ??
      (controller.activeCell ? { start: controller.activeCell, end: controller.activeCell } : null);
    if (!range) return;
    let current = true;
    const at = anchorOf(sheetName, range);
    let user = performance.now() - acted.current.time < 1500;
    const pressed = user ? acted.current.press : null;
    // A click inside one of the agent's ranges brings its note back instead of the bar.
    if (pressed) {
      const row = Math.min(range.start.row, range.end.row);
      const col = Math.min(range.start.col, range.end.col);
      const hit = revealHits.current.find(({ item }) => inside(item, sheetName, row, col));
      if (hit && callbacks.current.onRevealHit?.(hit.index)) user = false;
    }
    const detail = {
      text: false,
      locate: () => (pressed ? pressBox(rootRef.current, pressed) : null),
      user,
    };
    void rangeText(controller, range).then(
      (text) => current && callbacks.current.onSelect({ at, text }, detail),
      () => current && callbacks.current.onSelect({ at, text: "" }, detail),
    );
    return () => {
      current = false;
    };
  }, [selectionKey, sheetName, presses]);

  // 指针/键盘活动追踪：按下记录坐标与画布位置，抬起补终点并自增 presses（触发选区重算，
  // 让重复点击已选单元格也能弹回选择条）；键盘操作只更新时间戳，press 置空。
  // 捕获阶段监听，先于 canvas 内部的选区逻辑执行。
  useEffect(() => {
    const root = rootRef.current!;
    const unguard = installLinkGuard(root, (url) => callbacks.current.onLink(url));
    const inGrid = (event: Event) => Boolean((event.target as Element).closest?.(".xlsx-grid"));
    let pressing = false;
    const act = (event: PointerEvent) => {
      if (!inGrid(event)) return;
      pressing = true;
      const point = { x: event.clientX, y: event.clientY };
      acted.current = {
        time: performance.now(),
        press: { start: point, end: point, surface: boxOf(gridCanvas(root)) },
      };
    };
    const release = (event: PointerEvent) => {
      if (!pressing || !acted.current.press) return;
      pressing = false;
      acted.current = {
        time: performance.now(),
        press: { ...acted.current.press, end: { x: event.clientX, y: event.clientY } },
      };
      setPresses((count) => count + 1);
    };
    const key = (event: KeyboardEvent) => {
      if (inGrid(event)) acted.current = { time: performance.now(), press: null };
    };
    root.addEventListener("pointerdown", act, true);
    root.addEventListener("pointerup", release, true);
    root.addEventListener("keydown", key, true);
    return () => {
      unguard();
      root.removeEventListener("pointerdown", act, true);
      root.removeEventListener("pointerup", release, true);
      root.removeEventListener("keydown", key, true);
    };
  }, []);

  // 单元格样式回调：当前查找命中优先于普通命中，普通命中优先于 Agent 标记；
  // 不命中返回 undefined，交回库的默认样式（随主题变化）。
  // 逐条比较表名与闭区间，跨表同名区域不会互相染色。
  // 回调依赖查找与标记两组状态，任一变化都会重建样式函数。
  //
  const getCellStyle = useCallback(
    (context: XlsxCellStyleContext): CSSProperties | undefined => {
      const { row, col } = context.cell;
      const current = found.items[found.current];
      if (current && inside(current, context.sheetName, row, col)) return FIND_CURRENT_STYLE;
      if (found.items.some((item) => inside(item, context.sheetName, row, col))) return FIND_STYLE;
      if (revealed.some((item) => inside(item, context.sheetName, row, col))) return REVEAL_STYLE;
      return undefined;
    },
    [revealed, found],
  );

  // 按工作表名查 tab 下标：精确匹配优先，其次忽略大小写；找不到返回 -1。
  // 只有精确命中时才用原名，否则沿用实际 tab 名，避免中文/大小写差异导致高亮错表。
  // 先精确匹配，再忽略大小写匹配，顺序保证同名表优先。
  // 下标来自控制器当前标签，不缓存，切表后立即生效。
  //
  function tabIndexFor(name: string): number {
    const tabs = controllerRef.current.tabs;
    const exact = tabs.findIndex((tab) => tab.name === name);
    return exact >= 0
      ? exact
      : tabs.findIndex((tab) => tab.name.toLowerCase() === name.toLowerCase());
  }

  // 等两帧后再继续：切表/滚动后 canvas 需要一帧布局 + 一帧绘制才反映新状态，
  // 截图与滚动定位都依赖这个时序。
  const waitFrame = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  // 命令式接口：reveal 只切表/选中单元格（canvas 无法画 DOM 标记，因此高亮靠 getCellStyle）；
  // capture 需要先 reveal 并等两帧再截图；find 在当前表已用区域内扫描显示值。
  // 依赖 props.dark 是因为截图底色随主题变化，主题切换后 handle 需重建。
  // 句柄按需重建：主题变化会改变截图底色，因此依赖只列主题。
  // reveal 的命中索引按结果长度记录，跳过的工作表不会造成错位。
  //
  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async reveal(targets) {
        const next: Highlight[] = [];
        const results: RevealedTarget[] = [];
        revealHits.current = [];
        for (const target of targets) {
          const locator = parseLocator("xlsx", target.at);
          if (locator.kind !== "xlsx") continue;
          const tab = tabIndexFor(locator.sheet);
          if (tab < 0) continue;
          const name = controllerRef.current.tabs[tab].name;
          const item: Highlight | null = locator.range
            ? {
                sheet: name,
                top: locator.range.start.row - 1,
                left: locator.range.start.col - 1,
                bottom: locator.range.end.row - 1,
                right: locator.range.end.col - 1,
              }
            : null;
          // 索引按 results 的长度记录（而不是 targets 序号），跳过的工作表/非法目标不会错位。
          if (item) {
            next.push(item);
            revealHits.current.push({ item, index: results.length });
          }
          const show = async () => {
            if (tab !== controllerRef.current.activeTabIndex) {
              controllerRef.current.setActiveTabIndex(tab);
              await waitFrame();
            }
            if (item)
              controllerRef.current.selectRange({
                start: { row: item.top, col: item.left },
                end: { row: item.bottom, col: item.right },
              });
          };
          // Cells are drawn on canvas: the callout docks at the top of the sheet.
          results.push({ at: target.at, locate: () => null, scrollTo: () => void show() });
        }
        setRevealed(next);
        if (results[0]) {
          results[0].scrollTo();
          await waitFrame();
        }
        return results;
      },
      goTo(at) {
        const locator = parseLocator("xlsx", at);
        if (locator.kind !== "xlsx") return;
        const tab = tabIndexFor(locator.sheet);
        if (tab >= 0 && tab !== controllerRef.current.activeTabIndex)
          controllerRef.current.setActiveTabIndex(tab);
      },
      clearReveal() {
        revealHits.current = [];
        setRevealed([]);
      },
      async capture(at, maxWidth) {
        // 截图前必须先把目标区域选中并等画布重绘完成，否则截到的是旧区域。
        if (at) {
          await this.reveal([{ at }]);
          await waitFrame();
          await waitFrame();
        }
        const root = rootRef.current!;
        const raster = await rasterize(root, {
          maxWidth,
          background: props.dark ? "#1e1e1e" : "#fff",
        });
        const active = controllerRef.current;
        const name = active.activeSheet?.name ?? "";
        return {
          ...raster,
          at:
            at ??
            (active.activeCell
              ? `${formatLocator({ kind: "xlsx", sheet: name })}!${formatCell({ row: active.activeCell.row + 1, col: active.activeCell.col + 1 })}`
              : formatLocator({ kind: "xlsx", sheet: name })),
        };
      },
      zoom(direction) {
        if (direction > 0) controllerRef.current.zoomIn();
        else controllerRef.current.zoomOut();
      },
      fit() {
        controllerRef.current.resetZoom();
      },
      async find(query) {
        const needle = query.trim().toLowerCase();
        const active = controllerRef.current;
        const sheet = active.activeSheet;
        if (!needle || !sheet) {
          setFound({ items: [], current: -1 });
          return 0;
        }
        const items: Highlight[] = [];
        // 仅在已用区域内查找，且最多扫 2000 行 × 100 列、命中 500 处即停：
        // 表格可能有几十万行，全量扫描会长时间阻塞；截断上限即降级语义。
        const lastRow = Math.min(sheet.maxUsedRow, sheet.minUsedRow + 2000);
        const lastCol = Math.min(sheet.maxUsedCol, sheet.minUsedCol + 100);
        for (let row = sheet.minUsedRow; row <= lastRow && items.length < 500; row++) {
          const values = await Promise.all(
            Array.from({ length: lastCol - sheet.minUsedCol + 1 }, (_, i) =>
              cellSnapshot(active, row, sheet.minUsedCol + i),
            ),
          );
          values.forEach(({ displayValue }, i) => {
            const col = sheet.minUsedCol + i;
            if (displayValue.toLowerCase().includes(needle))
              items.push({ sheet: sheet.name, top: row, left: col, bottom: row, right: col });
          });
        }
        setFound({ items, current: -1 });
        return items.length;
      },
      findGo(index) {
        const item = foundRef.current.items[index];
        if (!item) return;
        setFound((state) => ({ ...state, current: index }));
        controllerRef.current.selectCell({ row: item.top, col: item.left });
      },
      clearFind() {
        setFound({ items: [], current: -1 });
      },
      // 空实现：选区完全由 react-xlsx 控制器维护，清空 DOM 选区无意义；
      // 保留方法是为了满足 ViewerHandle 契约，调用方无需判断格式。
      clearSelection() {},
    }),
    [props.dark],
  );

  return (
    <div ref={rootRef} className={`xlsx-root${props.glance ? " glance" : ""}`}>
      <div className="xlsx-grid">
        <XlsxViewer
          controller={controller}
          height="100%"
          isDark={props.dark}
          readOnly
          rounded={false}
          showDefaultToolbar={false}
          getCellStyle={getCellStyle}
          loadingState={<div className="viewer-pending" aria-busy="true" />}
        />
      </div>
      <SheetTabs controller={controller} />
    </div>
  );
});
