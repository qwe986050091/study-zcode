// ============================================================
// 文件定位：浏览器命令的取消原语、副作用判定与错误分类（结果码映射的唯一来源）。
// 输入输出：raceWithAbort 返回原 promise 值或以 AbortError 拒绝；classifyError 输出 BrowserErrorCode。
// 副作用：挂/摘 abort 监听（once）；不触碰浏览器状态。
// 失败语义：取消抛 DOMException(AbortError)；错误分类未知时保守归为 execution_error。
// 不变量：监听器在 promise 结算后必定移除；副作用判定宁可多报（cancelled 时标 uncertain）。
// ============================================================
import type { BrowserCommand, BrowserErrorCode } from "@zcode/contracts";

// 统一的取消错误：name=AbortError，供 classifyError 识别为 cancelled。
export function abortError(): Error {
  return new DOMException("Browser command cancelled", "AbortError");
}

// 让任意 promise 与 signal 竞速：signal 已取消立即抛错，否则等待原 promise 并清理监听。
// 注意这里不取消底层 Playwright 操作，只是让上层尽快返回（底层由 session/close 回收）。
export async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// 是否可能改变页面/浏览器状态：决定“已派发后被取消”是否需要标记不确定副作用。
// Playwright locator 的写操作与 evaluate 一律视为有副作用；纯读取命令返回 false。
export function hasSideEffects(command: BrowserCommand): boolean {
  if (command.method === "playwright" && command.action.name === "locator") {
    return ["click", "dblclick", "fill", "press", "selectOption", "setChecked"].includes(
      command.action.operation,
    );
  }
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "handleDialog",
    "close",
    "newTab",
    "evaluate",
  ].includes(command.method);
}

// 错误 → 契约错误码：AbortError→cancelled、TimeoutError→timeout、
// 含 unavailable/closed/disconnected 文案→backend_unavailable，其余→execution_error。
export function classifyError(error: unknown): BrowserErrorCode {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /unavailable|closed|disconnected/iu.test(error.message)) {
    return "backend_unavailable";
  }
  return "execution_error";
}
