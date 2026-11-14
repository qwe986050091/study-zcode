// 职责：必须在桌面端主进程内驱动 CDP，抓取受控页面的 Playwright aria 快照，展开 iframe 子树，
// 并把结果归一化成稳定可读的文本。不能负责渲染/上报快照，不能负责创建、销毁受控视图。
// 调用方持有 view 生命周期与取消信号；本文件只做「读」与「清理自己创建的 CDP 资源」。
//
// INV-01 断言：会话结束时必须解绑自己 attach 的 session —— 守住它的位置：capture 的 finally 与 detachOwnedSessions —— 改错故障：重复抓取后 target 残留，渲染进程句柄泄漏、页面越用越卡
// INV-02 断言：每次发 CDP 命令前都要复查 abort —— 守住它的位置：send 首行 throwIfAborted —— 改错故障：用户切页/关页后仍继续发命令，抛 Target closed 噪声掩盖真实取消
// INV-03 断言：isolated world 名与注入全局名成对且唯一 —— 守住它的位置：PLAYWRIGHT_WORLD_NAME / PLAYWRIGHT_GLOBAL —— 改错故障：与页面脚本或其它注入撞名，注入实例被覆盖后快照全空
// INV-04 断言：注入脚本只在全局缺失时写入 —— 守住它的位置：ensureInjected 中 present.value === true 的早退 —— 改错故障：每帧重复执行大段注入代码，抓取从数十毫秒升到数秒
// INV-05 断言：按缩进宽度还原父子关系，哨兵根缩进为 -1 —— 守住它的位置：parseSnapshotTree 的 root 与弹栈循环 —— 改错故障：首行被当子节点或整棵树压平，层级错乱让模型误读页面结构
// INV-06 断言：压平匿名容器时必须保留 children —— 守住它的位置：normalizeSnapshotNode 的 generic/listitem/group 分支 —— 改错故障：容器内的真实可交互节点整片消失，点击与输入定位不到元素
// INV-07 断言：无名称图片必须整枝丢弃 —— 守住它的位置：normalizeSnapshotNode 的 img 正则分支 —— 改错故障：快照塞满空的 img 行，token 暴涨且不提供任何定位依据
// INV-08 断言：确认输入确实是 aria 树才重排 —— 守住它的位置：normalizeBrowserDomSnapshot 的三段前缀判断 —— 改错故障：普通文本被误当树结构重新缩进，输出被静默改写
// INV-09 断言：子 iframe 快照只能按 aria-ref 对齐回父行 —— 守住它的位置：iframeRefFromLine 与 mergeIframeSnapshots —— 改错故障：子内容挂到错误 iframe 行或缩进丢失，内嵌页面信息归错位置
// INV-10 断言：子帧总预算 1s、单帧 500ms，剩余预算不得小于 1ms —— 守住它的位置：IAB_IFRAME_TOTAL_BUDGET_MS / IAB_IFRAME_CHILD_BUDGET_MS 与 remainingBudget —— 改错故障：卡住的跨域 iframe 拖住整次抓取直到调用方超时
// INV-11 断言：只展开可见且未被 aria-hidden 的 iframe 引用 —— 守住它的位置：readFrameSnapshot 内的 iframeRefs.filter —— 改错故障：离屏广告或隐藏 iframe 被展开，体积与耗时成倍增长
// INV-12 断言：同帧优先复用父 target 的会话，失败才 attach 独立 target —— 守住它的位置：childTarget —— 改错故障：同进程 iframe 被误判成 OOPIF，多余 session 让抓取变慢且导航时更易失败
// INV-13 断言：OOPIF 解析失败要刷新 target 列表后重解一次 ref —— 守住它的位置：readChildSnapshot 的 Target.getTargets 重试分支 —— 改错故障：主快照偶发只剩 iframe 空壳，内嵌表单内容全部缺失
// INV-14 断言：Runtime.evaluate 拿到的 objectId 必须显式释放 —— 守住它的位置：frameIdForRef 的 finally Runtime.releaseObject —— 改错故障：每次抓取泄漏一个远端对象，长时间运行后进程内存持续上涨
// INV-15 断言：注入运行时返回结构非法时必须抛错 —— 守住它的位置：readFrameSnapshot 的类型校验 —— 改错故障：调用方拿到空快照却以为页面空白，排查方向完全跑偏
// INV-16 断言：createIsolatedWorld 的参数键名保持 grantUniveralAccess 原拼写 —— 守住它的位置：ensureContext 的 world 参数对象 —— 改错故障：按拼写习惯「修正」成 grantUniversalAccess 后 CDP 报未知参数，整条链路不可用
import type { ControlledView, ControlledViewCdp } from "./browserCommandTypes.js";
import { getPlaywrightInjectedScriptSource } from "./playwrightInjectedScriptSource.js";

// [契约] world 名与注入全局名是页面内的唯一身份，只能整体一致地改，不能只改一处。
// 页面里可能同时存在其它 Playwright 注入；改名等于放弃现有隔离边界，必须同步改探测键，
// 否则旧全局会被 ensureInjected 误判为「已注入」，实际拿不到新实例。
const PLAYWRIGHT_WORLD_NAME = "zcode-playwright-dom-snapshot";
const PLAYWRIGHT_GLOBAL = "__zcodePlaywrightInjected";
// Playwright 操作预算：顶层 snapshot 3s；IAB iframe 额外总预算 1s。
// [权衡] 3s 是顶层一次 evaluate 的整体预算，不是每个节点各自计时。
// 调小会让慢站点在首屏渲染期直接返回空快照；调大会让已 abort 的抓取迟迟不退出。
// iframe 预算另算且更小，防止内嵌页面把整次抓取拖到调用方超时。
const TOP_LEVEL_TIMEOUT_MS = 3_000;
const IAB_IFRAME_TOTAL_BUDGET_MS = 1_000;
const IAB_IFRAME_CHILD_BUDGET_MS = 500;

interface CdpTarget {
  sessionId?: string;
}

interface RuntimeResult {
  objectId?: string;
  subtype?: string;
  value?: unknown;
}

interface RuntimeEvaluateResponse {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
  result?: RuntimeResult;
}

interface PlaywrightAriaSnapshot {
  full: string;
  iframeDepths: Record<string, number>;
  iframeRefs: string[];
}

interface SnapshotFrameContext extends CdpTarget {
  contextId: number;
  frameId: string;
}

interface SnapshotTreeNode {
  children: SnapshotTreeNode[];
  indent: number;
  line: string;
}

function abortError(): DOMException {
  return new DOMException("Browser DOM snapshot aborted", "AbortError");
}

// [失败路径] 取消只抛 AbortError，不吞异常、不返回空串。
// 上层按错误名区分「用户取消」与「页面出错」，改成普通 Error 会弹出误导性错误提示。
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

// [契约] 结果被夹在 1..maximum 之间，永不返回 0 或负数。
// CDP 的 timeout 收到 0 会被视为无限等待，恰好会在预算耗尽时反向放大卡死风险。
// 因此这里宁可给 1ms 让命令快速失败，也不把真实剩余值透传出去。
function remainingBudget(deadline: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, deadline - Date.now()));
}

// [契约] 文案取值顺序是 description → value → text，不要调换。
// description 带堆栈，是排查注入脚本最有效的线索；优先 text 只剩一句泛化描述。
// [失败路径] 返回 undefined 表示无异常，调用方据此决定是否抛错。
function runtimeExceptionMessage(response: RuntimeEvaluateResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null ? undefined : String(exception.exception.value)) ??
    exception.text ??
    "Playwright DOM snapshot evaluation failed"
  );
}

// [契约] 必须用缩进宽度还原层级：缩进相同的行互为兄弟，更深的行是上一个节点的孩子。
// 哨兵根缩进取 -1，保证缩进为 0 的第一行一定挂在根下而不会被误弹栈。
// 弹栈循环里的 stack.length > 1 是护栏：去掉它，缩进回退时会把哨兵根弹掉，
// 随后向 children 追加节点就作用在 undefined 上，整棵树直接崩。
// [权衡] 必须只按空格计数、不解析 tab；注入脚本固定输出空格，改注入端时要同步这里。
function parseSnapshotTree(snapshot: string): SnapshotTreeNode[] {
  const root: SnapshotTreeNode = { children: [], indent: -1, line: "" };
  const stack = [root];
  for (const rawLine of snapshot.split("\n")) {
    if (rawLine.trim() === "") continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const node: SnapshotTreeNode = {
      children: [],
      indent,
      line: rawLine.slice(indent),
    };
    while (stack.length > 1 && indent <= (stack.at(-1)?.indent ?? -1)) stack.pop();
    stack.at(-1)?.children.push(node);
    stack.push(node);
  }
  return root.children;
}

function cleanSnapshotLine(line: string): string {
  return line.replace(/ \[ref=[^\]]+\]/g, "").replace(/ \[cursor=[^\]]+\]/g, "");
}

// [契约] 返回数组而非单节点：压平后一个输入可能对应 0 个或多个输出。
// children 必须先递归归一化再决定自身去留；顺序颠倒会连已丢弃节点的子树一起丢。
// 正因为 children 已是「归一化后的孩子」，压平分支直接返回它时子树依然完整。
// [失败路径] 正则只匹配「整行就是节点名（可带属性段）」，带可读文本的图片不会被误删。
// 改正则前先对照注入脚本输出格式；aria 文本里出现同名元素会立刻表现为少节点。
function normalizeSnapshotNode(node: SnapshotTreeNode): SnapshotTreeNode[] {
  const children = node.children.flatMap(normalizeSnapshotNode);
  const line = cleanSnapshotLine(node.line);
  // 无名称或内容的图片无法提供可定位依据，因此从交互快照中移除。
  // [契约] 无名称图片整枝丢弃，连它（通常为空的）children 一起移除。
  // 只命中「- img」后接属性段或冒号的形态；带名称的图片必须保留，不要放宽成包含匹配。
  // 放宽的后果是所有 image 节点消失，模型失去图片位置的线索。
  if (/^- img(?: \[[^\]]+\])*:?$/.test(line)) return [];
  // 匿名结构容器本身不提供定位信息；压平时必须保留其 children。
  // [契约] 匿名容器自身没有定位价值，但 children 是真实内容，必须原样上提。
  // 这里返回 children 而不是空数组；写成空数组等于把列表项、分组里的按钮整片删除。
  // 压平后缩进由 renderSnapshotTree 重新计算，父子关系不会错位。
  if (/^- (generic|listitem|group)(?: \[[^\]]+\])*:?$/.test(line)) return children;
  return [{ children, indent: node.indent, line }];
}

function renderSnapshotTree(nodes: SnapshotTreeNode[], depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    lines.push(indent + node.line);
    const children = renderSnapshotTree(node.children, depth + 1);
    if (children) lines.push(children);
  }
  return lines.join("\n");
}

// [契约] 只有确认输入是 aria 树（以「- 」开头或含子项行）才重排，否则原样返回。
// 空串与普通提示文本走原样返回分支，避免被误当树重新缩进。
// 这是对外出口，调用方依赖其输出稳定；不要在这里新增截断或改写文案等副作用。
// 归一化只删 ref/cursor 属性与匿名容器，节点顺序与可见文案必须保持不变。
// 将来若要保留 ref 供后续点击，应新增独立开关，不能直接取消这里的过滤。
/** Playwright DOM snapshot 的公开结果归一化：删除内部 ref/cursor 并压平无语义容器。 */
export function normalizeBrowserDomSnapshot(snapshot: string): string {
  if (!snapshot.startsWith("- ") && !snapshot.includes("\n- ") && !snapshot.includes("\n  - ")) {
    return snapshot;
  }
  return renderSnapshotTree(parseSnapshotTree(snapshot).flatMap(normalizeSnapshotNode));
}

function iframeRefFromLine(line: string): string | undefined {
  if (!line.trimStart().startsWith("- iframe")) return undefined;
  return line.match(/\[ref=([^\]]+)\]/)?.[1];
}

// [契约] 仅当父行是 iframe 且拿到子快照时才改写，其余行逐字保留。
// 父行不以「:」结尾要补一个，否则子内容会被读成同级兄弟，层级语义丢失。
// 子内容统一多缩进两格，与 aria 树的子节点约定一致；少缩进会让子页面节点看起来是父级兄弟。
// [失败路径] children 中值为 undefined 的 ref 视为未展开，保留原始 iframe 行不追加。
function mergeIframeSnapshots(snapshot: string, children: Map<string, string | undefined>): string {
  const output: string[] = [];
  for (const line of snapshot.split("\n")) {
    const ref = iframeRefFromLine(line);
    const child = ref ? children.get(ref) : undefined;
    if (!child) {
      output.push(line);
      continue;
    }
    const indent = line.match(/^ */)?.[0] ?? "";
    output.push(line.endsWith(":") ? line : `${line}:`);
    output.push(...child.split("\n").map((childLine) => `${indent}  ${childLine}`));
  }
  return output.join("\n");
}

// [契约] 实例即一次抓取的生命周期：构造只存引用，全部 CDP 副作用在 capture 内完成。
// frameContexts 按「sessionId:frameId」缓存已注入上下文，跨 iframe 复用以免重复注入。
// attachedSessionIds 只记录本会话自己 attach 的 session，解绑时按此集合清理，绝不动别人的会话。
// [资源] 实例不可并发复用：两个 capture 并行会共享 Map 并互相覆盖上下文。
class PlaywrightDomSnapshotSession {
  private readonly attachedSessionIds = new Set<string>();
  private readonly frameContexts = new Map<string, SnapshotFrameContext>();

  constructor(
    private readonly cdp: ControlledViewCdp,
    private readonly signal?: AbortSignal,
  ) {}

  // [契约] 顺序固定：先 enable Page/Runtime/DOM 三个域，再取 frame tree，再抓主帧。
  // 漏开 DOM.enable 会让 DOM.describeNode 报域未启用，iframe 的 frameId 解析全部失败。
  // 主帧 id 缺失属不可恢复错误，直接抛；回退到顶层 target 只会抓到另一个页面。
  // [事务] try/finally 保证成功、超时、abort 三种出口都会解绑自己 attach 的 session。
  // 返回空串表示页面没有可读根节点（如 about:blank），调用方应视作「无内容」而非失败。
  async capture(): Promise<string> {
    throwIfAborted(this.signal);
    await this.send({}, "Page.enable");
    await this.send({}, "Runtime.enable");
    await this.send({}, "DOM.enable");
    const frameTree = (await this.send({}, "Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    const mainFrameId = frameTree.frameTree?.frame?.id;
    if (!mainFrameId) throw new Error("Page.getFrameTree returned no main frame id");

    try {
      const snapshot = await this.readFrameSnapshot({ frameId: mainFrameId }, TOP_LEVEL_TIMEOUT_MS);
      if (!snapshot) return "";
      const deadline = Date.now() + IAB_IFRAME_TOTAL_BUDGET_MS;
      const expanded = await this.expandIframes(snapshot, { frameId: mainFrameId }, deadline);
      return normalizeBrowserDomSnapshot(expanded);
    } finally {
      // [资源] finally 中的解绑要 await：提前返回会让 session 在后续帧抓取时被错配复用。
      // 解绑失败不能覆盖原始异常，故 detachOwnedSessions 内部用 allSettled。
      // 该步必须在归一化之后执行，输出文本此时已与页面解耦。
      await this.detachOwnedSessions();
    }
  }

  // [契约] 所有 CDP 命令的唯一出口，sessionId 取 target.sessionId，根会话传 undefined。
  // 不要在调用点绕过它直发 cdp.send，那样会漏掉 abort 检查与统一错误路径。
  private async send(target: CdpTarget, method: string, params?: unknown): Promise<unknown> {
    throwIfAborted(this.signal);
    return this.cdp.send(method, params, target.sessionId);
  }

  private contextKey(target: CdpTarget, frameId: string): string {
    return `${target.sessionId ?? "root"}:${frameId}`;
  }

  // [契约] 一个 frame 只建一个 isolated world，按 key 缓存；重复调用返回同一 contextId。
  // 建 world 失败（frame 已销毁）必须抛错，由 childTarget 的 catch 决定降级路径。
  // world 内不授予 universal access：注入脚本需要 DOM，但不能触碰主世界闭包变量。
  // [并发] 缓存无 in-flight 去重，调用方需按 frame 串行推进，否则会重复建 world。
  private async ensureContext(
    target: CdpTarget & { frameId: string },
    timeoutMs: number,
  ): Promise<SnapshotFrameContext> {
    const key = this.contextKey(target, target.frameId);
    const existing = this.frameContexts.get(key);
    // [契约] 命中缓存必须直接返回同一个上下文，不得再次 createIsolatedWorld。
    // 重建 world 会让已注入实例失效，同帧出现两份注入代码并在快照时互相抢全局。
    // 缓存键含 sessionId，因此 OOPIF 与同进程 iframe 的同名 frameId 不会串用。
    if (existing) return existing;
    // [契约] grantUniveralAccess 必须保持 CDP 的原样拼写（少一个 s），不是笔误，禁止「修正」。
    // 改成 grantUniversalAccess 会被判为未知参数并整体拒绝，快照链路立刻不可用。
    // worldName 保持不变以复用同帧上下文；每次调用仍会新建 world，靠 frameContexts 去重。
    // [失败路径] 缺 executionContextId 说明 world 未建成，必须抛错，不能拿 undefined 继续 evaluate。
    const world = (await this.send(target, "Page.createIsolatedWorld", {
      frameId: target.frameId,
      grantUniveralAccess: false,
      worldName: PLAYWRIGHT_WORLD_NAME,
    })) as { executionContextId?: number };
    if (!world.executionContextId) {
      throw new Error(`Unable to create Playwright isolated world for frame ${target.frameId}`);
    }
    const context = { ...target, contextId: world.executionContextId };
    await this.ensureInjected(context, timeoutMs);
    this.frameContexts.set(key, context);
    return context;
  }

  private async ensureInjected(context: SnapshotFrameContext, timeoutMs: number): Promise<void> {
    const present = await this.evaluate(context, `Boolean(globalThis.${PLAYWRIGHT_GLOBAL})`, {
      returnByValue: true,
      timeoutMs,
    });
    if (present.value === true) return;
    const options = {
      browserName: "chromium",
      customEngines: [],
      isUnderTest: false,
      sdkLanguage: "javascript",
      stableRafCount: 1,
      testIdAttributeName: "data-testid",
    };
    // [契约] 注入源码是构建期内联的字符串，不在运行时读 node_modules 文件。
    // 外层 const module = {} 承载 UMD 包装，让 Playwright 的导出能以 CJS 形式取到。
    // options 字段直接影响 aria 快照内容（如 testIdAttributeName），改动会改变输出文本。
    // [失败路径] injected.value !== true 表示注入未完成，必须抛错；静默继续只会得到空快照。
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
    const injected = await this.evaluate(context, expression, { returnByValue: true, timeoutMs });
    if (injected.value !== true)
      throw new Error("Unable to initialize Playwright injected runtime");
  }

  private async evaluate(
    context: SnapshotFrameContext,
    expression: string,
    options: { returnByValue: boolean; timeoutMs: number },
  ): Promise<RuntimeResult> {
    const response = (await this.send(context, "Runtime.evaluate", {
      awaitPromise: true,
      contextId: context.contextId,
      expression,
      returnByValue: options.returnByValue,
      timeout: options.timeoutMs,
    })) as RuntimeEvaluateResponse;
    const exception = runtimeExceptionMessage(response);
    // [失败路径] CDP 把页面内异常放在 exceptionDetails 而非 reject，必须手工转成 Error。
    // 不检查这一项会把空结果当成成功，调用方随后拿到空快照却毫无提示。
    // 这里抛 Error 而非 AbortError，保证取消语义只由 throwIfAborted 产生。
    if (exception) throw new Error(exception);
    return response.result ?? {};
  }

  private async readFrameSnapshot(
    target: CdpTarget & { frameId: string },
    timeoutMs: number,
  ): Promise<PlaywrightAriaSnapshot | undefined> {
    const context = await this.ensureContext(target, timeoutMs);
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document.body || document.documentElement;
      if (!root) return { full: "", iframeDepths: {}, iframeRefs: [] };
      const snapshot = injected.incrementalAriaSnapshot(root, { mode: "ai" });
      const iframeRefs = snapshot.iframeRefs.filter((ref) => {
        if (!(ref in snapshot.iframeDepths)) return false;
        try {
          const [frame] = injected.querySelectorAll(injected.parseSelector("aria-ref=" + ref), root);
          return frame != null &&
            frame.getAttribute("aria-hidden") !== "true" &&
            injected.elementState(frame, "visible").matches === true;
        } catch {
          return false;
        }
      });
      return { ...snapshot, iframeRefs };
    })()`;
    const result = await this.evaluate(context, expression, { returnByValue: true, timeoutMs });
    const value = result.value as Partial<PlaywrightAriaSnapshot> | undefined;
    if (
      !value ||
      typeof value.full !== "string" ||
      !Array.isArray(value.iframeRefs) ||
      !value.iframeDepths ||
      typeof value.iframeDepths !== "object"
    ) {
      throw new Error("Playwright injected runtime returned an invalid DOM snapshot");
    }
    return value as PlaywrightAriaSnapshot;
  }

  private async frameIdForRef(
    target: CdpTarget & { frameId: string },
    ref: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const context = await this.ensureContext(target, timeoutMs);
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document.body || document.documentElement;
      if (!root) return null;
      const [frame] = injected.querySelectorAll(
        injected.parseSelector(${JSON.stringify(`aria-ref=${ref}`)}),
        root
      );
      return frame || null;
    })()`;
    const handle = await this.evaluate(context, expression, { returnByValue: false, timeoutMs });
    if (!handle.objectId || handle.subtype === "null") return undefined;
    try {
      const description = (await this.send(target, "DOM.describeNode", {
        objectId: handle.objectId,
      })) as { node?: { frameId?: string } };
      return description.node?.frameId;
    } finally {
      // [资源] 只要拿到 objectId 就必须在 finally 释放，包括 describeNode 抛错的情形。
      // 释放失败被吞成 undefined：它不能覆盖真正的 frameId 结果，也不能掩盖原始异常。
      // 漏释放会让渲染进程持有远端对象，长会话中每抓一次泄漏一个句柄。
      // [契约] 释放命令发到 target 自身 session，发到根会话会作用于另一个上下文的对象。
      await this.send(target, "Runtime.releaseObject", { objectId: handle.objectId }).catch(
        () => undefined,
      );
    }
  }

  // [契约] 先在已 attach 的 session 中找同帧上下文，命中即复用，避免重复 attach。
  // attachToTarget 用 flatten:true 建立扁平会话，之后命令直接携带 sessionId。
  // 新 session 必须补发 Page/Runtime/DOM enable，否则该 target 上的 evaluate 会失败。
  // [失败路径] attach 或任一 enable 失败都返回 undefined，由上层决定放弃这个 iframe。
  private async attachFrameTarget(frameId: string): Promise<CdpTarget | undefined> {
    const existing = [...this.attachedSessionIds].find((sessionId) =>
      this.frameContexts.has(this.contextKey({ sessionId }, frameId)),
    );
    if (existing) return { sessionId: existing };
    try {
      const attached = (await this.send({}, "Target.attachToTarget", {
        flatten: true,
        targetId: frameId,
      })) as { sessionId?: string };
      if (!attached.sessionId) return undefined;
      this.attachedSessionIds.add(attached.sessionId);
      const target = { sessionId: attached.sessionId };
      await this.send(target, "Page.enable");
      await this.send(target, "Runtime.enable");
      await this.send(target, "DOM.enable");
      return target;
    } catch {
      return undefined;
    }
  }

  // [契约] 先在父 target 的同一会话里试建上下文（同进程 iframe），失败才升级为独立 target。
  // 顺序不能反：先 attach 会让同进程 iframe 多开 session，抓取变慢且导航瞬间更易失败。
  // 两次尝试必须共用同一个 timeoutMs，不在此重新预算，避免单个 iframe 吃掉全部时间。
  // [失败路径] 两条路都失败返回 undefined，调用方须视作「该 iframe 未展开」并保留原行。
  private async childTarget(
    parent: CdpTarget & { frameId: string },
    childFrameId: string,
    timeoutMs: number,
  ): Promise<(CdpTarget & { frameId: string }) | undefined> {
    const sameTarget = { ...parent, frameId: childFrameId };
    try {
      await this.ensureContext(sameTarget, timeoutMs);
      return sameTarget;
    } catch {
      const attached = await this.attachFrameTarget(childFrameId);
      if (!attached) return undefined;
      const oopifTarget = { ...attached, frameId: childFrameId };
      try {
        await this.ensureContext(oopifTarget, timeoutMs);
        return oopifTarget;
      } catch {
        return undefined;
      }
    }
  }

  private async readChildSnapshot(
    parent: CdpTarget & { frameId: string },
    ref: string,
    deadline: number,
  ): Promise<string | undefined> {
    if (Date.now() >= deadline) return undefined;
    const timeoutMs = remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS);
    let frameId = await this.frameIdForRef(parent, ref, timeoutMs).catch(() => undefined);
    if (!frameId || Date.now() >= deadline) return undefined;
    let target = await this.childTarget(parent, frameId, timeoutMs);
    if (!target && Date.now() < deadline) {
      // [并发] OOPIF 导航瞬间 frameId 可能指向已销毁的 target，导致 attach 必然失败。
      // 此处先拉一次 Target.getTargets 促使 Chromium 刷新列表，再用同一个 aria-ref 重新解析。
      // 重试只做一次且受 deadline 约束，不得改成循环重试——那会把预算耗在死 iframe 上。
      // 删掉这段会让主快照偶发只剩 iframe 空壳，真实 Electron 页面可稳定复现。
      // OOPIF 导航时 iframe node 的 frameId 可能短暂指向已经销毁的 target。
      // 先让 Chromium 刷新 target 列表，再从同一个 Playwright aria-ref 重新解析；否则
      // 主快照会偶发只剩 iframe 空壳，真实 Electron/CDP 页面可以稳定复现。
      await this.send(parent, "Target.getTargets").catch(() => undefined);
      frameId = await this.frameIdForRef(
        parent,
        ref,
        remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS),
      ).catch(() => undefined);
      if (frameId) {
        target = await this.childTarget(
          parent,
          frameId,
          remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS),
        );
      }
    }
    if (!target || Date.now() >= deadline) return undefined;
    const child = await this.readFrameSnapshot(
      target,
      remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS),
    ).catch(() => undefined);
    if (!child) return undefined;
    return this.expandIframes(child, target, deadline);
  }

  // [契约] 子帧并行展开但共享同一 deadline；某个子帧超时只影响它自己。
  // refs 为空或预算已尽时直接返回原快照，保证无 iframe 页面零额外开销。
  // [权衡] 子快照失败静默降级为不展开，只保留 iframe 行本身，让模型知道此处有内嵌页面。
  private async expandIframes(
    snapshot: PlaywrightAriaSnapshot,
    target: CdpTarget & { frameId: string },
    deadline: number,
  ): Promise<string> {
    const refs = snapshot.iframeRefs.filter((ref) => ref in snapshot.iframeDepths);
    if (refs.length === 0 || Date.now() >= deadline) return snapshot.full;
    const children = new Map(
      await Promise.all(
        refs.map(
          async (ref) => [ref, await this.readChildSnapshot(target, ref, deadline)] as const,
        ),
      ),
    );
    return mergeIframeSnapshots(snapshot.full, children);
  }

  private async detachOwnedSessions(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
  }
}

export async function captureBrowserDomSnapshot(
  view: ControlledView,
  signal?: AbortSignal,
): Promise<string> {
  return new PlaywrightDomSnapshotSession(view.cdp, signal).capture();
}

