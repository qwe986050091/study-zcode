// INV-01 本模块只负责把动作翻译成 CDP Input 事件，不查找元素、不重试、不操作 DOM；守住位置：全部 dispatch 函数体；改错故障：绕开 CDP 改用别的注入方式后事件不再是 trusted，页面的 wheel 与 keydown 处理器直接不触发。
// INV-02 修饰键位掩码必须只有 MODIFIER_BITS 一个来源，Alt=1、Control=2、Meta=4、Shift=8；守住位置：MODIFIER_BITS 常量；改错故障：位值与 Chromium 约定不符，组合键被内核识别成另一组键。
// INV-03 ControlOrMeta 必须是按平台折叠的虚拟修饰键，darwin 取 Meta、其余平台取 Control；守住位置：MODIFIER_BITS 与 MODIFIER_KEY_MAP 中同名字段；改错故障：macOS 上 Cmd 组合被降级成 Ctrl，所有快捷键失效。
// INV-04 位掩码为 0 时不下发 modifiers 字段；守住位置：各 dispatch 函数里 mod 的三元赋值；改错故障：多出的零值字段与既有单测断言不符，也让内核把 0 当成显式覆盖。
// INV-05 键名归一化必须只做小写查表，未命中时保留原始大小写；守住位置：normalizeCuaKey 的别名回退；改错故障：未知键被强制小写，页面按 key 判断的分支认不出来。
// INV-06 键映射解析顺序固定为表内键、修饰键、单字母、数字、裸键；守住位置：keyDefinition 的逐级早返回；改错故障：顺序调换后 Space 与字母键被前面的分支截走，丢 code 与虚拟键码。
// INV-07 Space 的 key 是单个空格而 code 是 Space；守住位置：KEY_MAP 中的 Space 项；改错故障：把 key 写成 Space 后输入框收不到空格，快捷键也匹配不上。
// INV-08 单字母与数字的虚拟键码取大写字符的码点；守住位置：keyDefinition 的两个正则分支；改错故障：误用小写码点，内核按未知键处理，页面拿不到标准按键。
// INV-09 坐标只有在 cx 与 cy 同时为数字时才算有效，否则折叠成 null；守住位置：resolveRefCenter 的结构校验；改错故障：NaN 进入 CDP 被拒绝，或点击落到视口左上角。
// INV-10 坐标解析不重试也不吞异常，脚本执行的拒绝原样上抛；守住位置：resolveRefCenter 整体；改错故障：在此兜底后调用方以为元素存在，后续事件全部打到空坐标。
// INV-11 一次点击是同一坐标上的移动、按下、抬起三步，中间不得改变坐标；守住位置：dispatchClickAt 三次 send 的 x 与 y；改错故障：坐标漂移会触发 hover 位移，悬停菜单在按下前就收起。
// INV-12 双击只改变 clickCount，不额外增加事件序列；守住位置：clickCount 三元；改错故障：改成连续两次单击后浏览器不再合成 dblclick。
// INV-13 两点拖拽固定十段线性插值，最后一段精确落在终点；守住位置：STEPS 常量与循环取整；改错故障：段数过少被内核判为跳点，dragstart 不触发。
// INV-14 拖拽过程中的移动事件必须带 buttons:1，表示左键仍按住；守住位置：两条拖拽路径的插值事件；改错故障：缺 buttons 时被当作普通移动，选区与拖拽手柄不跟随。
// INV-15 路径拖拽用 finally 保证释放左键，失败时在最后已到达的点抬起；守住位置：dispatchDragPath 的 finally 块；改错故障：中途发送失败后按键一直按下，页面持续选中文本。
// INV-16 两点拖拽没有等价的 finally，中途失败会遗留按下状态，是已知薄弱点；守住位置：dispatchDrag 三段 await 之间；改错故障：误以为两条路径同样安全，异常后不清理导致后续输入错乱。
// INV-17 滚动先移动鼠标再发 mouseWheel，并且不使用合成滚动手势；守住位置：dispatchScrollGesture 的两次 send；改错故障：换回合成手势后在 Electron webview guest 中静默成功却完全不滚动。
// INV-18 组合键按修饰键依次按下、末键按下与抬起、修饰键逆序释放；守住位置：dispatchKeyPress 的循环顺序；改错故障：顺序颠倒后页面先收到抬起，快捷键不触发且修饰键卡在按下态。
//
// 模块职责：必须把 CUA 的点击、拖拽、滚动、按键动作翻译成 CDP Input 事件，只做事件组装与顺序编排。
// 状态所有权：本模块没有任何跨调用状态，唯一可变状态是组合键调用内有效的 pressedModifiers 集合；坐标由调用方持有。
// 阅读顺序：先读三张映射表与归一化函数，再按点击、拖拽、滚动、按键四条路径看发送序列，重点核对释放保证。
import type { BrowserKeyModifier, BrowserMouseButton } from "@zcode/shared";
import { RESOLVE_SCRIPT } from "./browserCommandScripts.js";
import type { BrowserPoint, ControlledView } from "./browserCommandTypes.js";

/**
 * 键盘修饰键 → CDP modifiers 位掩码（Alt=1, Control=2, Meta=4, Shift=8）。
 * click/press/drag 均复用此映射，透传给 dispatchMouseEvent/dispatchKeyEvent。
 */
// 修饰键到 Chromium 位掩码的唯一映射表，1、2、4、8 与 CDP Input 的约定必须一一对应，不可自行重排数值
// 表里只有五个成员，修饰键联合类型新增取值时这里必须同步补齐，否则查表得到 undefined 并被按位或静默吞掉
// ControlOrMeta 不是真实按键，而是在查表时就按当前平台定型为 Meta 或 Control 的折叠项
const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
};

/**
 * 常用键名 → CDP Input.dispatchKeyEvent 参数映射。
 * 未命中的 key 走裸传（仅带 key 字段），交给内核尽力解释。
 */
// 常用键必须把 key、物理 code 与 Windows 虚拟键码打包成一张表，按键与组合键两条路径共用同一份定义
// 表只收录需要完整三元组的键，未收录的键走裸 key 分支由内核推断 [权衡]
// Space 一行的 key 故意是单个空格字符，与直接下发字符串 Space 在页面侧是两种完全不同的按键
const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
};

const MODIFIER_KEY_MAP: Record<
  BrowserKeyModifier,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Alt: { code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  ControlOrMeta:
    process.platform === "darwin"
      ? { code: "MetaLeft", windowsVirtualKeyCode: 91 }
      : { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};

// 把 CUA 侧大小写不敏感的别名折叠成规范键名，查表前统一转小写再比对
// 进入函数先 trim，因此前后空格不会影响别名命中，只有空串会一路走到回退分支
// 别名表在每次调用时重新创建，属纯局部常量，因此没有跨调用状态但有稳定的微小分配 [资源]
function normalizeCuaKey(raw: string): string {
  const key = raw.trim();
  const alias: Record<string, string> = {
    alt: "Alt",
    option: "Alt",
    control: "Control",
    ctrl: "Control",
    controlormeta: process.platform === "darwin" ? "Meta" : "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    esc: "Escape",
    return: "Enter",
    space: "Space",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
  };
  // 命中别名就返回规范名，未命中则原样返回 trim 后的输入，保留大小写供后续按字面识别
  // 这条回退让任意未知键都能透传，代价是大小写写错的已知键会被降级成未知键 [失败路径]
  return alias[key.toLowerCase()] ?? key;
}

function asModifier(key: string): BrowserKeyModifier | undefined {
  return ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key)
    ? (key as BrowserKeyModifier)
    : undefined;
}

function keyDefinition(keyName: string): {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
} {
  const known = KEY_MAP[keyName];
  if (known) return known;
  const modifier = asModifier(keyName);
  if (modifier) return { key: modifier, ...MODIFIER_KEY_MAP[modifier] };
  if (/^[a-z]$/iu.test(keyName)) {
    const upper = keyName.toUpperCase();
    return { key: keyName, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/u.test(keyName)) {
    return {
      key: keyName,
      code: `Digit${keyName}`,
      windowsVirtualKeyCode: keyName.charCodeAt(0),
    };
  }
  // 映射链的最后一级兜底：只带 key 字段，不给 code 与虚拟键码，交给内核尽力解释 [权衡]
  // 能走到 normalizeCuaKey 这里说明既不在表内、不是修饰键、也不是单字母或数字，通常是自由文本键名
  // 选择裸传而不抛错，是为了让 dispatchKeyPress 组合键可以携带任意键名而无需在这里维护完整键表
  return { key: keyName };
}

// 对外唯一入口必须把修饰键数组压成一个位掩码，点击、拖拽、按键三条路径都从这里取值
// undefined 与空数组都返回 0，调用方据此决定是否省略 modifiers 字段
// 按位或累加，重复出现同一个修饰键不会翻倍，数组顺序也不影响结果
export function modifiersBitmask(mods?: readonly BrowserKeyModifier[]): number {
  if (!mods || mods.length === 0) return 0;
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BITS[m];
  return bits;
}

/** 解析 ref 元素中心坐标；未找到（含返回非法结构）→ null。 */
// 坐标解析入口：在受控视图里执行注入脚本，把 ref 换算成元素中心的视口坐标
// 脚本内容来自 RESOLVE_SCRIPT，本模块只负责触发与校验返回结构，不拼接选择器也不等待元素出现
// 每次 resolveRefCenter 调用都是一次跨进程脚本执行，连续点击场景下这里是主要开销点 [资源]
export async function resolveRefCenter(
  view: ControlledView,
  ref: string,
): Promise<BrowserPoint | null> {
  const raw = (await view.webContents.executeJavaScript(RESOLVE_SCRIPT(ref))) as {
    cx?: unknown;
    cy?: unknown;
  } | null;
  // 唯一的结构校验点必须把空结果、字段缺失、非数字一律折叠成 null，不区分具体原因 [失败路径]
  // 返回 null 而不抛错，使元素不存在与坐标不可用两种情形在上层走同一条降级路径
  if (!raw || typeof raw.cx !== "number" || typeof raw.cy !== "number") return null;
  return { cx: raw.cx, cy: raw.cy };
}

/** 在给定坐标发一次 CDP 真实鼠标点击（mouseMoved→mousePressed→mouseReleased）。 */
// dispatchClickAt 必须让坐标、按键、是否双击与位掩码全部显式传参，函数内部不做任何推断
// 三次事件共用同一个坐标，序列一旦中断不会回滚，所以语义上不存在半次点击 [失败路径]
// 函数不返回结果，成功即 resolve，任何 CDP 拒绝都直接冒泡给调用方处理
export async function dispatchClickAt(
  view: ControlledView,
  center: BrowserPoint,
  button: BrowserMouseButton,
  doubleClick: boolean,
  modifiers = 0,
): Promise<void> {
  const clickCount = doubleClick ? 2 : 1;
  // modifiers=0 时不带该字段，保持与既有单测（不含 modifiers 的断言）一致。
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.cx,
    y: center.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod,
  });
}

/**
 * 从起点拖到终点：mousePressed@from → 多个插值 mouseMoved → mouseReleased@to（带 modifiers）。
 * 拖拽期间的 mouseMoved 带 buttons:1（左键按住位）以让内核识别为拖拽而非普通移动。
 */
// dispatchDrag 必须只接受起点与终点，中间轨迹由内部等分插值，不处理手绘或曲线路径
// 按钮与修饰键语义与路径版一致，但缺少释放保证，是两条拖拽路径中较弱的一条 [失败路径]
export async function dispatchDrag(
  view: ControlledView,
  from: BrowserPoint,
  to: BrowserPoint,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  const STEPS = 10;
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.cx,
    y: from.cy,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.cx,
    y: from.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  // 从 1 循环到 STEPS 逐段取整插值，最后一段的坐标严格等于终点，避免累计取整误差 [权衡]
  // 每段都必须发一次真实移动事件，十个来回是拖拽延迟的主要构成 [资源]
  // 循环内不检查中断信号，调用方取消时已经发出的移动无法撤回
  for (let i = 1; i <= STEPS; i++) {
    const x = Math.round(from.cx + ((to.cx - from.cx) * i) / STEPS);
    const y = Math.round(from.cy + ((to.cy - from.cy) * i) / STEPS);
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "left",
      buttons: 1,
      ...mod,
    });
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.cx,
    y: to.cy,
    button: "left",
    clickCount: 1,
    ...mod,
  });
}

/** Drag 输入：逐点保留调用方 path，不把手绘/曲线路径重建为首尾直线。 */
// dispatchDragPath 必须逐点回放调用方给的折线，不把曲线轨迹重建为首尾直线
// 空路径在发出任何事件之前就抛错，因此不会留下按下的左键 [失败路径]
// 首点同时承担移动与按下两步，其余点只做按住移动，末点固定为最后一个被处理的点
export async function dispatchDragPath(
  view: ControlledView,
  path: readonly { x: number; y: number }[],
  modifiers = 0,
): Promise<void> {
  const [first, ...rest] = path;
  if (!first) throw new Error("cua_drag requires a non-empty path");
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.x,
    y: first.y,
    ...mod,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.x,
    y: first.y,
    button: "left",
    clickCount: 1,
    ...mod,
  });
  let last = first;
  try {
    for (const point of rest) {
      last = point;
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        ...mod,
      });
    }
  // 无论中间哪一次发送失败都会在最后抬起左键，这是路径版相对两点版的关键可靠性差异
  // 释放坐标取最后成功赋值的点，循环体先更新再发送，因此失败的那个点也被视为已到达 [权衡]
  } finally {
    await view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
      ...mod,
    });
  }
}

/** CUA scroll：先移动到锚点，再从该位置发送真实滚轮输入。 */
export async function dispatchScrollGesture(
  view: ControlledView,
  point: BrowserPoint,
  scrollX: number,
  scrollY: number,
  modifiers = 0,
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {};
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.cx,
    y: point.cy,
    ...mod,
  });
  // Electron 41 / Chromium 146 的 <webview> guest 会让
  // Input.synthesizeScrollGesture 静默成功但不产生 wheel 事件，页面因此完全不滚动。
  // mouseWheel 仍是命中锚点的 trusted input，可保留嵌套滚动区和 wheel handler 语义。
  await view.cdp.send("Input.dispatchMouseEvent", {
    // 滚动用真实 wheel 事件而非合成手势，因为 Electron 的 webview guest 会让后者静默成功却不产生任何 wheel 事件
    // 先移动鼠标再发滚轮，保证命中锚点而不是默认位置或上一次的鼠标位置
    // 两个方向的增量必须原样透传，不做方向翻转或速度换算，滚动手感由调用方负责 [权衡]
    type: "mouseWheel",
    x: point.cx,
    y: point.cy,
    deltaX: scrollX,
    deltaY: scrollY,
    ...mod,
  });
}

/** 组合键输入：逐键按下组合键，末键 down/up 后逆序释放其余按键。 */
// dispatchKeyPress 组合键入口：既接受含加号的键串也接受键数组，内部必须先拆分、再去空、最后归一化后统一处理
// 最后一个键视为主键，之前的键都作为修饰键被按住，结束后按相反顺序释放
// 拆分只认加号，键名自身含加号的情况无法表达，属于接口已知限制 [权衡]
export async function dispatchKeyPress(
  view: ControlledView,
  keys: readonly string[],
): Promise<void> {
  const normalized = keys
    .flatMap((key) => key.split("+"))
    .filter(Boolean)
    .map(normalizeCuaKey);
  const last = normalized.at(-1);
  if (!last) throw new Error("keypress requires at least one key");
  const held = normalized.slice(0, -1);
  const pressedModifiers = new Set<BrowserKeyModifier>();

  // 内部闭包负责单次按键发送，同时维护本次调用内有效的修饰键集合，顺序正确性依赖这一集合
  // 每发一个事件前重新计算位掩码，因此后按下的修饰键会叠加到之后所有事件的 modifiers 上
  const dispatch = async (type: "keyDown" | "keyUp", keyName: string): Promise<void> => {
    const modifier = asModifier(keyName);
    if (type === "keyDown" && modifier) pressedModifiers.add(modifier);
    if (type === "keyUp" && modifier) pressedModifiers.delete(modifier);
    const definition = keyDefinition(keyName);
    const modifiers = modifiersBitmask([...pressedModifiers]);
    await view.cdp.send("Input.dispatchKeyEvent", {
      type,
      ...definition,
      ...(modifiers > 0 ? { modifiers } : {}),
    });
  };

  for (const key of held) await dispatch("keyDown", key);
  await dispatch("keyDown", last);
  await dispatch("keyUp", last);
  for (const key of held.toReversed()) await dispatch("keyUp", key);
}

/** 发一次按键（keyDown + keyUp）；已知键带完整映射，未知键裸传 key。modifiers 位掩码可透传。 */
// dispatchKey 单键入口：一次按下加一次抬起，不解释加号也不保持按住状态
// 第四参数是目标会话标识，会透传给 cdp.send 的第三个参数，用于把输入定向到指定 target
export async function dispatchKey(
  view: ControlledView,
  keyName: string,
  modifiers = 0,
  sessionId?: string,
): Promise<void> {
  const def = KEY_MAP[keyName];
  const base = def
    ? { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    : { key: keyName };
  // modifiers=0 时不带该字段，保持与既有单测（不含 modifiers 的断言）一致。
  const mod = modifiers > 0 ? { modifiers } : {};
  // 按会话标识是否为空分成两条发送分支，避免无会话时多传一个 undefined 参数 [权衡]
  // 两次发送复用同一份基础字段快照，保证按下与抬起的 key、code 与虚拟键码完全一致
  const sendKey = (type: "keyDown" | "keyUp") =>
    sessionId == null
      ? view.cdp.send("Input.dispatchKeyEvent", { type, ...base, ...mod })
      : view.cdp.send("Input.dispatchKeyEvent", { type, ...base, ...mod }, sessionId);
  await sendKey("keyDown");
  await sendKey("keyUp");
}
