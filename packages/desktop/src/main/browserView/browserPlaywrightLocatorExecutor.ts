// ============================================================
// browserView/browserPlaywrightLocatorExecutor —— IAB locator 的 CDP 执行会话
// 定位：把 BrowserPlaywrightAction 的 locator 语义（Playwright injected selector、
//       strict 模式、actionability、frame 穿透、trusted input）落到独立 CDP 会话执行。
// 关键取舍：selector 解析与 DOM 状态判断全部在 Playwright isolated world 完成，
//           点击/按键必须走 CDP Input；页面主 world 看不到 synthetic event。
// ============================================================
// INV-1：所有可见性/严格匹配判断只能由 injected.querySelectorAll + elementState 得出；
//        host 侧不得用自写 CSS 匹配替代，否则与快照选择器的注入版本漂移。
// INV-2：STRICT_VISIBLE_SELECTOR_HELPER 必须与 domSnapshot 使用同一份 Playwright runtime；
//        两处版本不一致会表现为「快照能看到、操作却匹配不到」。
// INV-3：selector 的 frame 链只能按 >> internal:control=enter-frame >> 切分；
//        切分必须跳过引号内与转义字符，否则选择器文本里的 >> 会被误当层级。
// INV-4：一次 pointer 动作的坐标必须来自同一份 target/boundaries 快照；
//        中途重解析会让点击坐标与 hit-target 校验指向不同的 frame 几何。
// INV-5：strict 冲突只在「恰好一个可见候选」时降级，可见候选多于一个必须抛
//        strictModeViolationError；改成取第一个隐藏元素会点错 desktop/mobile 双份 DOM。
// INV-6：重试预算由 deadline 单向递减，任何路径不得重置；
//        否则 actionability 永不成立时会把 3s 预算放大成 MCP 30s 超时。
// INV-7：perform 一旦执行即视为提交；此后不得再回到 probe 循环，
//        否则 click/dblclick 会被执行两次，勾选类元素状态被翻转。
// INV-8：needsStable 只在 pointer 动作开启；fill/type 必须关闭，
//        因为持续动画会让 stable 永不成立，最终卡到调用方 hard timeout。
// INV-9：fill 永远按 force=false 检查 visible/enabled/editable；force 只能放宽 pointer 动作。
// INV-10：isRecoverableLocatorRace 只覆盖 context destroyed / frame detached / target navigated；
//        扩大匹配面会把权限错误、协议不支持等确定性错误吞成无限重试。
// INV-11：contexts 的键必须是 sessionId + frameId；同 frameId 在 OOPIF 下可能由不同 session 承载。
// INV-12：dispose/resetDocumentContexts 必须先 detach 再清集合，detach 失败不得阻断清理。
// INV-13：Runtime.evaluate.timeout 约束不了 injected 内的 rAF 等待，
//         必须由 raceActionProbe 在 host 侧竞速并在超时后 terminateExecution。
// INV-14：所有 CDP 调用必须先看 signal.aborted；abort 后继续发请求会留下无人消费的响应。
//
// [并发] 本类不是线程安全的：同一 session 的 execute 必须由上层串行调用。
//        并发进入时 pointerAttempt 与 lastReason 会互相覆盖，两个 perform 可能同时点击。
/* eslint-disable max-lines -- Playwright isolated-world selector、frame target 与 CDP trusted input 必须共享同一会话状态。 */
import type {
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "@zcode/shared";
import { logger } from "../logger.js";
import {
  dispatchClickAt,
  dispatchKey,
  modifiersBitmask,
} from "./browserCommandInput.js";
import type { ControlledView } from "./browserCommandTypes.js";
import {
  assertFocusedInputTarget,
  createInputTargetToken,
  IAB_INPUT_TARGET_TOKEN_PROPERTY,
  pasteTextIntoFocusedTarget,
} from "./browserVirtualClipboard.js";
import { getPlaywrightInjectedScriptSource } from "./playwrightInjectedScriptSource.js";

// LocatorAction 从 shared 的 BrowserPlaywrightAction 联合类型中「提取」locator 分支，
// 而不是重新声明字段：shared 新增操作/字段时这里会立刻编译失败，
// 避免 executor 与协议 schema 各维护一份 locator 契约。
type LocatorAction = Extract<BrowserPlaywrightAction, { name: "locator" }>;

// [权衡] isolated world 名必须与 domSnapshot 注入脚本使用同一个常量值。
// 若两处用不同 worldName，Chrome 会创建两个独立执行环境，
// snapshot 注入的 Playwright runtime 在 locator 侧不可见，
// 表现为「选择器能解析但 querySelectorAll 恒为空」。
// 改成主 world 注入会更简单，但页面脚本可改写 document/querySelector，
// 从而劫持 actionability 判断。
const PLAYWRIGHT_WORLD_NAME = "zcode-playwright-locator";
// [失败路径] 该全局名是 injected 实例的唯一锚点，inject() 靠它探测是否已初始化。
// 若改成每次无条件重新注入，会覆盖页面已缓存的 InjectedScript，
// 正在等待 rAF 的 promise 会挂在旧实例上，形成永不 resolve 的 probe。
const PLAYWRIGHT_GLOBAL = "__zcodePlaywrightInjected";
// 轮询间隔是 actionability 的观测粒度，不是等待预算。
// 调大：短动画场景会跳过 probe，白白消耗剩余预算；
// 调小：会在帧内反复 evaluate，与页面 rAF 抢主线程，反而推迟 stable。
const POLL_INTERVAL_MS = 50;
// 响应式页面可能同时保留 desktop/mobile 两份 DOM。若仅因匹配数大于 1 就在 host
// 侧抛通用错误，会错过唯一可见元素，也会丢失 Playwright 提供的候选详情。
// [权衡] 严格模式降级放在注入脚本内、而不是 host 侧二次查询：
// host 侧只能看到 matches.length，看不到每个候选的 visible 状态，
// 也无法复用 elementState 的可见性口径（含 opacity/clip/尺寸）。
// 注入侧实现还能直接调用 strictModeViolationError，错误文本与 Playwright 原生一致。
// 注意 helper 文本本身是一段字符串，任何改动都必须保持为合法 JS 且不带注释符号。
const STRICT_VISIBLE_SELECTOR_HELPER = `
function querySelectorStrictWithVisibleFallback(injected, parsedSelector, root) {
  const matches = injected.querySelectorAll(parsedSelector, root);
  if (!matches.length) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return null;
  }

  if (matches.length === 1) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return matches[0];
  }

  const visibleMatches = matches.filter((element) => {
    const state = injected.elementState(element, "visible");
    return !!state.matches;
  });
  if (visibleMatches.length === 1) return visibleMatches[0];

  throw injected.strictModeViolationError(parsedSelector, matches);
}
`;

// [失败路径] 拼接注入脚本必须 JSON.stringify(selector)，不能直接模板插值：
// selector 可能包含引号/反斜杠，裸插值会提前闭合字符串，
// 页面侧 SyntaxError 会被 CDP 包成通用 evaluation failed，丢掉真实选择器上下文。
// 该函数产出的 resolvedElement 是后续 missingGuard 的唯一来源，
// 调用方不得自行解析 selector，否则两处 strict 口径会分叉。
function strictVisibleSelectorSetup(selector: string): string {
  return `${STRICT_VISIBLE_SELECTOR_HELPER}
      const parsedSelector = injected.parseSelector(${JSON.stringify(selector)});
      const resolvedElement = querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      const elements = resolvedElement ? [resolvedElement] : [];`;
}

// CdpTarget 同时承载「在哪个 frame」与「走哪个 session」两个维度。
// flatten 模式下子 frame 可能与主 frame 共用 sessionId，也可能各自 attach；
// 只用 frameId 做键会在跨进程 OOPIF 场景命中错误的执行上下文。
interface CdpTarget {
  frameId: string;
  sessionId?: string;
}

// contextId 是 Page.createIsolatedWorld 返回的执行上下文编号，只对创建它的
// session+frame 组合有效。页面导航后 contextId 会被回收，继续使用会得到
// Cannot find context with specified id；因此 context 只能由 context() 统一创建并缓存。
interface FrameContext extends CdpTarget {
  contextId: number;
}

// 这三个字段只覆盖本文件实际消费的 CDP Runtime 返回值形状。
// [权衡] 不引入 CDP 官方类型是为了避免 typescript 版本耦合；
// 代价是 response.result 可能为空，evaluate() 的调用方必须容忍空对象。
interface RuntimeResult {
  objectId?: string;
  subtype?: string;
  value?: unknown;
}

// exceptionDetails 的三种形态对应三类失败来源：页面异常对象、抛出的原始值、
// 协议层描述文本。runtimeError 依赖这个结构做优先级取值。
interface RuntimeResponse {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
  result?: RuntimeResult;
}

// LocatorTarget 是一次 execute 内 selector 解析的不可变快照：
// boundaries 必须记录外层到内层每个 iframe 的几何，frame 是最终执行帧，
// selector 只剩最后一段（frame 前缀已被 frameSegments 消费）。
// [并发] 该对象只在本轮 execute 内有效；导航后必须整体重建，不能局部修补。
interface LocatorTarget {
  boundaries: FrameBoundary[];
  frame: CdpTarget;
  selector: string;
}

// contentQuad 是 DOM.getContentQuads 返回的 8 元组（四个角的 x/y），
// 描述 iframe 内容区在父帧坐标系中的位置，而不是 iframe 元素的 border box；
// 用 border box 换算会把点击投到滚动条或边框上。
// ownerBackendNodeId 用于遮挡探测时确认命中的就是 iframe 自身。
interface FrameBoundary {
  childSize: { height: number; width: number };
  contentQuad: [number, number, number, number, number, number, number, number];
  ownerBackendNodeId: number;
  parent: CdpTarget;
}

// boundaryPoints 缓存每个 boundary 对应的那一段坐标，便于 frameObstruction
// 逐层用父帧坐标探测遮挡；top 是最终主帧坐标，交给 dispatchClickAt。
// 两者必须来自同一次 pointerFramePoints 计算，混用会产生半帧偏移。
interface PointerFramePoints {
  boundaryPoints: Map<FrameBoundary, { x: number; y: number }>;
  top: { x: number; y: number };
}

// reason 是封闭集合；新增原因时必须同步 lastReason 的文案拼接，
// 否则失败信息会退化成 not-actionable，丢失可诊断性。
// checked 只在元素带 checked 属性时出现；undefined 与 false 语义不同，
// setChecked 依赖这个区分判断「当前是否已处于目标状态」。
interface ActionProbe {
  count: number;
  actionable: boolean;
  checked?: boolean;
  reason?:
    | "disabled"
    | "hidden"
    | "not-editable"
    | "not-stable"
    | "outside-viewport"
    | "covered";
  obstruction?: string;
  x?: number;
  y?: number;
}

// scrollIntoView 的 block/inline 不能任意组合：nearest 在已可见时不动，
// center 会强制居中并改变页面滚动位置。所有组合都必须幂等，
// 否则每次 probe 都修改页面，stable 永远不成立。
interface ScrollAlignment {
  block: "center" | "end" | "nearest" | "start";
  inline: "center" | "end" | "nearest" | "start";
}

// [权衡] 按 pointerAttempt 轮换对齐方式，而不是固定 center：
// 固定 center 在吸顶导航/粘性页脚遮挡时永远探测到 covered，
// 换对齐可以滚出遮挡区；但顺序必须固定，随机会让同一失败在重试间不可复现。
// force=true 时只取第一项，因为 force 的语义是「不再为可操作性调整页面」。
const POINTER_SCROLL_ALIGNMENTS: readonly ScrollAlignment[] = [
  { block: "center", inline: "center" },
  { block: "end", inline: "end" },
  { block: "start", inline: "start" },
  { block: "nearest", inline: "nearest" },
];

// [失败路径] cancelled 与 timeout 必须分开：cancelled 由 abort 触发，
// 不计入重试预算也不应产生超时文案；timeout 是预算耗尽，
// 需要把最后一次 lastReason 带回调用方。合并成一种会让用户取消时显示「超时」。
type ActionProbeExecution =
  | { kind: "done"; value: ActionProbe }
  | { kind: "timeout" }
  | { kind: "cancelled" };

// 对外只暴露 done/timeout/cancelled 三态；失败通过 throw 传播，
// 因为失败必须保留原始 CDP/Playwright 错误文本，供上层转成用户可读信息。
// [权衡] 不把错误塞进 done.value，是为了让调用方必须显式处理 throw。
export type IabLocatorExecution =
  | { kind: "done"; value?: unknown }
  | { kind: "timeout"; reason: string }
  | { kind: "cancelled" };

// [资源] abort 统一用标准 AbortError：上层按 name 判断取消，
// 自定义错误类会让基于字符串的竞态识别与分类逻辑失效。
function abortError(): DOMException {
  return new DOMException("Browser locator action aborted", "AbortError");
}

// CDP 的 exceptionDetails 有三种形态：exception.description（Error 对象）、
// exception.value（抛出的原始值）、text（协议层描述）。按此优先级取，
// 是为了让「页面脚本 throw new Error」与「CDP 自身报错」都保留可读原文。
// 若先取 text，会丢掉页面异常的 message 与 stack。
function runtimeError(response: RuntimeResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null
      ? undefined
      : String(exception.exception.value)) ??
    exception.text ??
    "Playwright locator evaluation failed"
  );
}

// [失败路径] 这里只匹配「文档/帧被替换」这一族错误。导航发生时旧 contextId
// 必然失效，但 selector 仍然有效，所以可以重建 contexts 后重试；
// 把匹配面扩大到所有 Cannot find / detached 会把真正的权限错误也当成可恢复，
// 导致重试到 deadline 才失败。正则带 u 标志并用非捕获组，
// 以兼容不同 Chromium 版本的文案大小写差异。
function isRecoverableLocatorRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /execution context (?:was )?destroyed|cannot find context|frame (?:was )?detached|inspected target navigated/iu.test(
    error.message,
  );
}

// Playwright 链式选择器用 >> 分隔，但 >> 也可能出现在属性值或 text= 引号内。
// 必须逐字符跟踪 quote/escaped 状态，不能直接 split：
// 直接 split 会把 [data-x="a >> b"] 切成两段，frameSegments 随后误判层级。
// [权衡] 手写状态机而不是正则，因为正则无法同时处理转义与三种引号。
function splitSelectorTokens(selector: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      current += character;
      quote = character;
      continue;
    }
    if (selector.slice(index, index + 4) === " >> ") {
      tokens.push(current.trim());
      current = "";
      index += 3;
      continue;
    }
    current += character;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

// 帧边界由 internal:control=enter-frame 伪指令标记；最后一段必须是子选择器，
// 否则点击目标不明确。
// [失败路径] 两处 throw 都是协议误用的确定性错误，不应被当成可恢复竞态重试：
// 它们与页面状态无关，frameSegments 重试一万次结果仍相同。
function frameSegments(selector: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const token of splitSelectorTokens(selector)) {
    if (token === "internal:control=enter-frame") {
      if (current.length === 0)
        throw new Error("frame locator is missing a frame selector");
      segments.push(current.join(" >> "));
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length === 0)
    throw new Error("frame locator is missing a child selector");
  segments.push(current.join(" >> "));
  return segments;
}

// ControlOrMeta 必须在这里按平台展开一次并固定：后续 modifiersBitmask 只认具体键名。
// 若把 ControlOrMeta 透传下去，macOS 上会按 Control 发送，
// 与 Playwright 的 Meta 语义不一致，快捷键会全部失效。
function modifierNames(
  modifiers?: BrowserPlaywrightModifier[],
): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  return (modifiers ?? []).map((modifier) => {
    if (modifier !== "ControlOrMeta") return modifier;
    return process.platform === "darwin" ? "Meta" : "Control";
  });
}

// press(Control+Shift+A) 的修饰键既可能来自 action.modifiers，也可能内嵌在 value 里。
// [权衡] 先拆 value 再与外部 modifiers 合并，顺序是「外部在前、内嵌在后」，
// 这样同一修饰键重复出现时不会产生 double-modifier；改成 Set 去重会丢掉顺序意图。
// 空串必须抛错而不是当成「无按键」：静默成功会让上层以为按键已送达。
function pressParts(value: unknown, modifiers?: BrowserPlaywrightModifier[]) {
  const pieces = String(value ?? "")
    .split("+")
    .filter(Boolean);
  if (pieces.length === 0) throw new Error("locator.press requires a key");
  const key = pieces.pop()!;
  const embedded = pieces.filter((piece): piece is BrowserPlaywrightModifier =>
    ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(piece),
  );
  return { key, modifiers: modifierNames([...(modifiers ?? []), ...embedded]) };
}

// [资源] 一个 session 实例对应一次 execute 调用（由 executeIabPlaywrightLocator 创建），
// 生命周期内持有 isolated world 的 contextId 缓存、attached 子 target 的 sessionId
// 集合与主 frame 缓存。dispose 必须与创建一一配对，
// 否则 Target.attachToTarget 的 session 会泄漏到下一次操作。
class IabPlaywrightLocatorSession {
// [并发] contexts 与 attachedSessionIds 均为实例私有，不跨实例共享。
// 键必须是 sessionId:frameId（见 contextKey），因为同一 frameId 在 OOPIF 场景
// 可能由不同 target session 承载。用 Map 而不是数组是为了 O(1) 命中，
// 避免每帧线性扫描拖慢 probe 循环。
  private readonly contexts = new Map<string, FrameContext>();
  private readonly attachedSessionIds = new Set<string>();
  private rootFrame?: CdpTarget;

  constructor(
    private readonly view: ControlledView,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {}

// [资源] 释放顺序：先 detach 全部已 attach 的 target，再清集合。
// detach 失败不能阻断其它 detach（allSettled），否则一个已崩溃的子 target
// 会让剩余 session 永久泄漏；清理失败也不该覆盖主流程的结果。
  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.view.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
  }

// locator 执行的唯一入口：先解析 selector，再分派只读操作，
// 最后对交互操作进入 actionability 轮询。
// 为什么只读操作不走轮询？count/allTextContents/isVisible 的语义是「此刻的值」，
// 引入重试会把 UI 的探测变成意外等待。
// [失败路径] 只读操作仍会检查 resolvedElement，缺失时抛 No element matched selector，
// 不能返回 null 冒充「0 个命中」。
  async execute(action: LocatorAction): Promise<IabLocatorExecution> {
    let target = await this.resolveTarget(action.selector);
    if (action.operation === "count") {
      return {
        kind: "done",
        value: await this.queryValue(target, "elements.length"),
      };
    }
    if (action.operation === "allTextContents") {
      return {
        kind: "done",
        value: await this.queryValue(
          target,
          "elements.map(element => element.textContent ?? '')",
        ),
      };
    }
    if (action.operation === "isVisible") {
      return {
        kind: "done",
        value: await this.queryValue(
          target,
          "Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches)",
        ),
      };
    }
    if (action.operation === "isEnabled") {
      return {
        kind: "done",
        value: await this.queryValue(
          target,
          "Boolean(elements[0] && injected.elementState(elements[0], 'enabled').matches)",
        ),
      };
    }
    if (action.operation === "waitFor")
      return this.waitForState(target, action);
    if (
      ["textContent", "innerText", "getAttribute", "evaluate"].includes(
        action.operation,
      )
    ) {
      const unique = await this.waitForUnique(target, action.selector);
      if (unique.kind !== "done") return unique;
      return {
        kind: "done",
        value: await this.perform(target, action, {
          count: 1,
          actionable: true,
        }),
      };
    }

    const deadline = Date.now() + this.timeoutMs;
    let lastReason = `locator ${action.selector}`;
    let pointerAttempt = 0;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout", reason: lastReason };
// [权衡] 在循环内按 operation 推导能力需求，而不是在 action 上预存布尔标志：
// 预存需要在 shared 协议里同步维护三份派生态，任何新增操作都要改协议；
// 循环内推导的代价只是每帧几次 includes。
      const needsEditable = action.operation === "fill";
// [权衡] 剩余预算在每个 probe 前重算一次，而不是按轮次固定扣减：
// 单次 probe 可能耗时远超轮询间隔（跨进程 frame + rAF 等待），
// 固定扣减会让 deadline 变成乐观估计，实际执行超出调用方超时。
      const needsPointer = ["click", "dblclick", "setChecked"].includes(
        action.operation,
      );
      const needsEnabled = [
        "click",
        "dblclick",
        "fill",
        "press",
        "selectOption",
        "setChecked",
      ].includes(action.operation);
// 这里刻意用 try/catch 包住 probe：可恢复竞态需要在重建 contexts 前
// 确认没有执行过 perform。由于 perform 只发生在循环的 return 分支，
// catch 命中即意味着「尚未产生副作用」，这是重试安全的前提。
      let probeExecution: ActionProbeExecution;
      try {
        probeExecution = await this.actionProbe(
          target,
          {
            // fill 始终检查 visible/enabled/editable，不接受 click 的 force 放宽。
            force: action.operation === "fill" ? false : action.force === true,
            needsEditable,
            needsEnabled,
            // fill/type 不等待 stable，也不做 click 的 hit-target 检查。
            // z.ai 输入框的持续动画会让 stable 永不成立，等待 stable 会卡到 MCP hard timeout。
            // force pointer action 仍等待稳定并滚动，但跳过 hit-target 校验。
            needsHitTarget: needsPointer && action.force !== true,
            needsStable: needsPointer,
            scrollAlignment:
              action.force === true
                ? POINTER_SCROLL_ALIGNMENTS[0]!
                : (POINTER_SCROLL_ALIGNMENTS[
                    pointerAttempt % POINTER_SCROLL_ALIGNMENTS.length
                  ] ?? POINTER_SCROLL_ALIGNMENTS[0]!),
          },
          remaining,
        );
      } catch (error) {
// [失败路径] 非竞态错误直接上抛，不做任何降级：例如 isolated world 创建被拒绝、
// 选择器语法非法，重试只会放大日志与耗时。
// 竞态分支里 pointerAttempt 也必须自增，是为了重建后继续轮换对齐方式，
// 否则同一遮挡会以同一对齐方式反复失败。
        if (!isRecoverableLocatorRace(error)) throw error;
        logger.debug("[browser-use] recovering locator after document race", {
          error: error instanceof Error ? error.message : String(error),
          operation: action.operation,
          selector: action.selector,
        });
        await this.resetDocumentContexts();
        target = await this.resolveTarget(action.selector);
        pointerAttempt += 1;
        continue;
      }
      if (probeExecution.kind === "cancelled") return { kind: "cancelled" };
      if (probeExecution.kind === "timeout")
        return { kind: "timeout", reason: lastReason };
      const probe = probeExecution.value;
// 只有「唯一命中 + 可操作」才允许进入 perform；count 大于 1 已在注入脚本内
// 被 strict 降级或抛错处理，host 侧不重复判断。
// 先算 pointer 坐标再做遮挡探测：遮挡探测需要父帧坐标，坐标又依赖边界快照，
// 顺序颠倒会用到上一轮的 frame 几何。
      if (probe.count === 1 && probe.actionable) {
        const pointerPoints = needsPointer
          ? this.pointerFramePoints(target, probe)
          : undefined;
        if (needsPointer && action.force !== true) {
// [失败路径] 遮挡探测只是附加信息：探测本身失败时返回 undefined，
// 不允许把辅助探测的异常升级成动作失败；否则 DOM.getNodeForLocation
// 在跨进程 frame 上的偶发失败会让本可成功的点击被误判为 covered。
          const obstruction = await this.frameObstruction(
            target,
            pointerPoints!,
          );
          if (obstruction) {
            lastReason = `${action.operation} actionability (covered by ${obstruction}) for selector ${action.selector}`;
            pointerAttempt += 1;
            continue;
          }
        }
        return {
          kind: "done",
          value: await this.perform(
            target,
            action,
            pointerPoints
              ? { ...probe, x: pointerPoints.top.x, y: pointerPoints.top.y }
              : probe,
          ),
        };
      }
      lastReason =
        probe.count === 0
          ? `locator ${action.selector}`
          : `${action.operation} actionability (${probe.reason ?? "not-actionable"}${probe.obstruction ? ` by ${probe.obstruction}` : ""}) for selector ${action.selector}`;
      pointerAttempt += 1;
// 失败文案区分 count 为 0 与大于 0 两种情况：前者是「还没出现」，
// 后者是「count 大于 0、出现了但不可操作」，两者的调参方向完全不同。
// delayBudget 耗尽时不再 sleep 直接返回 timeout，避免为一次注定超时的轮询多等 50ms。
      const delayBudget = deadline - Date.now();
      if (delayBudget <= 0) return { kind: "timeout", reason: lastReason };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, delayBudget))))
        return { kind: "cancelled" };
    }
  }

// perform 是「已经判定可操作」之后的副作用区，这里不再做任何重试判断。
// [事务] 语义上它对应「提交」：click/fill/press 一旦下发，调用方就不能被要求重放，
// 因此调用点必须在 perform 之前返回，绝不能在 perform 之后 continue 循环。
  private async perform(
    target: LocatorTarget,
    action: LocatorAction,
    probe: ActionProbe,
  ): Promise<unknown> {
    switch (action.operation) {
      case "textContent":
        return this.querySingleValue(target, "elements[0].textContent");
      case "innerText":
        return this.querySingleValue(target, "elements[0].innerText");
      case "getAttribute":
        return this.querySingleValue(
          target,
          `elements[0].getAttribute(${JSON.stringify(action.attribute)})`,
        );
// click 与 dblclick 共用一条 CDP Input 路径，clickCount 由布尔决定。
// 不使用 injected.click 是为了让页面收到 isTrusted=true 的真实输入，
// 否则依赖用户手势的接口（剪贴板、全屏、支付）会被浏览器拒绝。
      case "click":
      case "dblclick": {
        await dispatchClickAt(
          this.view,
          { cx: probe.x!, cy: probe.y! },
          action.button ?? "left",
          action.operation === "dblclick",
          modifiersBitmask(modifierNames(action.modifiers)),
        );
        return null;
      }
// fill 采用三段式：先尝试 injected.fill 一次性写入；返回 needsinput 表示目标
// 需要真实输入（contenteditable/受控组件），此时改用剪贴板粘贴兜底。
// [失败路径] result 不是 done/needsinput 时抛错而不是静默返回 null，
// 否则上层会把「没填进去」当成「填成功」。
      case "fill": {
        const value = String(action.value ?? "");
        const inputTargetToken = createInputTargetToken();
        if (action.replace !== false) {
          const result = await this.querySingleValue(
            target,
            `(() => {
              const result = injected.fill(elements[0], ${JSON.stringify(value)});
              if (result === "needsinput") {
                const input = injected.retarget(elements[0], "follow-label") ?? elements[0];
                Object.defineProperty(input, ${JSON.stringify(IAB_INPUT_TARGET_TOKEN_PROPERTY)}, {
                  configurable: true,
                  value: ${JSON.stringify(inputTargetToken)},
                  writable: true,
                });
              }
              return result;
            })()`,
          );
          if (result === "done") return null;
          if (result !== "needsinput")
            throw new Error(`locator.fill failed: ${String(result)}`);
        } else {
          await this.focusForInput(target, inputTargetToken);
        }
        const context = await this.context(target.frame);
        await pasteTextIntoFocusedTarget(this.view, value, {
          includeRichText: false,
          initialTarget: {
            contextId: context.contextId,
            sessionId: context.sessionId,
          },
          inputTargetToken,
          replaceInputValue: action.replace !== false,
        });
        return null;
      }
// press 必须先 focus 并写入 inputTargetToken，再由 assertFocusedInputTarget 复核：
// 页面可能在 focus 与按键之间用脚本抢焦点（例如自动聚焦搜索框），
// 不复核的话按键会落到错误元素，而且没有任何错误信号。
      case "press": {
        const inputTargetToken = createInputTargetToken();
        await this.focusForInput(target, inputTargetToken, false);
        const context = await this.context(target.frame);
        await assertFocusedInputTarget(this.view, context, inputTargetToken);
        const press = pressParts(action.value, action.modifiers);
        await dispatchKey(
          this.view,
          press.key,
          modifiersBitmask(press.modifiers),
          context.sessionId,
        );
        return null;
      }
// [权衡] 只点击一次再复核状态，不在循环里反复点：checkbox 的 toggle 语义
// 不幂等，重复点击会把用户要的状态点反。复核失败直接抛错，
// 把「点击未生效（可能被禁用/遮挡）」暴露给上层，而不是伪造成功。
      case "setChecked": {
        if (probe.checked !== action.checked) {
          await dispatchClickAt(
            this.view,
            { cx: probe.x!, cy: probe.y! },
            "left",
            false,
          );
        }
        const checked = await this.querySingleValue(
          target,
          "Boolean(elements[0].checked)",
        );
        if (checked !== action.checked) {
          throw new Error(
            `locator.setChecked(${String(action.checked)}) did not change the element state`,
          );
        }
        return null;
      }
// selectOption 直接返回 injected.selectOptions 的结果：数组表示已选中值，
// 字符串 error:* 表示失败。该分支不做 actionability 复核，
// 因为 select 在多数框架里由受控状态驱动，点击展开下拉反而会改变页面状态。
      case "selectOption":
        return this.selectOption(target, action);
// downloadMedia 不是 click 的别名：它要拿到 media/link 的实际 URL，
// 再用临时 anchor 加 download 属性触发下载。
// 直接点元素在 a[href] 上会导航离开当前页，在 video 上则什么都不发生：
// 两种都不会产生下载，却都会返回成功。
      case "downloadMedia": {
        // IAB 的 locator.downloadMedia 不是普通 click：它在 Playwright isolated world 中
        // 提取 media/link URL，再用临时 download anchor 触发浏览器下载。直接点元素会在
        // 普通链接上导航，并把“未下载”伪装成成功。
        await this.querySingleValue(
          target,
          `(() => {
            const element = elements[0];
            element.scrollIntoView({ block: "center", inline: "nearest" });
            const media = element.closest?.("img, video, source, a[href]") ??
              element.querySelector?.("img, video, source, a[href]") ?? element;
            const read = (value, name) => typeof value?.[name] === "string" ? value[name] : null;
            const url = read(media, "currentSrc") ?? read(media, "src") ?? read(media, "href") ?? "";
            if (!url) throw new Error("Matched element does not expose a downloadable URL");
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = url.split("/").pop()?.split("?")[0] || "download";
            anchor.rel = "noopener";
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            return true;
          })()`,
        );
        return null;
      }
// evaluate 需要把元素 handle 交给 Runtime.callFunctionOn，
// 因此不能走 querySingleValue 的 returnByValue 路径，见 evaluateLocator。
      case "evaluate":
        return this.evaluateLocator(target, action);
      default:
        throw new Error(`unsupported locator operation: ${action.operation}`);
    }
  }

// waitFor 的四种状态映射到两个观测值（exists/visible）：hidden 用非 visible 表示，
// 这也是 Playwright 的口径——元素不存在时 visible=false，因此 hidden 同样成立。
// [失败路径] 每轮都重新 queryValue 而不是复用一次 handle：页面可能在等待期间
// 替换 DOM 节点，旧 handle 会变成 detached 的空壳。
  private async waitForState(
    target: LocatorTarget,
    action: LocatorAction,
  ): Promise<IabLocatorExecution> {
// 默认 visible 而不是 attached：Playwright 的 waitFor 默认等待可见，
// 若改成 attached，元素在 but 隐藏时也会立刻返回，UI 会提前渲染出不可交互的内容。
// 状态字符串是封闭集合，未知值落到最后一条 else 分支（等价 hidden），
// 这是为了兼容旧客户端，但新增状态时必须显式补分支，不能依赖这个兜底。
    const state = action.state ?? "visible";
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const value = (await this.queryValue(
        target,
        `({ exists: elements.length > 0, visible: Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches) })`,
      )) as { exists: boolean; visible: boolean };
      const matched =
        state === "attached"
          ? value.exists
          : state === "detached"
            ? !value.exists
            : state === "visible"
              ? value.visible
              : !value.visible;
      if (matched) return { kind: "done" };
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return { kind: "timeout", reason: `${action.selector} to be ${state}` };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, remaining))))
        return { kind: "cancelled" };
    }
  }

// 文本类操作（textContent/innerText/getAttribute/evaluate）要求元素存在，
// 但不需要 actionability。allowMissing=true 让缺失时返回 false 而不是抛错，
// 这是 waitForUnique 能把「尚未出现」与「解析失败」区分开的关键。
  private async waitForUnique(
    target: LocatorTarget,
    selector: string,
  ): Promise<IabLocatorExecution> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const exists = await this.querySingleValue(
        target,
        "Boolean(elements[0])",
        { allowMissing: true },
      );
      if (exists === true) return { kind: "done" };
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return { kind: "timeout", reason: `locator ${selector}` };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, remaining))))
        return { kind: "cancelled" };
    }
  }

// probe 的核心是「一次 evaluate 内完成 selector 解析、状态检查、滚动、稳定与命中测试」，不能拆成多次调用。
// 为什么不拆成多次 CDP 调用？每次调用之间页面都可能变化，
// 分步校验会得到互相矛盾的结论（检查时可见、点击时已被替换）。
// [权衡] 单次长脚本意味着无法在中途取消；取消能力由 raceActionProbe 的
// terminateExecution 提供，代价是页面会收到一次执行中断。
  private async actionProbe(
    target: LocatorTarget,
    options: {
      force: boolean;
      needsEditable: boolean;
      needsEnabled: boolean;
      needsHitTarget: boolean;
      needsStable: boolean;
      scrollAlignment: ScrollAlignment;
    },
    timeoutMs: number,
  ): Promise<ActionProbeExecution> {
// [失败路径] 这个 async IIFE 的异常不会直接冒泡：它先被 raceActionProbe 接管，
// 只有 operation 在超时/取消前 reject 才会把原始错误透传给外层。
// 因此这里不需要额外 try/catch，否则会把超时与真实错误混为一谈。
    const operation = (async (): Promise<ActionProbe> => {
      const context = await this.context(target.frame);
      const expression = `(async () => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      ${STRICT_VISIBLE_SELECTOR_HELPER}
      const parsedSelector = injected.parseSelector(${JSON.stringify(target.selector)});
      const resolveCurrentElement = () =>
        querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      let element = resolveCurrentElement();
      if (!element) return { count: 0, actionable: false };
      const stateNames = [];
      if (!${String(options.force)}) stateNames.push("visible");
      if (${String(options.needsEnabled && !options.force)}) stateNames.push("enabled");
      if (${String(options.needsEditable)}) stateNames.push("editable");
      const checkStates = (candidate) => {
        if (!candidate.isConnected) return "detached";
        for (const stateName of stateNames) {
          const result = injected.elementState(candidate, stateName);
          if (result.received === "error:notconnected") return "detached";
          if (!result.matches) return stateName;
        }
        return null;
      };
      const initialState = checkStates(element);
      if (initialState) {
        const reason = initialState === "visible" ? "hidden" :
          initialState === "enabled" ? "disabled" :
          initialState === "editable" ? "not-editable" : "not-stable";
        return { count: initialState === "detached" ? 0 : 1, actionable: false, reason };
      }
      element.scrollIntoView({
        block: ${JSON.stringify(options.scrollAlignment.block)},
        inline: ${JSON.stringify(options.scrollAlignment.inline)},
        behavior: "instant"
      });
      const waitForAnimationFrame = () => new Promise(resolve => {
        const view = element.ownerDocument?.defaultView;
        if (typeof view?.requestAnimationFrame === "function") view.requestAnimationFrame(() => resolve(undefined));
        else globalThis.setTimeout(() => resolve(undefined), 0);
      });
      let rect = element.getBoundingClientRect();
      if (${String(options.needsStable)}) {
        let stableFrames = 0;
        for (let index = 0; index < 10 && stableFrames < 2; index += 1) {
          await waitForAnimationFrame();
          // Bug 根因：el-table 等页面会在 rAF 间用同 locator、同几何的新 DOM node 替换旧 node。
          // locator 描述当前匹配目标，不绑定首次 node identity；detach 后应重解析再比较几何。
          const currentElement = element.isConnected ? element : resolveCurrentElement();
          if (!currentElement) return { count: 0, actionable: false };
          const next = currentElement.getBoundingClientRect();
          const unchanged = rect.left === next.left && rect.top === next.top &&
            rect.width === next.width && rect.height === next.height;
          stableFrames = unchanged ? stableFrames + 1 : 0;
          rect = next;
          element = currentElement;
        }
        if (stableFrames < 2) return { count: 1, actionable: false, reason: "not-stable" };
      }
      const finalState = checkStates(element);
      if (finalState) {
        const reason = finalState === "visible" ? "hidden" :
          finalState === "enabled" ? "disabled" :
          finalState === "editable" ? "not-editable" : "not-stable";
        return { count: finalState === "detached" ? 0 : 1, actionable: false, reason };
      }
      const checked = "checked" in element ? Boolean(element.checked) : undefined;
      if (!${String(options.needsHitTarget)}) return { count: 1, actionable: true, checked };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 &&
        x <= globalThis.innerWidth && y <= globalThis.innerHeight;
      const hitResult = inViewport ? injected.expectHitTarget({ x, y }, element) : "outside-viewport";
      const receivesEvents = hitResult === "done";
      if (!inViewport) return { count: 1, actionable: false, reason: "outside-viewport", checked };
      if (!receivesEvents) {
        const obstruction = typeof hitResult === "string" ? hitResult :
          hitResult?.hitTargetDescription ?? "another element";
        return { count: 1, actionable: false, reason: "covered", obstruction, checked };
      }
      return { count: 1, actionable: true, x, y, checked };
      })()`;
      const rawValue = (
        await this.evaluate(context, expression, true, timeoutMs)
      ).value;
      const value = this.requireActionProbe(rawValue, target.selector);
      return value;
    })();
// [并发] operation 已经开始执行，即使这里因超时先返回，注入脚本仍可能在页面里跑。
// 所以 raceActionProbe 在超时分支必须调用 terminateExecution，
// 否则下一轮 probe 会与上一轮的残留脚本并发修改滚动位置。
    return this.raceActionProbe(operation, target.frame, timeoutMs);
  }

// [失败路径] 必须严格校验 payload 形状，不能默认用空对象兜底：
// CDP 在某些空 payload 情况下返回 undefined，直接读 count 会抛
// Cannot read properties of undefined，把 backend 故障伪装成零匹配。
// 明确抛 invalid payload 才能让上层区分「页面没有元素」与「探测链路坏了」。
  private requireActionProbe(value: unknown, selector: string): ActionProbe {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isInteger((value as { count?: unknown }).count) ||
      Number((value as { count?: unknown }).count) < 0 ||
      Number((value as { count?: unknown }).count) > 1 ||
      typeof (value as { actionable?: unknown }).actionable !== "boolean"
    ) {
      // 直接读取异步 Runtime.evaluate 返回值的 count 会在 CDP 空 payload 时泄漏
      // “Cannot read properties of undefined”。这里保留 backend 故障语义，禁止伪装成零匹配。
      logger.debug("[browser-use] invalid pointer probe payload", {
        selector,
        valueKeys: value && typeof value === "object" ? Object.keys(value) : [],
        valueType: value === null ? "null" : typeof value,
      });
      throw new Error(
        `Playwright pointer probe returned an invalid payload for selector ${selector}`,
      );
    }
    const probe = value as ActionProbe;
    if (
      (probe.x !== undefined && !Number.isFinite(probe.x)) ||
      (probe.y !== undefined && !Number.isFinite(probe.y))
    ) {
      throw new Error(
        `Playwright pointer probe returned invalid coordinates for selector ${selector}`,
      );
    }
    return probe;
  }

// 坐标变换按 boundaries 的逆序进行：从最内层 iframe 出发，用 contentQuad 的
// 双线性插值把 contentQuad 上的点映到父帧坐标系，逐层上推直到主帧。
// [权衡] 假设 iframe 内容未旋转/未缩变（用 u/v 归一化）；支持任意 matrix
// 需要读取 getTransform，成本远高于收益，而旋转 iframe 上的 locator 点击并不常见。
  private pointerFramePoints(
    target: LocatorTarget,
    probe: ActionProbe,
  ): PointerFramePoints {
// [失败路径] 坐标缺失说明 needsHitTarget 与 pointer 需求不一致（probe 未计算坐标）。
// 这里必须抛错而不是回退到 (0,0)：点击 (0,0) 会命中页面左上角，
// 产生「action.operation 成功但点错了元素」这种最难排查的故障。
    if (probe.x === undefined || probe.y === undefined) {
      throw new Error(
        `Playwright pointer probe returned no click point for selector ${target.selector}`,
      );
    }
// [失败路径] probe 坐标是相对最内层 frame viewport 的 CSS 像素；
// 这里不做 devicePixelRatio 换算，因为 CDP Input.dispatchMouseEvent 同样吃 CSS 像素，
// 提前乘 DPR 会在高分屏上把点击投到错误位置。
    let point = { x: probe.x, y: probe.y };
    const boundaryPoints = new Map<FrameBoundary, { x: number; y: number }>();
    for (const boundary of target.boundaries.toReversed()) {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = boundary.contentQuad;
      const u = point.x / boundary.childSize.width;
      const v = point.y / boundary.childSize.height;
      point = {
        x:
          x0 * (1 - u) * (1 - v) +
          x1 * u * (1 - v) +
          x2 * u * v +
          x3 * (1 - u) * v,
        y:
          y0 * (1 - u) * (1 - v) +
          y1 * u * (1 - v) +
          y2 * u * v +
          y3 * (1 - u) * v,
      };
      boundaryPoints.set(boundary, point);
    }
    return { boundaryPoints, top: point };
  }

// 逐层用 DOM.getNodeForLocation 判断父帧该点下方是不是 iframe 自身：
// backendNodeId 与 ownerBackendNodeId 相等说明命中的就是 iframe 边界，
// 这一层没有外部遮挡，frameObstruction 可以继续向上检查。
// [失败路径] 任何一层探测抛错都吞掉并继续，理由同调用点：辅助信息不改变主判定。
  private async frameObstruction(
    target: LocatorTarget,
    points: PointerFramePoints,
  ): Promise<string | undefined> {
    for (const boundary of target.boundaries.toReversed()) {
      const point = points.boundaryPoints.get(boundary);
      if (!point)
        throw new Error("Playwright pointer frame chain is incomplete");
// [权衡] DOM.getNodeForLocation 只接受整数坐标，这里四舍五入而不是取整：
// Math.floor 在负坐标（iframe 被滚出视口一侧）上会再偏移一个像素，
// 导致遮挡探测命中相邻元素，产生假阳性。
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      try {
        const hit = (await this.send(
          boundary.parent,
          "DOM.getNodeForLocation",
          {
            includeUserAgentShadowDOM: true,
            x,
            y,
          },
        )) as { backendNodeId?: number };
        if (
          !hit.backendNodeId ||
          hit.backendNodeId === boundary.ownerBackendNodeId
        )
          continue;
        const described = (await this.send(
          boundary.parent,
          "DOM.describeNode",
          {
            backendNodeId: hit.backendNodeId,
          },
        )) as {
          node?: {
            attributes?: string[];
            localName?: string;
            nodeName?: string;
          };
        };
        const node = described.node;
        const name =
          node?.localName || node?.nodeName?.toLowerCase() || "another element";
        return `<${name}>`;
      } catch {
        // frame boundary 的辅助遮挡探测失败不覆盖主 selector/actionability 结果。
      }
    }
    return undefined;
  }

// [并发] 这个 Promise 是 operation 完成与 timer/abort 触发之间的竞速：
// settled 标志保证 finish 幂等，因为三者可能同时到达。
// [资源] 每条退出路径都必须 clearTimeout 并移除 abort 监听，
// 否则长会话里 signal 会累积上百个 listener，触发 MaxListenersExceededWarning。
  private raceActionProbe(
    operation: Promise<ActionProbe>,
    target: CdpTarget,
    timeoutMs: number,
  ): Promise<ActionProbeExecution> {
    if (this.signal?.aborted) return Promise.resolve({ kind: "cancelled" });
    return new Promise<ActionProbeExecution>((resolve, reject) => {
      let settled = false;
      const finish = (result: ActionProbeExecution) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const terminate = () => {
        void this.view.cdp
          .send("Runtime.terminateExecution", undefined, target.sessionId)
          .catch(() => undefined);
      };
      // Runtime.evaluate.timeout 在 injected checkElementStates 等待 rAF 时不足以保证
      // host 侧截止。用剩余 locator 预算竞速，避免 3s routine timeout 外溢成 30s MCP AbortError。
      const timer = setTimeout(
        () => {
          terminate();
          finish({ kind: "timeout" });
        },
        Math.max(0, timeoutMs),
      );
      const onAbort = () => {
        terminate();
        finish({ kind: "cancelled" });
      };
      this.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.signal?.aborted) onAbort();
      operation.then(
        (value) => finish({ kind: "done", value }),
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

// 导航后所有 execution context 都失效，但 attached 的 target session 仍然存在。
// 顺序必须是先 detach 再清集合，反过来 detach 会找不到 sessionId。
// 清空 rootFrame 是因为跨进程导航后 Page.getFrameTree 的主帧 id 也可能变化。
  private async resetDocumentContexts(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.view.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
    this.contexts.clear();
    this.rootFrame = undefined;
  }

// focus 与 token 写入必须在同一个 evaluate 内完成：分开两次调用时，
// 页面脚本可能在中间抢走焦点，而 token 已写到旧元素上，
// 随后 assertFocusedInputTarget 会以难以解释的失败告终。
// [失败路径] focused 不是 done 时把注入脚本返回的原因原样拼进错误，
// 便于 focusForInput 区分「元素不可聚焦」与「元素已被移除」。
  private async focusForInput(
    target: LocatorTarget,
    inputTargetToken: string,
    retargetInput = true,
  ): Promise<void> {
    const focused = await this.querySingleValue(
      target,
      `(() => {
        const element = ${String(retargetInput)}
          ? injected.retarget(elements[0], "follow-label") ?? elements[0]
          : elements[0];
        const result = element.matches(":focus") ? "done" : injected.focusNode(element, false);
        if (result !== "done") return result;
        Object.defineProperty(element, ${JSON.stringify(IAB_INPUT_TARGET_TOKEN_PROPERTY)}, {
          configurable: true,
          value: ${JSON.stringify(inputTargetToken)},
          writable: true,
        });
        return "done";
      })()`,
    );
    if (focused !== "done")
      throw new Error(`locator could not focus element: ${String(focused)}`);
  }

// selections 必须 JSON.stringify 后嵌入表达式：选项值可能包含引号或换行，
// 裸拼接会破坏注入脚本语法。结果前缀 error: 由 injected 侧提供，
// host 只做前缀判断，避免两侧各自维护一套错误码。
  private async selectOption(
    target: LocatorTarget,
    action: LocatorAction,
  ): Promise<unknown> {
    const selections = JSON.stringify(action.selections ?? []);
    const result = await this.querySingleValue(
      target,
      `injected.selectOptions(elements[0], ${selections})`,
    );
    if (typeof result === "string" && result.startsWith("error:")) {
      throw new Error(`locator.selectOption failed: ${result}`);
    }
    return result;
  }

// 先取元素 handle（returnByValue=false），再 callFunctionOn 调用用户表达式。
// [资源] handle 必须在 finally 中 releaseObject：CDP 的 objectId 是进程级引用，
// 泄漏会阻止 GC，长时间运行的桌面会话内存会持续增长。
// [失败路径] handle.objectId 缺失或 subtype 为 null 都表示选择器未命中，
// 两者必须统一成同一个错误，避免上游按不同文案分支。
  private async evaluateLocator(
    target: LocatorTarget,
    action: LocatorAction,
  ): Promise<unknown> {
    const context = await this.context(target.frame);
    const handle = await this.evaluate(
      context,
      `(() => {
        const injected = globalThis.${PLAYWRIGHT_GLOBAL};
        const root = document;
        ${strictVisibleSelectorSetup(target.selector)}
        if (!resolvedElement) throw new Error("No element matched selector");
        return resolvedElement;
      })()`,
      false,
    );
    if (!handle.objectId || handle.subtype === "null")
      throw new Error("locator resolved to no elements");
// [权衡] evaluate 支持两种调用约定：expressionKind=function 时把 this 与 arg 一起传入，
// 否则把 this 绑定为元素。用字符串拼函数声明而不是 new Function，
// 是为了让 callFunctionOn 在 isolated world 内求值，用户代码无法访问宿主闭包。
// [失败路径] 表达式语法错误会由 callFunctionOn 的 exceptionDetails 返回，
// 由 runtimeError 统一提取，不能在这里做 tryParse。
    const functionDeclaration =
      action.expressionKind === "function"
        ? `function(arg) { return (${action.expression})(this, arg); }`
        : `function(arg) { const element = this; return (${action.expression}); }`;
    try {
      const response = (await this.send(context, "Runtime.callFunctionOn", {
        objectId: handle.objectId,
        functionDeclaration,
        arguments: [{ value: action.arg }],
        awaitPromise: true,
        returnByValue: true,
      })) as RuntimeResponse;
      const error = runtimeError(response);
      if (error) throw new Error(`playwright.evaluate failed: ${error}`);
      return response.result?.value;
    } finally {
      await this.send(context, "Runtime.releaseObject", {
        objectId: handle.objectId,
      }).catch(() => undefined);
    }
  }

// queryValue 允许匹配多个元素（elements 数组），只做只读投影；
// 它不做 strict 检查，因为 count/allTextContents 的语义就是「全部命中」。
// [权衡] 与 querySingleValue 分成两个函数而不是加参数，
// 是为了让「是否需要严格唯一」在调用点一眼可见，减少误用。
  private async queryValue(
    target: LocatorTarget,
    body: string,
  ): Promise<unknown> {
    const context = await this.context(target.frame);
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(target.selector)}), root);
      return ${body};
    })()`;
    return (await this.evaluate(context, expression, true)).value;
  }

// querySingleValue 走 strict 可见性降级（strictVisibleSelectorSetup）：
// 多个候选中恰好一个可见时取那一个，否则抛 strict 冲突。
// allowMissing 只影响缺失时是否抛错，不影响严格模式判定：
// waitForUnique 用它探测「元素是否已出现」，不能让缺失变成异常。
  private async querySingleValue(
    target: LocatorTarget,
    body: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<unknown> {
    const context = await this.context(target.frame);
// [权衡] 用空字符串关闭 guard，而不是把 allowMissing 传进注入脚本：
// 注入脚本越短越不容易受 CDP 表达式长度限制影响，
// 且缺失语义只在 host 侧决定，页面无法干预。
    const missingGuard = options.allowMissing
      ? ""
      : 'if (!resolvedElement) throw new Error("No element matched selector");';
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      ${strictVisibleSelectorSetup(target.selector)}
      ${missingGuard}
      return ${body};
    })()`;
    return (await this.evaluate(context, expression, true)).value;
  }

// 解析 frame 链是 locator 正确性的地基：每层都要拿到三样东西——
// 子 frame 的 frameId（用于后续 attach）、iframe 元素的 backendNodeId
// （用于遮挡探测的身份比对）、内容区 quad 与子帧 viewport（用于坐标变换）。
// [失败路径] 三者任一缺失都立即抛错，不做部分降级：缺 viewport 就无法把
// 内层坐标归一化，半套几何会产生「点到了但点偏」这种最难排查的故障。
  private async resolveTarget(selector: string): Promise<LocatorTarget> {
    const segments = frameSegments(selector);
    let frame = await this.mainFrame();
    const boundaries: FrameBoundary[] = [];
    for (const frameSelector of segments.slice(0, -1)) {
      const context = await this.context(frame);
      const handle = await this.evaluate(
        context,
        `(() => {
          const injected = globalThis.${PLAYWRIGHT_GLOBAL};
          const root = document;
          ${strictVisibleSelectorSetup(frameSelector)}
          if (!resolvedElement) {
            throw new Error(${JSON.stringify(`frame locator resolved to no elements: ${frameSelector}`)});
          }
          return resolvedElement;
        })()`,
        false,
      );
      if (!handle.objectId || handle.subtype === "null")
        throw new Error("frame locator became detached");
      try {
        const described = (await this.send(context, "DOM.describeNode", {
          objectId: handle.objectId,
        })) as { node?: { backendNodeId?: number; frameId?: string } };
        const frameId = described.node?.frameId;
        if (!frameId)
          throw new Error("frame locator did not resolve to a frame owner");
        const ownerBackendNodeId = described.node?.backendNodeId;
        if (!ownerBackendNodeId)
          throw new Error("frame locator returned no backend node identity");
        const contentQuads = (await this.send(frame, "DOM.getContentQuads", {
          backendNodeId: ownerBackendNodeId,
        })) as { quads?: number[][] };
        const contentQuad = contentQuads.quads?.[0];
        if (
          !contentQuad ||
          contentQuad.length !== 8 ||
          !contentQuad.every((coordinate) => Number.isFinite(coordinate))
        ) {
          throw new Error("frame owner returned no valid content quad");
        }
// [失败路径] childFrame 可能新建独立 session，这属于资源分配；
// 它在 resolveTarget 内部完成，并由 session.dispose 统一回收。
// 若在某次重试中反复解析 frame 链，attachedSessionIds 会随重试增长，
// 因此可恢复竞态分支必须先 resetDocumentContexts 再重新 resolveTarget。
        const child = await this.childFrame(frame, frameId);
        const childContext = await this.context(child);
        const childSizeValue = (
          await this.evaluate(
            childContext,
            `({ width: globalThis.innerWidth, height: globalThis.innerHeight })`,
            true,
          )
        ).value as { height?: unknown; width?: unknown } | undefined;
        if (
          !childSizeValue ||
          typeof childSizeValue.width !== "number" ||
          typeof childSizeValue.height !== "number" ||
          !Number.isFinite(childSizeValue.width) ||
          !Number.isFinite(childSizeValue.height) ||
          childSizeValue.width <= 0 ||
          childSizeValue.height <= 0
        ) {
          throw new Error("child frame returned no valid viewport size");
        }
        boundaries.push({
          childSize: {
            height: childSizeValue.height,
            width: childSizeValue.width,
          },
          contentQuad: contentQuad as FrameBoundary["contentQuad"],
          ownerBackendNodeId,
          parent: frame,
        });
        frame = child;
      } finally {
        await this.send(context, "Runtime.releaseObject", {
          objectId: handle.objectId,
        }).catch(() => undefined);
      }
    }
// [失败路径] segments 至少有一段（frameSegments 保证），at(-1) 的非空断言成立；
// 若改成 segments[0] 会丢掉帧前缀已消费的事实，在外层 frame 上重复解析子选择器。
    return { boundaries, frame, selector: segments.at(-1)! };
  }

// 主 frame 只解析一次并缓存：Page.getFrameTree 是异步 CDP 往返，
// 每次 probe 都调用会在 3s 预算内挤掉真正用于 actionability 的轮询。
// [资源] Page/Runtime/DOM 三个 domain 的 enable 只在这里做一次；
// 重复 enable 不会报错但会重置部分 CDP 状态。
  private async mainFrame(): Promise<CdpTarget> {
    if (this.rootFrame) return this.rootFrame;
    await this.view.cdp.send("Page.enable");
    await this.view.cdp.send("Runtime.enable");
    await this.view.cdp.send("DOM.enable");
    const tree = (await this.view.cdp.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    const frameId = tree.frameTree?.frame?.id;
    if (!frameId)
      throw new Error("Page.getFrameTree returned no main frame id");
    this.rootFrame = { frameId };
    return this.rootFrame;
  }

// [权衡] 先假设子 frame 与父 frame 共用 session（flatten 下的同进程 iframe），
// 直接 context(sameTarget) 探测；失败才 attachToTarget 建独立 session。
// 顺序反过来会在同进程 iframe 上多建一个 session，同一 frame 出现两个执行上下文，
// injected 全局会被初始化两次。
  private async childFrame(
    parent: CdpTarget,
    frameId: string,
  ): Promise<CdpTarget> {
    const sameTarget = {
      frameId,
      sessionId: parent.sessionId,
    };
    try {
// [失败路径] 这里用 context() 的成功与否作为「同 session 可用」的探针：
// createIsolatedWorld 在跨进程 frame 上会以特定错误失败，
// 但其它错误（例如 target 已关闭）也会走到 attach 分支，最终由 attach 的错误暴露。
      await this.context(sameTarget);
      return sameTarget;
    } catch {
      const attached = (await this.view.cdp
        .send("Target.attachToTarget", { flatten: true, targetId: frameId })
        .catch(() => undefined)) as { sessionId?: string } | undefined;
      if (!attached?.sessionId)
        throw new Error(`unable to attach frame target ${frameId}`);
      this.attachedSessionIds.add(attached.sessionId);
      const target = { ...sameTarget, sessionId: attached.sessionId };
      await this.send(target, "Page.enable");
      await this.send(target, "Runtime.enable");
      await this.send(target, "DOM.enable");
      await this.context(target);
      return target;
    }
  }

// sessionId 缺省用 root 占位，保证主 frame 的键稳定。不要把 undefined
// 直接拼进模板字符串（会得到 undefined:frameId），那样主 frame 与某个
// 恰好缺 sessionId 的子会话会撞键。
  private contextKey(target: CdpTarget): string {
    return `${target.sessionId ?? "root"}:${target.frameId}`;
  }

// [资源] isolated world 的创建是惰性且幂等的：命中缓存直接返回。
// 未命中时 createIsolatedWorld、inject、写缓存，顺序不能反：
// 先写缓存再注入会让重入的调用方拿到未初始化的 context，
// querySelectorAll 会因 injected 未定义而抛错。context() 是唯一创建入口，禁止绕过。
  private async context(target: CdpTarget): Promise<FrameContext> {
    if (this.signal?.aborted) throw abortError();
    const key = this.contextKey(target);
    const existing = this.contexts.get(key);
    if (existing) return existing;
// [权衡] grantUniveralAccess 显式设为 false（拼写沿用 CDP 原始字段）：
// 打开通用访问会让 isolated world 能读取跨源 iframe 的 DOM，
// 等于绕过同源策略，locator 只需要操作当前帧，没有任何理由放开。
    const world = (await this.send(target, "Page.createIsolatedWorld", {
      frameId: target.frameId,
      grantUniveralAccess: false,
      worldName: PLAYWRIGHT_WORLD_NAME,
    })) as { executionContextId?: number };
    if (!world.executionContextId)
      throw new Error(`unable to create locator world for ${target.frameId}`);
    const context = { ...target, contextId: world.executionContextId };
    await this.inject(context);
    this.contexts.set(key, context);
    return context;
  }

// inject 先探测 globalThis 上的 PLAYWRIGHT_GLOBAL 是否已存在：
// 同一 isolated world 在 createIsolatedWorld 被重复调用时可能被复用，
// 无条件重新注入会丢掉已缓存的 InjectedScript 状态。
// [失败路径] 注入返回值不是 true 时抛错而不是继续执行：后续所有 querySelectorAll
// 都会失败，在源头报错才能保留真实原因（脚本过大或 CDP 限制）。
  private async inject(context: FrameContext): Promise<void> {
    const present = await this.evaluate(
      context,
      `Boolean(globalThis.${PLAYWRIGHT_GLOBAL})`,
      true,
    );
// 探测结果必须是严格的 true：CDP 在上下文被销毁时可能返回 undefined，
// 用 truthy 判断会把「读不到」误当成「已注入」，随后所有选择器查询都失败。
    if (present.value === true) return;
// [权衡] 这里固定 browserName=chromium：运行时只有 CDP 一条路径，
// 若允许按页面 UA 推断，会在伪装 UA 的站点上启用不存在的引擎特性。
// testIdAttributeName 必须与 domSnapshot 侧一致，否则同一 data-testid 选择器两处解析不同。
    const options = {
      browserName: "chromium",
      customEngines: [],
      isUnderTest: false,
      sdkLanguage: "javascript",
      stableRafCount: 1,
      testIdAttributeName: "data-testid",
    };
// [资源] source 是 Playwright 注入脚本的完整源码，体积可达数百 KB。
// 它只在首次注入时读取，不能放进每次 evaluate 的表达式里，
// 否则每个 probe 都会把整份源码跨进程传输一遍。
    const source = getPlaywrightInjectedScriptSource();
    const expression = `(() => {
      const module = {};
      ${source}
      globalThis.${PLAYWRIGHT_GLOBAL} = new (module.exports.InjectedScript())(
        globalThis,
        ${JSON.stringify(options)}
      );
      return true;
    })()`;
    const injected = await this.evaluate(context, expression, true);
    if (injected.value !== true)
      throw new Error("unable to initialize Playwright locator runtime");
  }

// [并发] 每次 evaluate 都注册 abort 监听并在 finally 移除：once 只能保证只触发一次，
// 正常完成路径不会触发 abort，监听会一直挂着。
// timeoutMs 会原样传给 Runtime.evaluate 的 timeout 参数，但它只能约束单次求值，
// 注入脚本里的 rAF 循环仍需要外层 race 兜底。
  private async evaluate(
    context: FrameContext,
    expression: string,
    returnByValue: boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<RuntimeResult> {
    if (this.signal?.aborted) throw abortError();
    const terminate = () => {
      void this.view.cdp
        .send("Runtime.terminateExecution", undefined, context.sessionId)
        .catch(() => undefined);
    };
    this.signal?.addEventListener("abort", terminate, { once: true });
    try {
// [权衡] awaitPromise=true 是必须的：注入脚本普遍返回 Promise，
// 若为 false，CDP 会立刻返回一个 Promise 的远程对象而不是它的值，
// queryValue 等调用方拿到的将是 objectId 而不是期望的标量。
// [失败路径] returnByValue=false 时 response.result 只有 objectId，
// 调用方必须显式 releaseObject，这条路径只允许 evaluateLocator 使用。
      const response = (await this.send(context, "Runtime.evaluate", {
        awaitPromise: true,
        contextId: context.contextId,
        expression,
        returnByValue,
        timeout: timeoutMs,
      })) as RuntimeResponse;
      const error = runtimeError(response);
      if (error) throw new Error(error);
      return response.result ?? {};
    } finally {
      this.signal?.removeEventListener("abort", terminate);
    }
  }

// [失败路径] send 是唯一收口点：abort 后统一返回 rejected 的 AbortError，
// 而不是继续调用 view.cdp.send。abort 表示用户已经不想等了，
// 继续发请求只会让 CDP 队列堆积无人消费的响应。
  private send(
    target: { sessionId?: string },
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    if (this.signal?.aborted) return Promise.reject(abortError());
    return this.view.cdp.send(method, params, target.sessionId);
  }

// [并发] delay 返回 boolean 而不是 Promise 空值：false 表示等待被 abort 中断，
// 调用方据此返回 cancelled。若返回空值，调用方只能再查一次 signal.aborted，
// 而 abort 与计时器同时触发的窗口里两次判断可能不一致。
// [资源] finish 幂等且必须 clearTimeout，防止计时器在 abort 后仍触发一次 resolve。
  private delay(timeoutMs: number): Promise<boolean> {
    if (this.signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      const onAbort = () => finish(false);
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * 使用与 domSnapshot 相同固定版本的 Playwright injected selector runtime；动作由 CDP Input
 * 下发，避免页面主 world 手写 selector 与 synthetic event 造成“快照可见但无法操作”。
 */
// 工厂加 finally 结构保证 session.dispose() 一定执行：无论 execute 抛错、被取消
// 还是正常返回，attached 的 target session 都会被 detach。
// [资源] 不把 session 暴露给调用方，是为了让「创建/释放」无法被拆开使用。
export async function executeIabPlaywrightLocator(
  view: ControlledView,
  action: LocatorAction,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IabLocatorExecution> {
  const session = new IabPlaywrightLocatorSession(view, timeoutMs, signal);
  try {
    return await session.execute(action);
  } finally {
    await session.dispose();
  }
}
