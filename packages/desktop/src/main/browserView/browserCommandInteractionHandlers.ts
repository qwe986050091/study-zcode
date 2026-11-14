// INV-01 交互命令的坐标只有 ref 与 (x,y) 两个来源，二者都缺失时必须报错而非默认落到原点；守住位置：resolveCommandPoint 的末尾分支；改错故障：点击打到视口左上角，模型以为操作成功并继续后续步骤。
// INV-02 ref 解析失败必须立即以 refNotFound 结束，不得继续派发任何输入；守住位置：handleClick/handleType/handlePress/handleScroll/handleDrag 的早退分支；改错故障：返回 ok 却什么都没点到，上层重试放大副作用。
// INV-03 所有坐标都是 CSS 视口像素，不做 DPR 缩放也不加滚动偏移；守住位置：resolveCommandPoint 与 resolveDragPoint 的返回值；改错故障：高分屏或已滚动页面上点位整体偏移，点到相邻元素。
// INV-04 一次点击固定是同一坐标上的 mouseMoved、mousePressed、mouseReleased 三步；守住位置：handleClick 转交给 dispatchClickAt 的调用点；改错故障：缺移动步时页面收不到 hover 前置态，悬停菜单不会展开。
// INV-05 双击只由 doubleClick 严格等于 true 打开，缺省是单击；守住位置：handleClick 的第四参数；改错故障：普通点击被识别成双击，列表项被误展开或表单被重复提交。
// INV-06 press 必须是 keyDown 紧跟 keyUp，两次事件共用同一份键定义；守住位置：handlePress 转交给 dispatchKey 的调用点；改错故障：只发一半时页面认为按键一直按住，后续输入全部被当成组合键。
// INV-07 type 带 ref 时必须先点击聚焦再粘贴；守住位置：handleType 的 command.ref 分支；改错故障：文本落到上一个焦点或页面空白处，用户看到输入框仍然为空。
// INV-08 文本输入统一走虚拟剪贴板粘贴，不能逐字符键入；守住位置：handleType 末尾的粘贴调用；改错故障：受控组件与输入法丢字符或顺序错乱，提交内容与预期不符。
// INV-09 select 必须在页面内同时派发 input 与 change，并区分 ref 缺失、非 select、无匹配三类失败；守住位置：handleSelect 的 error 分支链；改错故障：受控表单状态不同步，界面显示新值而提交仍是旧值。
// INV-10 check 表达的是目标勾选态而不是切换，只有状态需要变化时才触发原生 click；守住位置：handleCheck 的 checked 缺省值 true；改错故障：对已勾选项再点一次把它取消，批量勾选结果反向。
// INV-11 drag 的起点与终点各自独立解析，任一失败必须整体放弃，不允许只发生半程拖拽；守住位置：handleDrag 的两次 resolveDragPoint；改错故障：元素被拖到中途停住，可拖拽列表顺序被打乱。
// INV-12 cuaDrag 必须按调用方给出的点序列逐点回放，不能压成首尾直线；守住位置：handleCuaDrag 转交给 dispatchDragPath 的调用；改错故障：画布笔迹断线或折线被拉直，轨迹类校验必然失败。
// INV-13 不带 ref 的 scroll 用 x/y 充当 deltaX/deltaY，事件坐标必须固定 (0,0)；守住位置：handleScroll 的 CDP 参数对象；改错故障：滚动落在视口左上角，目标滚动容器纹丝不动。
// INV-14 带 ref 的 scroll 只做坐标解析与校验，不会额外补发滚轮事件；守住位置：handleScroll 的 command.ref 早退分支；改错故障：重复滚动把目标元素推出视口，后续点击全部落空。
// INV-15 domCuaScroll 在缺少 nodeId 时以 cssVisualViewport 的一半作为手势中心；守住位置：handleDomCuaScroll 的坐标换算；改错故障：用布局视口尺寸算中心，滚动点偏出可滚动区域而静默无效。
// INV-16 布局度量缺失时必须显式返回 execution_error，不得回退到 0 尺寸坐标；守住位置：handleDomCuaScroll 的 typeof 校验；改错故障：滚动作用在 NaN 坐标上，内核拒绝后命令看起来执行过但页面没动。
// INV-17 elementInfo 未命中元素返回 ok 且不带 element 字段，不算失败；守住位置：handleElementInfo 的空结果分支；改错故障：把空命中当异常抛出，整轮自动化在空白处中断。
// INV-18 每个 handle 函数返回前都要读取一次最新状态快照；守住位置：各 handle 末尾的 readState 调用；改错故障：调用方拿到过期 DOM 状态，下一步决策基于旧页面内容。
//
// 模块职责：把 BrowserCommand 的交互类 method 翻译成 CDP 输入事件，统一完成坐标解析、参数校验与结果封装，不持有元素引用。
// 状态所有权：本模块无跨调用状态，ref 与页面状态归 browserCommandState，返回值只由 done 回调补上耗时字段。
// 阅读顺序：先看 resolveCommandPoint 与 resolveDragPoint 的坐标契约，再按 click、type、press、scroll 逐条看事件序列，最后看 drag 与脚本类分支的失败路径。
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import { browserSnapshotElementSchema } from "@zcode/shared";
import {
  dispatchClickAt,
  dispatchDrag,
  dispatchDragPath,
  dispatchKey,
  dispatchKeyPress,
  dispatchScrollGesture,
  modifiersBitmask,
  resolveRefCenter,
} from "./browserCommandInput.js";
import { CHECK_SCRIPT, ELEMENT_AT_POINT_SCRIPT, SELECT_SCRIPT } from "./browserCommandScripts.js";
import { readState } from "./browserCommandState.js";
import type { BrowserPoint, ControlledView } from "./browserCommandTypes.js";
import type { BrowserCommandDone } from "./browserCommandResult.js";
import { executionError, refNotFound } from "./browserCommandResult.js";
import { pasteTextIntoFocusedTarget } from "./browserVirtualClipboard.js";

export async function handleClick(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "click" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // ref 与坐标 (x,y) 二选一：ref 走 resolveRefCenter（脚本内已 scrollIntoView），(x,y) 直接用作视口坐标。
  // 动作分发不在本文件：执行器按 method 做 switch，把 click、type、press、scroll、hover、select、check、drag 等逐个转给对应 handle，这里少一个导出就会落到 capability_unsupported。
  // click 的坐标来源只有两条：带 ref 时由注入脚本先 scrollIntoView 再取元素中心，带 x 与 y 时直接当作视口坐标；两者都没有时以 execution_error 结束且不派发事件。
  // resolveCommandPoint 每调用一次就独立解析一次，不缓存上一次的点位，因为页面可能在两条命令之间滚动或重排。
  const center = await resolveCommandPoint(view, command, "click");
  if (center.kind === "error") return done(center.error);
  // press 与 release 的顺序由 dispatchClickAt 固定为 mouseMoved、mousePressed、mouseReleased，三步共用同一坐标与同一份修饰键位掩码。
  // 鼠标按钮缺省是 left，doubleClick 只把 clickCount 提到 2，不会追加第二轮按下抬起，浏览器据此自行合成 dblclick。
  // [失败路径] 三步之间没有回滚：第二步被 CDP 拒绝时异常直接冒泡到执行器并归类为 execution_error，页面可能停在按下态直到下一次真实输入。
  await dispatchClickAt(
    view,
    center.point,
    command.button ?? "left",
    command.doubleClick === true,
    modifiersBitmask(command.modifiers),
  );
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleType(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "type" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 带 ref 先点击聚焦；输入阶段重新在指定 guest 内解析 focused frame，避免 Electron
  // embedder 的 composer autofocus 在 click/type 间隙抢回 app focus 后接收到网页文本。
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref);
    if (!center) return done(refNotFound(command.ref));
    await dispatchClickAt(view, center, "left", false);
  }
  // 文本输入带 ref 时先发一次完整点击把焦点交给目标元素，再走虚拟剪贴板粘贴，绕开逐字符键入被输入法与受控组件改写的风险。
  // [并发] 聚焦点击与粘贴之间不重新校验焦点归属：页面若在这段间隙里自己切换焦点，文本会落到新的焦点元素上。
  // 不带 ref 时只粘贴到当前焦点，不会主动点击，因此调用方必须先确保页面里有可接收文本的元素处于聚焦态。
  await pasteTextIntoFocusedTarget(view, command.text);
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handlePress(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "press" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 带 ref 先点击聚焦；再按 KEY_MAP 发 keyDown+keyUp（modifiers 位掩码透传）。
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref);
    if (!center) return done(refNotFound(command.ref));
    await dispatchClickAt(view, center, "left", false);
  }
  // press 的最小序列是一次 keyDown 加一次 keyUp，两次事件复用同一份 key、code 与虚拟键码，保证页面按 key 与按 code 判断的分支都能命中。
  // 修饰键以位掩码透传，位掩码为 0 时整个 modifiers 字段必须缺席，避免把显式零值写进内核造成与既有断言不一致。
  // [失败路径] 键表未收录的键只带 key 字段裸传，页面依赖 code 或虚拟键码的快捷键会静默无效且不报错。
  await dispatchKey(view, command.key, modifiersBitmask(command.modifiers));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleCuaKeypress(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "cuaKeypress" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // cuaKeypress 支持组合键：修饰键依次按下，末键按下并抬起，再逆序释放修饰键，顺序由 dispatchKeyPress 保证，本层只做转交。
  // [失败路径] 空键数组会在发出任何事件之前抛出错误，最终映射为 execution_error，而不是超时或取消。
  // 组合键拆分只认加号，键名本身含加号的写法无法表达，属于协议侧的已知限制。
  await dispatchKeyPress(view, command.keys);
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleScroll(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "scroll" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 带 ref：复用 resolveRefCenter（脚本内已 scrollIntoView(block:'center')）；
  // 否则用 x/y 作为滚轮增量，position 固定 (0,0)，deltaX/deltaY 生效。
  if (command.ref) {
    const center = await resolveRefCenter(view, command.ref);
    if (!center) return done(refNotFound(command.ref));
    return done({ ok: true, state: readState(view.webContents) });
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 0,
    y: 0,
    // 不带 ref 的 scroll 把 x 与 y 当作滚轮增量，事件坐标固定为 (0,0)，方向与幅度完全由调用方给出，本层不翻转也不缩放。
    // [权衡] 固定原点让滚轮落在视口左上角，页面若只在内层容器上监听滚轮就可能收不到事件，此时应改用 cuaScroll 指定锚点。
    // 该分支只发一次 mouseWheel，没有前置 mouseMoved，因此不具备命中锚点的语义，也不能携带修饰键。
    deltaX: command.x ?? 0,
    deltaY: command.y ?? 0,
  });
  return done({ ok: true, state: readState(view.webContents) });
}

// cuaScroll 走 dispatchScrollGesture：先把鼠标移到 (x,y) 锚点，再从同一坐标发 mouseWheel，确保滚轮命中的是目标容器而不是上一次的鼠标位置。
// [权衡] 刻意不使用合成滚动手势，因为 Electron 的 webview guest 会让它静默成功却不产生任何 wheel 事件。
export async function handleCuaScroll(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "cuaScroll" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // scrollX 与 scrollY 原样作为 deltaX 与 deltaY 透传；修饰键同时作用于移动与滚轮两次事件，Ctrl 加滚轮的缩放语义依赖这一位掩码。
  // [资源] 一次 cuaScroll 固定两次 CDP 往返，未做合并或节流，连续滚动时往返开销是主要成本。
  await dispatchScrollGesture(
    view,
    { cx: command.x, cy: command.y },
    command.scrollX,
    command.scrollY,
    modifiersBitmask(command.modifiers),
  );
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleDomCuaScroll(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "domCuaScroll" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  let point: BrowserPoint | null;
  if (command.nodeId) {
    point = await resolveRefCenter(view, command.nodeId);
    if (!point) return done(refNotFound(command.nodeId));
  } else {
    // domCuaScroll 在缺少 nodeId 时取 cssVisualViewport 的一半作为手势中心；这里要的是 CSS 像素视口，而不是布局视口或物理像素。
    // [权衡] 视口中心只是一个约定，页面若只在局部容器内可滚动，中心点可能落在不可滚动区域，此时手势静默无效。
    const metrics = (await view.cdp.send("Page.getLayoutMetrics")) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const width = metrics.cssVisualViewport?.clientWidth;
    const height = metrics.cssVisualViewport?.clientHeight;
    if (typeof width !== "number" || typeof height !== "number") {
      return done(executionError("Page.getLayoutMetrics returned no cssVisualViewport"));
    }
    // 除法必须保留小数，不做取整，中心坐标允许是非整数 CSS 像素，内核自行处理亚像素点位。
    // [失败路径] 上面的类型校验在宽高缺失时立即以 execution_error 结束，而不是回退成 0 尺寸，避免把滚动作用到 NaN 坐标。
    point = { cx: width / 2, cy: height / 2 };
  }
  await dispatchScrollGesture(view, point, command.scrollX, command.scrollY);
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleHover(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "hover" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // ref(经 resolveRefCenter) 或 (x,y) → CDP mouseMoved 触发 hover 态。
  // hover 与 click 共用 resolveCommandPoint，坐标校验路径完全一致，差别只在事件类型是 mouseMoved 而非按下与抬起。
  // [权衡] 只发移动事件不会触发点击类副作用，但依赖 mousedown 才展开的菜单在 hover 下不会出现。
  const center = await resolveCommandPoint(view, command, "hover");
  if (center.kind === "error") return done(center.error);
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.point.cx,
    y: center.point.cy,
    // hover 的修饰键只在位掩码大于 0 时才展开进事件对象，否则字段整体缺席，省略策略与 click、press 保持一致。
    ...(modifiersBitmask(command.modifiers) > 0
      ? { modifiers: modifiersBitmask(command.modifiers) }
      : {}),
  });
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleSelect(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "select" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 在页面里对该 <select> 按 values 设选中态（先 value 精确匹配、再可见文本匹配）并派发 input+change。
  const raw = (await view.webContents.executeJavaScript(
    SELECT_SCRIPT(command.ref, command.values),
  )) as { ok?: boolean; error?: string } | null;
  if (!raw || typeof raw !== "object")
    return done(executionError("select returned invalid result"));
  if (raw.error === "ref_not_found") return done(refNotFound(command.ref));
  if (raw.error === "not_select") {
    return done(executionError(`element ${command.ref} is not a <select>`));
  }
  if (raw.error === "no_match") {
    return done(executionError(`no <option> matched values ${JSON.stringify(command.values)}`));
  }
  // select 的失败按脚本返回的 error 字符串逐项分类：ref 缺失走 refNotFound，非 select 与无匹配走 execution_error，未知错误兜底成 select failed。
  // [失败路径] 脚本返回非对象时按 invalid result 处理，说明注入脚本被页面篡改或执行环境异常，而不是选择器写错。
  if (raw.error) return done(executionError(`select failed: ${raw.error}`));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleCheck(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "check" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 设置 ref 指向的 checkbox/radio 勾选态到 checked(缺省 true)；状态需变时原生 click 派发事件。
  const raw = (await view.webContents.executeJavaScript(
    CHECK_SCRIPT(command.ref, command.checked ?? true),
  )) as { ok?: boolean; error?: string } | null;
  if (!raw || typeof raw !== "object") return done(executionError("check returned invalid result"));
  if (raw.error === "ref_not_found") return done(refNotFound(command.ref));
  // check 的语义是设置目标勾选态而非切换，checked 缺省为 true，脚本只在当前状态与目标不同时才派发原生 click 以产生事件。
  // ref 缺失、元素不可勾选、其余脚本错误必须分别映射为三类结果，错误信息里带上 ref 便于模型自我纠正。
  if (raw.error === "not_checkable") {
    return done(executionError(`element ${command.ref} is not a checkbox/radio`));
  }
  if (raw.error) return done(executionError(`check failed: ${raw.error}`));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleDrag(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "drag" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 起点=fromRef 或 from{x,y}，终点=toRef 或 to{x,y} → CDP 合成鼠标拖拽序列。
  // drag 的起点与终点各自独立解析：fromRef 或 from 坐标、toRef 或 to 坐标，任一缺失就以 execution_error 拒绝，不会只拖半程。
  // 解析顺序固定为先起点后终点，两端都非法时先暴露 from 的错误，错误文案里的 label 由调用处传入。
  // [权衡] 坐标不做视口边界裁剪，超出视口的点仍会下发，是否接受由内核决定。
  const from = await resolveDragPoint(view, command.fromRef, command.from, "from");
  if (from.kind === "error") return done(from.error);
  const to = await resolveDragPoint(view, command.toRef, command.to, "to");
  if (to.kind === "error") return done(to.error);
  await dispatchDrag(view, from.point, to.point, modifiersBitmask(command.modifiers));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleCuaDrag(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "cuaDrag" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // cuaDrag 逐点回放调用方给出的路径，不能把折线重建成首尾直线，首点承担移动与按下，其余点只做按住移动。
  // [失败路径] 路径版在 finally 中释放左键，中途任何一次移动失败都会在最后到达的点抬起，不会把按键留在按下态。
  // 空路径在发出任何事件之前就抛错，异常冒泡到执行器后归类为 execution_error，页面不会残留按下状态。
  await dispatchDragPath(view, command.path, modifiersBitmask(command.modifiers));
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleElementInfo(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "elementInfo" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 视口坐标 (x,y) → document.elementFromPoint → 复用快照元素结构（现分配 ref 存入 __zcodeRefs）。
  const raw = await view.webContents.executeJavaScript(
    ELEMENT_AT_POINT_SCRIPT(command.x, command.y),
  );
  if (raw == null) {
    // 命中不到元素：ok:true 但省略 element。
    return done({ ok: true });
  }
  // elementInfo 把注入脚本的返回交给 shared 的 schema 校验，形状不符时只取第一条 issue 的 message 组装错误，避免把整段对象回传。
  // [权衡] 复用快照元素结构让 elementInfo 与 snapshot 的 ref 语义一致，代价是 ref 分配必须在页面脚本内完成。
  const parsed = browserSnapshotElementSchema.safeParse(raw);
  if (!parsed.success) {
    return done(
      executionError(
        `invalid element result shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      ),
    );
  }
  return done({ ok: true, element: parsed.data });
}

async function resolveCommandPoint(
  view: ControlledView,
  command: { ref?: string; x?: number; y?: number },
  label: "click" | "hover",
): Promise<
  | { kind: "ok"; point: BrowserPoint }
  | { kind: "error"; error: Omit<BrowserCommandResult, "elapsedMs"> }
> {
  if (command.ref) {
    const point = await resolveRefCenter(view, command.ref);
    if (!point) return { kind: "error", error: refNotFound(command.ref) };
    return { kind: "ok", point };
  }
  if (typeof command.x === "number" && typeof command.y === "number") {
    return { kind: "ok", point: { cx: command.x, cy: command.y } };
  }
  // resolveCommandPoint 的第三种出口是参数缺失：ref 与坐标都没给时按 label 拼出可读错误，click 与 hover 共用同一段文案结构。
  // [失败路径] x 与 y 必须同时为数字，只给其中一个会被判为缺失，而不是把另一个补成 0。
  return { kind: "error", error: executionError(`${label} requires ref or (x,y)`) };
}

async function resolveDragPoint(
  view: ControlledView,
  ref: string | undefined,
  point: { x: number; y: number } | undefined,
  label: "from" | "to",
): Promise<
  | { kind: "ok"; point: BrowserPoint }
  | { kind: "error"; error: Omit<BrowserCommandResult, "elapsedMs"> }
> {
  if (ref) {
    const center = await resolveRefCenter(view, ref);
    if (!center) return { kind: "error", error: refNotFound(ref) };
    return { kind: "ok", point: center };
  }
  // resolveDragPoint 的坐标分支把 x 与 y 直接映射成 cx 与 cy，不能取整也不能裁剪，语义与 click 的坐标一致。
  // ref 分支优先于坐标分支，两者同时给出时坐标被忽略，这一优先级必须在 click、hover、drag 三处保持一致。
  if (point) return { kind: "ok", point: { cx: point.x, cy: point.y } };
  return { kind: "error", error: executionError(`drag requires ${label}Ref or ${label}{x,y}`) };
}
