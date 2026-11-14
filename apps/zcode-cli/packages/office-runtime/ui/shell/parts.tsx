// 外壳的可复用交互部件：菜单、查找条、页码胶囊、选区操作条、Agent 气泡与屏外提示。
// 边界：组件只做展示与派发意图，不发起 RPC、不写存储；开关与数据由 Shell 通过 props 控制。
// 副作用：仅菜单/查找条内部的焦点与监听，卸载时清理；所有定位经 useFloating 计算。
// ===================== 文件级说明（B37 深度注释） =====================
// 职责：外壳交互部件的展示层——下拉菜单与菜单项、查找条、页码/缩放胶囊、选区操作条与提问框、Agent 引用气泡、屏外目标胶囊，
// 以及把命中数量与位置拼成提示文案的 offscreenText。
// 不负责：不发起 RPC、不读写存储、不执行查找与高亮、不判断目标是否真在屏外；组件只派发意图，数据权威与开关状态在 Shell 与查看器一侧。
//
// 不变量（每条都对应一处线上可见故障，改动前逐条核对）：
// INV-01 断言：Menu 的 pointerdown 与 keydown 监听必须以相同 capture 成对移除 —— 守住它的位置：Menu 的 useEffect 清理函数 —— 改错故障：菜单卸载后监听残留，点文档仍触发 onClose，并对已卸载组件更新状态。
// INV-02 断言：Menu 的 effect 只依赖 onClose，调用方必须传稳定引用 —— 守住它的位置：依赖数组与外壳传参 —— 改错故障：每次渲染重装监听并把焦点拽回首个菜单项，键盘连续下移一步就跳回顶部。
// INV-03 断言：Esc 必须先阻止冒泡再关闭自身 —— 守住它的位置：Menu.onKey、FindBar 与页码输入框的按键分支 —— 改错故障：一次 Esc 同时关菜单又关抽屉或清空选区，用户丢失正在编辑的上下文。
// INV-04 断言：MenuItem 在 checked 为 undefined 时不得输出 aria-checked —— 守住它的位置：role 与 aria-checked 的三元表达式 —— 改错故障：普通动作项被读屏播报成未选中的单选按钮，菜单语义错乱。
// INV-05 断言：FindBar 的挂载聚焦必须是空依赖、只跑一次 —— 守住它的位置：FindBar 内带空依赖数组的 useEffect —— 改错故障：每敲一个字符就重新全选，第二个字符直接覆盖第一个。
// INV-06 断言：total 为 null 不显示计数、为 0 显示“无结果” —— 守住它的位置：count 的真假三元 —— 改错故障：渲染期闪出“0/0”，或零结果时条上空白让人以为查找失效。
// INV-07 断言：页码胶囊的定时器与两条容器监听必须在卸载时全部释放 —— 守住它的位置：PagePill 的 useEffect 清理函数 —— 改错故障：切文档后旧容器仍在派发 scroll，定时器持续更新已卸载组件。
// INV-08 断言：只有未悬停且焦点不在胶囊内时才允许淡出 —— 守住它的位置：idle 回调里对 hold 与 activeElement 的判断 —— 改错故障：用户正在输入页码时胶囊消失，草稿随卸载丢失。
// INV-09 断言：页码提交只接受大于等于 1 的整数并夹到总页数 —— 守住它的位置：go 内的 Number.isInteger 与 Math.min —— 改错故障：输入 0 或超界数字把查看器推到非法页，画面空白或抛错。
// INV-10 断言：页码草稿的非数字字符必须在输入阶段剥离 —— 守住它的位置：onChange 中的空字符类替换 —— 改错故障：草稿混入字母后 Number 得 NaN，回车静默无反应。
// INV-11 断言：SelectionBar 的全部 hooks 必须在模式分支之前调用 —— 守住它的位置：useFloating 与 useState 位于 if (asking) 之前 —— 改错故障：切到提问模式时 hook 数量变化，React 直接抛渲染错误。
// INV-12 断言：提问提交必须同时拦住空文本、发送中与输入法组合态 —— 守住它的位置：send 首行守卫与 textarea 的 isComposing 判断 —— 改错故障：中文输入法回车选词被当成发送，或双击产生两条重复提问。
// INV-13 断言：onSend 返回 false 时必须保留用户输入，返回 true 才清空 —— 守住它的位置：send 中等待之后的成功分支 —— 改错故障：发送失败后输入框被清空，用户必须重打。
// INV-14 断言：offscreenText 不得去重、不得自拼数量，且调用方需保证 ats 非空 —— 守住它的位置：offscreenText 的 ats.length 与 describeAt(ats[0]) —— 改错故障：空数组时首项为 undefined 导致格式化抛错，或提示数与实际标记数不符。
// ==================================================================
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { describeAt, type Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { useFloating } from "#ui/shell/float.ts";
import type { Locate, PageState, ZoomState } from "#ui/viewers/types.ts";

/* ---------------------------------------------------------------- Menu */

// 下拉菜单容器：负责关闭策略（Esc、外部按下）与键盘上下移动焦点，内容由调用方提供。
// 关闭是“通知”而非自持状态：onClose 由外壳清空 menu 字段，菜单随之卸载。
// 副作用：挂载时把焦点移到第一个菜单项；支持 role=menuitem 与 menuitemradio 两种角色。
// 菜单自身不做定位，由外层样式决定（标题栏下拉，非浮层锚定）。
/** ZCode dropdown: closes on Escape and on any pointer press outside it. */
// [契约] 关闭是通知而非自持状态：本组件不保存“是否打开”，onClose 由外壳清空 menu 字段后整棵子树卸载。
// 若在此加本地开关，会出现菜单视觉上已关、外壳仍认为打开的两份真相，再点触发按钮反而关不掉。
// 只有 pointerdown 与 keydown 两个关闭源，刻意不含 blur/focusout：改为失焦关闭会在点到菜单项之前先卸载，点击丢了。
// 菜单不自带定位，位置由标题栏样式决定；不要在这里接 useFloating，否则下拉与浮层的层级假设会打架。
export function Menu({
  className,
  onClose,
  children,
  label,
}: {
  className: string;
  onClose(): void;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element;
      // 点在菜单外且不是触发按钮时关闭；排除触发表明由触发按钮自己切换，避免“关了又开”。
      // [契约] 排除 [data-menu-trigger] 触发按钮是必需的：它自己负责切换，不排除就会先被这里关闭、再被自己打开，表现为点一次没反应。
      // closest 用可选调用：target 可能是 document 或纯文本节点，没有 closest 方法。
      // 监听挂在 document 且走捕获阶段，菜单外的任何宿主节点都能收到，不依赖事件冒泡路径。
      if (!ref.current?.contains(target) && !target.closest?.("[data-menu-trigger]")) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 阻止冒泡：Esc 只关最上层菜单，不能再触发全局 Esc（关抽屉/清选择）。
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  // [契约] 依赖数组只写 onClose：外壳必须传稳定引用（useCallback 或模块级常量）。
  // 若每次渲染新建函数，effect 会重装监听并把焦点重新拉回第一个菜单项，键盘连续下移一步就跳回顶部。
  // 挂载期的首项聚焦就在这个 effect 内执行一次，这是“打开即定位首项”的唯一实现点，不能挪进渲染体。
  // 清理只移除这两个监听，不做焦点回收：焦点归还由外壳在卸载时决定，这里抢做会让 Esc 后焦点落空。
  }, [onClose]);
  const move = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    // 循环移动：末尾按 ↓ 回到首项，首项按 ↑ 到末项；当前焦点不在菜单项上时 index=-1，按 ↓ 从第一项开始。
    // [契约] index 为 -1 表示焦点不在任何菜单项上：此时按 ↓ 取模落到首项，按 ↑ 落到末项。
    // items 为空数组时取模得 NaN，可选链让聚焦静默跳过，空菜单不抛错。
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <div ref={ref} className={`menu ${className}`} role="menu" aria-label={label} onKeyDown={move}>
      {children}
    </div>
  );
}

// 菜单项：checked 为 undefined 时是普通动作项（menuitem），否则是互斥选项（menuitemradio）并显示勾选。
// 勾选时图标位被对勾覆盖，因此 checked 项不要再传 icon。
// 只负责渲染与回调；disabled 项仍可聚焦但点击不触发，保持键盘可达性一致。
// [契约] checked 是三态：undefined 输出 role=menuitem 且不写 aria-checked，true 与 false 输出 menuitemradio。
// 为真时勾选图标会顶掉 icon，同时传两者不报错但图标被静默丢弃。
// 组件没有 disabled 分支，禁用语义由调用方在 onSelect 内拦截；加原生 disabled 会让该项从 Tab 序列里消失。
// 只负责渲染与回调，不读外壳状态；改成受控组件会破坏菜单项纯展示的定位。
export function MenuItem({
  icon,
  checked,
  children,
  hint,
  onSelect,
}: {
  icon?: ReactNode;
  checked?: boolean;
  children: ReactNode;
  hint?: ReactNode;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className="mi"
      onClick={onSelect}
    >
      <span className="mi-icon">{checked ? <Icon name="check" size={16} /> : icon}</span>
      <span className="mi-label">{children}</span>
      {hint ? <span className="mi-hint">{hint}</span> : null}
    </button>
  );
}

/* ---------------------------------------------------------------- Find */

// 查找条：替换标题栏显示。计数口径：空查询或未知总数不显示；有查询且总数为 0 显示“无结果”。
// 回车/Shift+回车切换下一处/上一处，Esc 关闭并阻止冒泡（避免同时收抽屉）。
// 只回传意图，真正的查找与高亮由查看器执行。
// [契约] 受控输入：query/total/index 全部由查看器上报，敲字只回调 onQuery，本地不缓存文本。
// 计数口径见 INV-06：null 表示尚未出结果，0 表示确实无匹配，两者视觉必须可区分。
// 翻页按钮的禁用依赖 total 真值，因此 null 与 0 都会禁用，避免在无结果时反复发起查找。
// 回车只走 onStep，真正的定位与高亮由查看器执行；这里若自己滚动，会和查看器的锚点计算冲突。
export function FindBar({
  t,
  query,
  total,
  index,
  onQuery,
  onStep,
  onClose,
}: {
  t: Strings;
  query: string;
  total: number | null;
  index: number;
  onQuery(query: string): void;
  onStep(direction: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  // [契约] 空依赖是有意的：只在挂载时聚焦并全选，让用户打开即输入。
  // 若把 query 加进依赖，每敲一个字符都会重新全选，第二个字符直接覆盖第一个。
  // 聚焦动作必须在挂载后执行，渲染期调用拿不到真实 DOM，所以放在 effect 而非 render 里。
  }, []);
  // total 为 null 表示查看器尚未返回结果（如仍在渲染），此时不显示计数，避免闪出“0/0”。
  // [契约] 用真值判断 total 而非与 0 比较：0 因此落到“无结果”，NaN 与负值也被当成无结果，不会拼出非法计数。
  // findCount 的入参是 index+1（1-based），查看器的 index 是 0-based，这里少加 1 会整体错位一页。
  // 空查询直接给空串，避免残留上一次的“3/17”误导用户。
  const count =
    !query.trim() || total === null ? "" : total ? t.findCount(index + 1, total) : t.noResults;
  return (
    <div className="docbar findbar" role="search">
      <label className="findfield">
        <Icon name="search" className="muted" />
        <input
          ref={input}
          className="find-input"
          type="text"
          aria-label={t.find}
          placeholder={t.findPlaceholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onStep(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <span className="count" aria-live="polite">
          {count}
        </span>
      </label>
      <button
        type="button"
        className="btn icon dim"
        title={t.previousMatch}
        aria-label={t.previousMatch}
        disabled={!total}
        onClick={() => onStep(-1)}
      >
        <Icon name="chevron-up" />
      </button>
      <button
        type="button"
        className="btn icon dim"
        title={t.nextMatch}
        aria-label={t.nextMatch}
        disabled={!total}
        onClick={() => onStep(1)}
      >
        <Icon name="chevron-down" />
      </button>
      <button
        type="button"
        className="btn icon dim"
        title={t.closeFind}
        aria-label={t.closeFind}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Page / zoom pill */

// 页码胶囊的静止隐藏延时（毫秒）：无操作 1.5s 后淡出，不遮挡内容。
// [权衡] 1.5s 是“不挡内容”与“不频繁闪”的折中：调短会与阅读节奏打架，调长会长期遮住文档底部。
// `IDLE_MS` 只控制淡出延时，不控制唤醒；唤醒由滚动与 `pointermove` 热区独立触发。
// 改成 0 不会报错，只是胶囊几乎不可见，属于最难排查的“看起来没坏”型回归。
const IDLE_MS = 1500;

// 浮动页码/缩放控件：滚动、指针靠近底部、聚焦或悬停时出现，静止 1.5s 后淡出。
// 输入 page.current/count 由查看器上报，zoom 为 null 时只显示翻页部分（如 pptx）。
// 副作用：监听容器 scroll 与 pointermove；定时器在卸载时清除，不保留跨文档状态。
// 数字输入按草稿处理：失焦或 Esc 丢弃草稿，回车才提交并夹到 [1, count]。
/**
 * Floating page and zoom control. Shown while scrolling, while the pointer is near the bottom edge,
 * while focused or hovered; fades out after 1.5 s of stillness.
 */
// [契约] 可见性由本组件自治：滚动、底部热区、聚焦、悬停四条唤醒路径都在内部，外壳不传 visible。
// page 由查看器上报当前位置与总页数，zoom 为 null 时只渲染翻页段（pptx 走这条）。
// 定时器与监听都在 effect 内创建、卸载即清；不要提升到模块作用域复用，跨文档会串状态。
// 淡出只是加类名，元素仍在 DOM 中，因此仍可被 Tab 聚焦并自动重新唤醒。
export function PagePill({
  t,
  frame,
  page,
  zoom,
  onPage,
  onZoom,
  onFit,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  page: PageState;
  zoom: ZoomState | null;
  onPage(page: number): void;
  onZoom(direction: 1 | -1): void;
  onFit(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const hold = useRef(false);
  useEffect(() => {
    const container = frame.current;
    if (!container) return;
    let timer = 0;
    const idle = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        // [契约] 淡出要同时满足“未悬停”与“焦点不在胶囊内”，少一条就会把正在输入页码的用户踢下线。
        // hold 用 ref 而非 state：定时器闭包读到的必须是按下那一刻的最新值，state 会读到旧快照。
        // contains(document.activeElement) 同时覆盖输入框与按钮；焦点在内部时定时器到点也只是空转。
        if (!hold.current && !ref.current?.contains(document.activeElement)) setVisible(false);
      }, IDLE_MS);
    };
    const wake = () => {
      setVisible(true);
      idle();
    };
    // 指针进入底部 80px 热区即唤醒，给用户“准备翻页”时的可发现性；不改变文档内容。
    const near = (event: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      if (event.clientY > bounds.bottom - 80) wake();
    };
    // [资源] 注册与注销必须传同一个 capture 值：remove 只比对类型、回调与 capture，漏写会让监听永久残留。
    // passive:true 承诺不在滚动回调里阻止默认行为，滚动因此不进主线程阻塞，去掉会拖慢长文档。
    // wake 每次滚动都调用，但内部先清定时器再重排，等价于防抖，不会堆叠多个定时器。
    // 事件挂在 container 而非 window：只关心文档自身的滚动，页面其余区域滚动不该唤醒胶囊。
    container.addEventListener("scroll", wake, { capture: true, passive: true });
    container.addEventListener("pointermove", near, { passive: true });
    idle();
    return () => {
      clearTimeout(timer);
      container.removeEventListener("scroll", wake, { capture: true });
      container.removeEventListener("pointermove", near);
    };
  // [资源] 依赖 frame 引用而非 frame.current：容器 DOM 被替换时不会自动重跑，需要父级以 key 重挂载。
  // 清理函数里的 clearTimeout 与两次 removeEventListener 缺一不可，否则切文档后旧容器继续派发 scroll。
  // scroll 用 capture:true 才能收到内部滚动容器的滚动，冒泡阶段拿不到。
  // idle 在注册后立刻调用一次，保证首次出现也走同一条淡出路径，而不是永久常亮。
  }, [frame]);
  // [事务] 先把草稿置空再提交，避免 onPage 引发的重渲染里仍显示旧数字造成闪回。
  // 草稿为 null 时 Number(null) 得 0，被“大于等于 1”拦下，等同无操作。
  const go = () => {
    const value = Number(draft);
    setDraft(null);
    // 只接受正整数并夹到总页数；非法输入（空/0/非数字）直接丢弃草稿，保持原页。
    // [边界] 上限夹到 page.count、下限由“大于等于 1”保证，超界输入不会把查看器推到空白页。
    // page.count 是查看器最近一次上报值，若落后于真实页数，夹取会把用户挡在旧范围内，这是有意的保守策略。
    // Number.isInteger 同时排除 NaN 与小数，避免向查看器传非法页码。
    if (Number.isInteger(value) && value >= 1) onPage(Math.min(value, page.count));
  };
  return (
    <div
      ref={ref}
      className={`pill${visible ? "" : " faded"}`}
      onPointerEnter={() => {
        hold.current = true;
        setVisible(true);
      }}
      onPointerLeave={() => {
        hold.current = false;
      }}
      onFocus={() => setVisible(true)}
    >
      <button
        type="button"
        className="btn icon sm dim"
        title={t.previousPage}
        aria-label={t.previousPage}
        disabled={page.current <= 1}
        onClick={() => onPage(page.current - 1)}
      >
        <Icon name="chevron-up" />
      </button>
      <span className="pg">
        <input
          className="pgin"
          aria-label={t.pageNumber}
          inputMode="numeric"
          style={{ width: `${Math.max(2, String(page.count).length) + 1.6}ch` }}
          value={draft ?? String(page.current)}
          onFocus={(event) => {
            setDraft(String(page.current));
            event.target.select();
          }}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              go();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
        <span>{t.ofPages(page.count)}</span>
      </span>
      <button
        type="button"
        className="btn icon sm dim"
        title={t.nextPage}
        aria-label={t.nextPage}
        disabled={page.current >= page.count}
        onClick={() => onPage(page.current + 1)}
      >
        <Icon name="chevron-down" />
      </button>
      {zoom ? (
        <>
          <span className="vsep" />
          <button
            type="button"
            className="btn icon sm dim"
            title={t.zoomOut}
            aria-label={t.zoomOut}
            disabled={zoom.mode !== "width" && zoom.percent <= 25}
            onClick={() => onZoom(-1)}
          >
            <Icon name="minus" />
          </button>
          <button type="button" className="zoom" title={t.fitWidth} onClick={onFit}>
            {zoom.mode === "width" ? t.fit : `${zoom.percent}%`}
          </button>
          <button
            type="button"
            className="btn icon sm dim"
            title={t.zoomIn}
            aria-label={t.zoomIn}
            disabled={zoom.mode !== "width" && zoom.percent >= 400}
            onClick={() => onZoom(1)}
          >
            <Icon name="plus" />
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Selection bar and Ask */

// 操作条三态：bar（默认按钮组）、ask（提问输入框）、added（刚加入上下文，短暂反馈）。
// [契约] 三态由外壳驱动：bar 是默认按钮组，ask 展开提问框，added 是“已加入上下文”的短暂反馈，组件内部不自行切换。
// added 态只用于禁用重复添加并换文案，不代表选区已持久化——真正的上下文归属在外壳。
// 新增第四态必须同时改外壳的状态机与此处的渲染分支，否则会落回 bar 的默认按钮组。
export type BarMode = "bar" | "ask" | "added";

// 按下操作条时阻止默认行为，避免浏览器清空文档里的文本选区；
// textarea 例外（需要正常聚焦与光标放置）。
/** Keep the document's text selection when a press lands on the bar. */
// [契约] 按下操作条时阻止默认行为，保住文档里的文本选区；否则浏览器折叠选区，复制与提问引用全部丢失。
// 用 closest(textarea) 判断而非 target 类型，因为点击可能落在输入框的包裹层上。
// 只拦按下事件：连 click 一起拦会让按钮回调失效，这是最容易顺手写错的地方。
const keepSelection = (event: ReactMouseEvent) => {
  // [契约] textarea 是唯一例外：必须放行默认行为，否则光标无法落位、无法拖选。
  // 这里的阻止只作用于按下事件，不影响后续 click，按钮回调照常触发。
  if (!(event.target as Element).closest("textarea")) event.preventDefault();
};

// 选区操作条：贴在选择附近（ask 模式改到下方，给输入框让位；无锚点时 dock 到顶部居中）。
// 输入：locate 返回选择范围（可能为 null，此时靠 dock 兜底）；text 区分“文本选择”（可复制）
// 与“块/页/单元格范围”（显示标签）；canAsk 由宿主能力决定，不支持时不渲染提问按钮。
// 副作用：仅回调；提问内容与发送中状态是组件内部临时态，操作条卸载即丢弃。
// 失败语义：onSend 返回 false 时不改输入，用户可原地重试。
// [契约] 三态 mode 由外壳驱动，组件不自行切换；ask 分支只是换一棵 JSX 子树，状态仍在同一实例里。
// text 为真表示文本选择（给复制按钮），为假表示块、页或单元格范围（显示 label 占位）。
// canAsk 由宿主能力决定，不支持时整颗提问按钮不渲染而非置灰，避免出现永远点不动的入口。
// 提问内容与发送中状态都是内部临时态，操作条卸载即丢弃，外壳不持有草稿。
export function SelectionBar({
  t,
  frame,
  locate,
  text,
  label,
  quote,
  short,
  mode,
  canAsk,
  copied,
  onAdd,
  onAsk,
  onCopy,
  onCancelAsk,
  onSend,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  locate: Locate;
  /** A text selection (offers Copy) rather than a block, page or cell range (shows its label). */
  text: boolean;
  label: string;
  quote: string;
  /** Use the short "Add" label (spreadsheets, where the range label takes the room). */
  short: boolean;
  mode: BarMode;
  canAsk: boolean;
  copied: boolean;
  onAdd(): void;
  onAsk(): void;
  onCopy(): void;
  onCancelAsk(): void;
  onSend(question: string): Promise<boolean>;
}) {
  const asking = mode === "ask";
  // [权衡] ask 模式改到 bottom 侧：输入框高度大，仍贴顶部会被顶出视口；dock 用于 locate 返回 null 时兜底。
  // 定位全部交给 useFloating，组件不自行测量 DOM；要调间距只能改这里的参数，别在样式里补偏移。
  // 同一个 ref 只对应一个浮层实例，切换模式时参数变化由 useFloating 内部重新计算。
  const ref = useFloating<HTMLDivElement>(frame, locate, {
    side: asking ? "bottom" : "top",
    dock: true,
  });
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  // [并发] 入口守卫在空文本或发送中为真时直接返回，挡住双击与“回车加点击”两条并发提交。
  // [失败路径] 这里没有 try/finally：onSend 抛异常时发送中标记会停在 true，发送按钮从此禁用，直到组件重挂载。
  // 补 try/finally 要连带决定 `onSend` 失败提示的落点与重试入口，改动面大于本组件。
  // 等待期间不禁用输入框，用户仍可继续编辑；清空只在成功分支执行，避免抹掉失败草稿。
  // 发送中用 state 而非 ref：按钮禁用态要参与渲染，ref 改了不会触发重绘。
  const send = async () => {
    // 空文本或正在发送时忽略，防止双击/回车并发提交同一条提问。
    if (!question.trim() || sending) return;
    setSending(true);
    // [事务] 清空只在成功分支执行：返回 false 视为可重试失败，草稿原样保留，用户不必重打。
    // 等待返回后组件可能已卸载，此时 setState 走 React 的空更新，不抛错也不生效。
    // onSend 的契约是返回布尔而非抛异常表示失败，改成抛错会绕过这里的清理逻辑。
    const ok = await onSend(question.trim());
    setSending(false);
    if (ok) setQuestion("");
  };
  // [契约] 所有 hooks 都在这行分支之前调用：切换 ask 与 bar 只切 JSX，不改变 hook 调用顺序。
  // 把 useState 挪进任一分之内，模式切换就会触发 hook 数量变化，React 直接抛错而非静默降级。
  // 两个分支各自 return 一棵子树，问题草稿与发送中状态因此在模式间共享。
  if (asking)
    return (
      <div
        ref={ref}
        className="pop ask"
        role="dialog"
        aria-label={t.ask}
        onMouseDown={keepSelection}
      >
        <div className="ctx">
          <span className="where">{label}</span>
          {quote ? <span className="q">“{quote}”</span> : null}
        </div>
        <textarea
          autoFocus
          className="textarea"
          rows={2}
          aria-label={t.askPlaceholder}
          placeholder={t.askPlaceholder}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // [契约] isComposing 检查不可省：中文与日文输入法用回车确认候选词，缺了它会把半成品当提问发出去。
            // Shift+Enter 保留换行，所以条件必须先排除 shiftKey，否则多行提问无法断行。
            // nativeEvent 才是原生键盘事件的组合态标记，只看 React 合成事件的 key 判断不到输入法状态。
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancelAsk();
            }
          }}
        />
        <div className="row">
          <span className="hint">
            <kbd>↵</kbd> {t.sendKey}
          </span>
          <button type="button" className="btn sm" onClick={onCancelAsk}>
            {t.cancel}
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={!question.trim() || sending}
            onClick={() => void send()}
          >
            {t.send}
          </button>
        </div>
      </div>
    );
  return (
    <div
      ref={ref}
      className="pop bar"
      role="toolbar"
      aria-label={label}
      onMouseDown={keepSelection}
    >
      {!text ? (
        <>
          <span className="where">{label}</span>
          <span className="vsep" />
        </>
      ) : null}
      <button
        type="button"
        className="btn lg"
        title={t.addToChatHint}
        onClick={onAdd}
        disabled={mode === "added"}
      >
        {mode === "added" ? (
          <>
            <Icon name="check" size={16} className="ok" />
            {t.added}
          </>
        ) : (
          <>
            <Icon name="message-square-plus" size={16} />
            {short ? t.addShort : t.addToChat}
          </>
        )}
      </button>
      {canAsk ? (
        <button type="button" className="btn lg" onClick={onAsk}>
          <Icon name="message-circle-question" size={16} />
          {t.ask}
        </button>
      ) : null}
      {text ? (
        <>
          <span className="vsep" />
          <button
            type="button"
            className="btn icon lg dim"
            title={copied ? t.copied : t.copy}
            aria-label={copied ? t.copied : t.copy}
            onClick={onCopy}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Agent callout */

// Agent 引用气泡：贴在当前目标下方（offset 6，无锚点则 dock 顶部），展示说明与序号；
// total>1 时提供“下一处”，关闭只隐藏气泡，标记仍由查看器保留。
// note 可空：只有位置没有说明时仍显示“Agent”标题与序号。
// [契约] 气泡只做展示：关闭仅让外壳隐藏它，查看器里的高亮标记仍在，重新定位会再次出现。
// total 大于 1 才渲染“下一处”，序号用 index+1 转成 1-based，与查找条计数口径保持一致。
// note 可空，表示只有位置没有说明；判空用真值而非与空串比较，空串与 null 都不渲染正文。
// `onClose` 与 `onNext` 都只回调，不直接操作查看器：跳转由外壳统一调度。
export function AgentCallout({
  t,
  frame,
  locate,
  note,
  index,
  total,
  onNext,
  onClose,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  locate: Locate | null;
  note: string | null;
  index: number;
  total: number;
  onNext(): void;
  onClose(): void;
}) {
  // [权衡] offset 6 让气泡与目标之间留视觉缝隙又不脱节；side 固定 bottom，不做上方翻转，避免盖住被引用的段落。
  // locate 可为 null，dock 会在无锚点时把气泡停靠到视口顶部居中，而不是贴到左上角。
  // 位置计算完全依赖 useFloating；改 offset 只影响与选区操作条的间距观感，不影响任何逻辑。
  const ref = useFloating<HTMLDivElement>(frame, locate, { side: "bottom", offset: 6, dock: true });
  return (
    <div ref={ref} className="callout" role="note">
      <div className="body">
        <div className="who">
          <span className="dot" />
          {total > 1 ? t.agentOf(index + 1, total) : t.agent}
        </div>
        {note ? <div className="text">{note}</div> : null}
      </div>
      {total > 1 ? (
        <button
          type="button"
          className="btn icon sm dim"
          title={t.nextTarget}
          aria-label={t.nextTarget}
          onClick={onNext}
        >
          <Icon name="chevron-down" />
        </button>
      ) : null}
      <button
        type="button"
        className="btn icon sm dim"
        title={t.close}
        aria-label={t.close}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

// 屏外目标提示：点击跳到第一处屏外目标；raised 用于在分页文档中避让底部页码胶囊。
// down 决定箭头方向（目标在下方/上方），仅视觉提示，不参与判断。
// 文案由 offscreenText 生成，本组件不自行拼接数量；点击只回调，不直接操作查看器。
// [契约] 纯展示加单回调：不判断目标是否真的在屏外，也不执行滚动，跳转完全由 onClick 的实现方负责。
// raised 只加一个类名用于避让底部页码胶囊，不参与点击逻辑。
// 文案由 offscreenText 生成，本组件不自行拼数量，避免两处文案口径漂移。
export function OffscreenChip({
  text,
  down,
  raised,
  onClick,
}: {
  text: string;
  down: boolean;
  raised: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={`chip offscreen${raised ? " raised" : ""}`} onClick={onClick}>
      <span className="dot" />
      {text}
      <Icon name={down ? "arrow-down" : "arrow-up"} size={12} />
    </button>
  );
}

// 数量直接取 ats.length（不去重），位置描述走 describeAt 的 lower 形态；多于一处时不列出其余位置。
// 生成“还有 N 处 · 第 4 页”的提示文案；ats 非空由调用方保证，取第一处的位置做描述。
// 仅做字符串拼接与去重计数，不解析定位符语义；空数组返回空串，调用方据此隐藏胶囊。
/** "1 more on page 4" for targets outside the view. */
// [契约] 数量直接取 ats.length，故意不去重：同一位置的多条标记也算多处，去重会让提示数与实际跳转次数不符。
// [失败路径] ats 非空是调用方契约：空数组时首项为 undefined 传给 describeAt，会在格式化位置时出错。
// describeAt 第三参为 true 取 lower 形态（如“第 4 页”），保证嵌进句子后语序正确。
// 多语言文案全部来自 t.moreOn，此处只做拼装，不硬编码任何中文。
export function offscreenText(t: Strings, ats: string[]): string {
  return t.moreOn(ats.length, describeAt(ats[0], t, true));
}
