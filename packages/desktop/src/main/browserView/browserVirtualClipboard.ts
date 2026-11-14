// -----------------------------------------------------------------------------
// browserVirtualClipboard.ts —— Browser Use 虚拟剪贴板粘贴通道（Main 进程侧驱动）
// 职责：通过 CDP Runtime.evaluate 把文本投递到当前焦点输入元素，覆盖 shadow DOM、
//       同进程 iframe 与跨进程 iframe（OOPIF）；全程不使用系统剪贴板，避免污染用户剪贴板。
//
// 全局不变量（INV 编号被维护者与评审引用，改动前先读对应条目）：
// INV-01 所有 CDP 调用必须携带 target.sessionId（根页面为 undefined）：守卫在 send()；若固定顶层 session，跨 frame 输入会落到错误的 execution context。
// INV-02 target 的 sessionId/contextId 组合必须唯一标识一个执行上下文：守卫在 targetKey()；键塌缩会让环检测误判，出现死循环或提前终止。
// INV-03 resolveFocusedTarget 必须先查 visited 再前进：守卫在循环入口；去掉后自引用 iframe 会无限 attach，主进程事件循环被占满。
// INV-04 每个 attach 成功的 session 必须登记进 attachedSessionIds：守卫在各 attach 分支；漏登记会在失败时泄漏 CDP session。
// INV-05 失败路径必须 detach 全部已建 session：守卫在 resolveFocusedTarget 的 catch 与 paste 的 finally；否则一次失败永久累积协议连接。
// INV-06 OOPIF 先用 Target.attachToTarget（targetId=frameId），失败才降级：守卫在 attachedSessionId 分支；顺序反转会让常见路径退化到慢速 isolated world。
// INV-07 降级用 Page.createIsolatedWorld 且 grantUniveralAccess=false：守卫在 world 分支；打开通用访问会让页面脚本直接读到注入函数。
// INV-08 OOPIF 的 target 注册可能晚于 DOM frameId 可见：守卫在 waitForOopifTarget()；去掉有界轮询会让跨进程 iframe 粘贴必然失败。
// INV-09 OOPIF 等待上限为 OOPIF_TARGET_REGISTRATION_TIMEOUT_MS（1s）：见常量与 deadline；无限等待会让命令链挂死，表现为粘贴永久无响应。
// INV-10 无法解析的 frame 必须抛错，禁止回落顶层 target：守卫在末尾 throw；回落会把文本打进错误输入框，属于静默数据错投。
// INV-11 Runtime.evaluate 的 returnByValue 必须与用途匹配：取 objectId 时 false，取返回值时 true；混用会拿到空对象或 undefined。
// INV-12 拿到 objectId 后必须 Runtime.releaseObject：守卫在 describeNode 的 finally；泄漏 remote object 会让 renderer 堆持续增长直至 OOM。
// INV-13 CDP 异常只能由 runtimeError() 判定：见其实现；调用点另写判断会漏掉 exceptionDetails，把失败当成功。
// INV-14 没有 exceptionDetails 即视为成功：守卫在 runtimeError 的首个 return；误判会让正常 evaluate 被包装成异常。
// INV-15 剪贴板数据结构固定为 {entries, presentation_style}：见 clipboardItems()；结构漂移会让页面脚本解析成 unknown，粘贴静默无效。
// INV-16 HTML 富文本必须经 escapeHtml()：守卫在 clipboardItems 的 text/html 分支；不转义会让页面标记原样注入目标页。
// INV-17 includeRichText 与 richTextFallback 必须同源：见 pasteTextIntoFocusedTarget 的 args；不一致会让页面脚本走错降级分支。
// INV-18 docs.google.com/spreadsheets 不下发 HTML：守卫在 shouldIncludeRichText()；下发会让单元格写入转义字面量而非纯文本。
// INV-19 焦点 token 校验是粘贴前置条件：见 assertFocusedInputTarget()；跳过后焦点漂移会把内容打进上一个输入框。
// INV-20 页面函数返回 ok:false 必须抛 Error：守卫在 pasteTextIntoFocusedTarget 的 value.ok 分支；吞掉会让上层继续执行错误后续步骤。
//
// 标记约定：[并发] 竞态与共享状态、[事务] 原子性与回滚、[资源] session/对象释放、[失败路径] 降级与报错、[权衡] 设计取舍。
import { randomUUID } from "node:crypto";
import type { ControlledView } from "./browserCommandTypes.js";
import {
  IAB_INPUT_TARGET_TOKEN_PROPERTY,
  VIRTUAL_PASTE_PAGE_FUNCTION,
} from "./browserVirtualClipboardPageScript.js";

// [权衡] 这里只再导出 token 属性名，页面脚本常量仍留在 PageScript 模块，避免主进程重复内联脚本源码。
// 该 token 名是主进程与页面脚本的隐式契约，改名必须两侧同步，否则焦点校验恒为 false。
export { IAB_INPUT_TARGET_TOKEN_PROPERTY } from "./browserVirtualClipboardPageScript.js";

// [并发] 该结构是 CDP 目标坐标，同一 view 上多个 target 可并发使用，但调用方必须保证 sessionId 与 contextId 成对出现。
// sessionId 为空表示根 target；contextId 仅在 isolated world 场景被填充，两者语义不可互换。
// 破坏后 send() 会把命令发到错误会话，异常只会在远端 renderer 显现。
export interface BrowserInputExecutionTarget {
  contextId?: number;
  sessionId?: string;
}

// [失败路径] RuntimeResult.value 只在 returnByValue=true 时有意义，objectId 只在 returnByValue=false 时存在，二者必须互斥。
// RuntimeResponse.exceptionDetails 存在即代表求值失败，即使 result 同时带值也不能采信。
// 这里用宽松的可选字段描述 CDP 响应，避免为多版本协议维护强类型映射。
interface RuntimeResult {
  objectId?: string;
  value?: unknown;
}

interface RuntimeResponse {
  exceptionDetails?: {
    exception?: { description?: string; value?: unknown };
    text?: string;
  };
  result?: RuntimeResult;
}

// [资源] attachedSessionIds 是本次解析独占的 session 清单，调用方负责在 finally 中释放。
// target 是最终可执行 evaluate 的目标，可能与入参不同（已下沉到更深 frame）。
interface FocusedTargetResolution {
  attachedSessionIds: string[];
  target: BrowserInputExecutionTarget;
}

// [权衡] 1s 是注册延迟与卡顿容忍度的折中：太长会让 OOPIF 导航卡住命令，太短会误杀慢注册的 iframe。
// 轮询间隔必须限制在 25ms 以内，见 waitForOopifTarget 的 setTimeout，避免忙等打满 CPU。
// 该值仅约束 OOPIF 目标可见性，不约束单次 evaluate 的执行时长。
const OOPIF_TARGET_REGISTRATION_TIMEOUT_MS = 1_000;

// [并发] 这段表达式在目标页面上下文执行，只能读 activeElement 链，不得写入或触发事件。
// 递归穿透 shadowRoot 后返回最内层 iframe 元素，供主进程用 DOM.describeNode 换取 frameId。
// 跨源 iframe 访问 contentDocument 会抛错，catch 后返回当前 iframe 自身，交给 attach 路径处理。
// [失败路径] 无焦点或焦点不在 frame 上时返回 null，调用方据此判定解析结束。
// 表达式必须保持自执行函数形态，直接以语句形式注入会在严格模式下改变 this 绑定。
const FOCUSED_FRAME_EXPRESSION = `(() => {
  const focusedFrameElementInRoot = (root) => {
    const active = root.activeElement;
    if (active == null) return null;
    const activeWindow = active.ownerDocument.defaultView ?? window;
    if (active instanceof activeWindow.HTMLElement && active.shadowRoot != null)
      return focusedFrameElementInRoot(active.shadowRoot);
    if (
      active instanceof activeWindow.HTMLIFrameElement ||
      active instanceof activeWindow.HTMLFrameElement
    ) {
      try {
        const frameDocument =
          active.contentDocument ?? active.contentWindow?.document ?? null;
        if (frameDocument != null)
          return focusedFrameElementInRoot(frameDocument);
      } catch {}
      return active;
    }
    return null;
  };
  return focusedFrameElementInRoot(document);
})()`;

// [失败路径] 优先级：exception.description > exception.value 字符串化 > exception.text > 兜底文案。
// 兜底文案用于 CDP 只回空对象时仍给出可读错误，避免上层拿到 undefined。
// [权衡] runtimeError 不区分协议层错误与页面异常，必须统一折叠成字符串，牺牲分类换取调用点简单。
// 该函数是幂等的，可安全在重试前重复调用。
function runtimeError(response: RuntimeResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null
      ? undefined
      : String(exception.exception.value)) ??
    exception.text ??
    "Browser Use virtual clipboard evaluation failed"
  );
}

// [并发] 键用于环检测，必须把 undefined 归一为 root/default，否则同一目标会被当成两站。
// [失败路径] 键冲突会让 visited 提前命中并抛 cycle 错误，表现为正常嵌套 iframe 无法粘贴。
function targetKey(target: BrowserInputExecutionTarget): string {
  return `${target.sessionId ?? "root"}:${target.contextId ?? "default"}`;
}

// [事务] 单次 CDP 请求的原子边界，所有调用点必须经过这里以保证 sessionId 透传一致。
// 不做重试与超时包装，失败语义交由调用方决定，避免重复注入页面函数。
async function send(
  view: ControlledView,
  target: BrowserInputExecutionTarget,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return view.cdp.send(method, params, target.sessionId);
}

// [资源] 用 allSettled 而非 all：单个 detach 失败不能阻断其余 session 释放。
// 失败被有意吞掉，因为 detach 失败通常意味着 session 已随导航销毁。
// [失败路径] 若这里抛错，会掩盖原始异常，因此只做尽力清理。
async function detachAttachedSessions(
  view: ControlledView,
  sessionIds: readonly string[],
): Promise<void> {
  await Promise.allSettled(
    sessionIds.map((sessionId) =>
      view.cdp.send("Target.detachFromTarget", { sessionId }),
    ),
  );
}

// [失败路径] attach 失败一律返回 undefined，由调用方决定降级到 isolated world。
// [失败路径] 吞掉协议错误是刻意的：非 OOPIF frame 本来就不在 Target 注册表里。
// [权衡] tryAttachFrameTarget 不缓存 attach 结果，每次解析必须重新探测，换取导航后状态正确。
async function tryAttachFrameTarget(
  view: ControlledView,
  frameId: string,
): Promise<string | undefined> {
  const attached = (await view.cdp
    .send("Target.attachToTarget", { flatten: true, targetId: frameId })
    .catch(() => undefined)) as { sessionId?: string } | undefined;
  return attached?.sessionId;
}

// [并发] 轮询串行执行 getTargets，同一 view 上多个解析会各自独立等待，互不共享状态。
// 每次只认 targetId 与 frameId 相等且 type=iframe 的目标，避免误 attach 到同名 worker。
// 每次发现目标后立即尝试 attach，attach 失败继续轮询直到 deadline。
// [资源] setTimeout 的上限取剩余时间，保证不会越过 deadline 多睡。
// [失败路径] 超时返回 undefined，调用方必须抛错而不是回落顶层。
async function waitForOopifTarget(
  view: ControlledView,
  frameId: string,
): Promise<string | undefined> {
  const deadline = Date.now() + OOPIF_TARGET_REGISTRATION_TIMEOUT_MS;
  for (;;) {
    const targets = (await view.cdp
      .send("Target.getTargets")
      .catch(() => undefined)) as
      | { targetInfos?: Array<{ targetId?: string; type?: string }> }
      | undefined;
    if (
      targets?.targetInfos?.some(
        (target) => target.targetId === frameId && target.type === "iframe",
      )
    ) {
      const sessionId = await tryAttachFrameTarget(view, frameId);
      if (sessionId) return sessionId;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining)),
    );
  }
}

// [事务] 解析阶段的每次 attach 都是先登记后使用，保证异常时能整体回滚。
// [事务] 每轮循环只下沉一层 frame，visited 集合负责收敛，环检测错误文案必须固定，便于上层识别。
// [并发] attachedSessionIds 只在当前解析内可见，不能跨调用共享，避免并发粘贴互相 detach。
// OOPIF 分支 attach 成功后立即 enable Page/Runtime/DOM 三个域，缺一个后续 describeNode 会失败。
// [失败路径] catch 中先 detach 再 rethrow，保持原始错误类型与文案不被覆盖。
// [权衡] 同进程 frame 优先用 isolated world 而非 attach，是为了复用当前 session 减少握手开销。
async function resolveFocusedTarget(
  view: ControlledView,
  initialTarget: BrowserInputExecutionTarget = {},
): Promise<FocusedTargetResolution> {
  let target = initialTarget;
  const attachedSessionIds: string[] = [];
  const visited = new Set<string>();
  try {
    for (;;) {
      const key = targetKey(target);
      if (visited.has(key))
        throw new Error("Browser Use encountered a focused frame cycle");
      visited.add(key);
      const response = (await send(view, target, "Runtime.evaluate", {
        ...(target.contextId == null ? {} : { contextId: target.contextId }),
        expression: FOCUSED_FRAME_EXPRESSION,
        returnByValue: false,
      })) as RuntimeResponse;
      if (runtimeError(response))
        throw new Error("Browser Use could not inspect the focused frame");
      const objectId = response.result?.objectId;
      if (!objectId) return { attachedSessionIds, target };
      let frameId: string | undefined;
      try {
        const described = (await send(view, target, "DOM.describeNode", {
          objectId,
        })) as {
          node?: { frameId?: string };
        };
        frameId = described.node?.frameId;
      } finally {
        await send(view, target, "Runtime.releaseObject", { objectId }).catch(
          () => undefined,
        );
      }
      if (!frameId) return { attachedSessionIds, target };

      // 同进程 iframe 与 OOPIF 不能共享顶层 execution context。先按 Chromium 的
      // OOPIF targetId=frameId 尝试 attach；失败才在当前 target 为同进程 frame 建 isolated world。
      const attachedSessionId = await tryAttachFrameTarget(view, frameId);
      if (attachedSessionId) {
        attachedSessionIds.push(attachedSessionId);
        target = { sessionId: attachedSessionId };
        await Promise.all([
          send(view, target, "Page.enable"),
          send(view, target, "Runtime.enable"),
          send(view, target, "DOM.enable"),
        ]);
        continue;
      }
      const world = (await send(view, target, "Page.createIsolatedWorld", {
        frameId,
        grantUniveralAccess: false,
        worldName: "browser-use-virtual-clipboard",
      }).catch(() => undefined)) as { executionContextId?: number } | undefined;
      if (world?.executionContextId) {
        target = { ...target, contextId: world.executionContextId };
        continue;
      }

      // OOPIF navigation 时 DOM node 的 frameId 可能先于 Target registry 可见。
      // 用有界 getTargets 轮询等待目标可用，禁止错误回落到顶层输入。
      const delayedSessionId = await waitForOopifTarget(view, frameId);
      if (!delayedSessionId)
        throw new Error(
          `Browser Use could not resolve an input target for frame ${frameId}`,
        );
      attachedSessionIds.push(delayedSessionId);
      target = { sessionId: delayedSessionId };
      await Promise.all([
        send(view, target, "Page.enable"),
        send(view, target, "Runtime.enable"),
        send(view, target, "DOM.enable"),
      ]);
    }
  } catch (error) {
    await detachAttachedSessions(view, attachedSessionIds);
    throw error;
  }
}

// [事务] 转义顺序固定为先 & 后 < > "，反序会把已生成的实体二次转义。
// 换行必须统一替换为 br，兼容 CRLF、LF 与 U+2028/U+2029 三种行分隔符。
// [权衡] 只覆盖 HTML 文本注入所需的最小字符集，不处理属性上下文引号差异。
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r\n", "<br>")
    .replaceAll(/[\r\n\u2028\u2029]/gu, "<br>");
}

// [事务] 返回结构是页面脚本的输入契约，entries 顺序即纯文本优先。
// includeRichText 为 false 时只投递 text/plain，避免富文本站点误判粘贴来源。
// [权衡] presentation_style 固定 unspecified，交给目标站点自行决定呈现样式。
function clipboardItems(text: string, includeRichText: boolean) {
  const entries = [{ mime_type: "text/plain", text }];
  if (includeRichText)
    entries.push({ mime_type: "text/html", text: escapeHtml(text) });
  return [{ entries, presentation_style: "unspecified" }];
}

// [权衡] 对 docs.google.com 的 spreadsheets 路径特判：表格把 HTML 当单元格标记解析，故跳过富文本。
// [失败路径] URL 解析失败时返回 true，宁可多投纯文本兼容分支，也不阻断粘贴。
// 只对 docs.google.com 做特判，其他站点必须默认允许富文本，减少维护面。
function shouldIncludeRichText(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.host !== "docs.google.com") return true;
    return parsed.pathname.split("/").filter(Boolean)[0] !== "spreadsheets";
  } catch {
    return true;
  }
}

// [并发] 每次调用必须生成独立 UUID，作为焦点归属凭证，不同粘贴请求之间不可复用。
// token 只写入页面元素的属性，不进入日志，避免泄漏可预测的焦点标识。
export function createInputTargetToken(): string {
  return randomUUID();
}

// [事务] 该校验与后续 evaluate 共享同一 target，保证校验对象与写入对象一致。
// 表达式递归穿透 shadowRoot 取最内层 activeElement，与 FOCUSED_FRAME_EXPRESSION 的口径保持一致。
// [失败路径] evaluate 异常包装成带原因的 Error，焦点不符则给出不含 token 的固定文案。
// [权衡] 只比较相等性不读取 token 明文，降低把凭证带出页面的风险。
export async function assertFocusedInputTarget(
  view: ControlledView,
  target: BrowserInputExecutionTarget,
  inputTargetToken: string,
): Promise<void> {
  const response = (await send(view, target, "Runtime.evaluate", {
    ...(target.contextId == null ? {} : { contextId: target.contextId }),
    expression: `(() => {
      const deepestActiveElement = (root) => {
        const active = root.activeElement;
        if (active == null) return null;
        const view = active.ownerDocument.defaultView ?? window;
        if (active instanceof view.HTMLElement && active.shadowRoot != null)
          return deepestActiveElement(active.shadowRoot) ?? active;
        return active;
      };
      return deepestActiveElement(document)?.${IAB_INPUT_TARGET_TOKEN_PROPERTY} === ${JSON.stringify(inputTargetToken)};
    })()`,
    returnByValue: true,
  })) as RuntimeResponse;
  const error = runtimeError(response);
  if (error)
    throw new Error(
      `Browser Use could not verify the focused input target: ${error}`,
    );
  if (response.result?.value !== true)
    throw new Error("Active element is no longer the expected input target");
}

// [事务] 先解析目标再执行粘贴，解析失败直接抛出，不会产生半写入。
// [资源] finally 中 detach 本次解析独占的 session，成功与失败路径统一释放。
// includeRichText 缺省由当前 URL 推导，显式传参优先，保持调用方可覆盖。
// args 中 inputTargetToken 缺省时不注入字段，避免页面脚本拿到 undefined 参与比较。
// [失败路径] 页面函数被包在 async IIFE 中，异常转成 ok:false 返回，主进程再统一抛错。
// [失败路径] 返回值必须是带 ok 字段的对象，否则判定为协议异常而不是页面异常。
// [权衡] replaceInputValue 严格等于 true 才生效，避免 truthy 值误触发整段替换。
export async function pasteTextIntoFocusedTarget(
  view: ControlledView,
  text: string,
  options: {
    includeRichText?: boolean;
    initialTarget?: BrowserInputExecutionTarget;
    inputTargetToken?: string;
    replaceInputValue?: boolean;
  } = {},
): Promise<void> {
  const resolution = await resolveFocusedTarget(view, options.initialTarget);
  try {
    const includeRichText =
      options.includeRichText ?? shouldIncludeRichText(view.webContents.getURL());
    const args = {
      clipboardItems: clipboardItems(text, includeRichText),
      ...(options.inputTargetToken == null
        ? {}
        : { inputTargetToken: options.inputTargetToken }),
      replaceInputValue: options.replaceInputValue === true,
      richTextFallback: includeRichText,
    };
    const response = (await send(view, resolution.target, "Runtime.evaluate", {
      ...(resolution.target.contextId == null
        ? {}
        : { contextId: resolution.target.contextId }),
      expression: `(async () => {
        try {
          const pageFunction = ${VIRTUAL_PASTE_PAGE_FUNCTION};
          const data = await pageFunction(${JSON.stringify(args)});
          return { ok: true, data };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })) as RuntimeResponse;
    const error = runtimeError(response);
    if (error)
      throw new Error(
        `Browser Use encountered an error interacting with this webpage's clipboard: ${error}`,
      );
    const value = response.result?.value;
    if (!value || typeof value !== "object" || !("ok" in value))
      throw new Error(
        "Browser Use encountered an error interacting with this webpage's clipboard: type returned an invalid result",
      );
    if ((value as { ok?: unknown }).ok !== true) {
      const message =
        "error" in value &&
        typeof (value as { error?: unknown }).error === "string"
          ? (value as { error: string }).error
          : "type failed";
      throw new Error(
        `Browser Use encountered an error interacting with this webpage's clipboard: ${message}`,
      );
    }
  } finally {
    await detachAttachedSessions(view, resolution.attachedSessionIds);
  }
}
