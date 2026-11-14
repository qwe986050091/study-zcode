// INV-01 结构化返回：守住位置 外层 try/catch；改错故障 异常穿透 host↔main 桥，调用方拿不到结果。
// INV-02 永不 throw：守住位置 catch 内 done 返回；改错故障 主进程未捕获拒绝。
// INV-03 耗时统一计算：守住位置 done 包装；改错故障 各分支自行计时且口径不一。
// INV-04 取消优先于超时：守住位置 cancelled 判断在前；改错故障 用户取消被报成超时。
// INV-05 取消识别双源：守住位置 signal.aborted 与 AbortError；改错故障 不同 Playwright 版本的取消漏判。
// INV-06 超时识别双源：守住位置 name 与文案正则；改错故障 超时退化为执行错误。
// INV-07 未实现显式声明：守住位置 default 分支；改错故障 未知命令静默成功。
// INV-08 不支持清单写进消息：守住位置 available 列表；改错故障 调用方不知道可用能力。
// INV-09 简单导航直接走 webContents：守住位置 back/forward/reload；改错故障 多绕一层 handler 引入时序差。
// INV-10 状态随动作返回：守住位置 readState；改错故障 调用方要多一次往返。
// INV-11 playwright 收窄为 action：守住位置 command.action；改错故障 整个命令对象下传导致类型漂移。
// INV-12 取消信号透传：守住位置 opts?.signal；改错故障 长动作无法中断。
// INV-13 处理器只做分派：守住位置 各 case 单行返回；改错故障 分派层堆积业务逻辑。
// INV-14 类型出口集中：守住位置 两组 re-export；改错故障 消费者从实现文件深层导入。
//
// 模块职责：executeBrowserCommandOnView 把一条浏览器命令分派给对应的交互或页面处理器，并统一包装结果与错误码。
// 阅读顺序：先看 done 包装，再看 switch 分派，最后看 catch 的三类错误归一。
import type { BrowserCommand, BrowserCommandResult } from "@zcode/shared";
import {
  handleCheck,
  handleClick,
  handleCuaDrag,
  handleCuaKeypress,
  handleCuaScroll,
  handleDomCuaScroll,
  handleDrag,
  handleElementInfo,
  handleHover,
  handlePress,
  handleScroll,
  handleSelect,
  handleType,
} from "./browserCommandInteractionHandlers.js";
import {
  handleEvaluate,
  handleGetState,
  handleNavigate,
  handleScreenshot,
  handleSnapshot,
} from "./browserCommandPageHandlers.js";
import { now, readState } from "./browserCommandState.js";
import type { ControlledView } from "./browserCommandTypes.js";
import { handlePlaywrightAction } from "./browserPlaywrightExecutor.js";

// isAllowedBrowserUrl 与 BrowserPoint 等类型及校验入口在此集中导出。
export { isAllowedBrowserUrl } from "./browserCommandState.js";
export type {
  BrowserPoint,
  ControlledView,
  ControlledViewCdp,
  ControlledViewWebContents,
} from "./browserCommandTypes.js";

/**
 * 核心子集：navigate / getState / screenshot / snapshot / click / type / press / scroll；
 * 其余（fill/waitFor/capabilities）返回 capability_unsupported；playwrightWaitForTimeout 由
 * BrowserGuestManager 在校验 scope/tab 后处理，不进入页面 executor。
 * 抛错结构化返回，不 throw（保证 host↔main 桥能拿到结果）。
 */
// 分派层是命令进入页面的唯一入口。
export async function executeBrowserCommandOnView(
  view: ControlledView,
  command: BrowserCommand,
  opts?: { navigateSettleMs?: number; signal?: AbortSignal },
): Promise<BrowserCommandResult> {
  const startedAt = now();
  // 所有出口都必须经过 done 这一个包装。
  const done = (partial: Omit<BrowserCommandResult, "elapsedMs">): BrowserCommandResult => ({
    ...partial,
    elapsedMs: now() - startedAt,
  });

  try {
    switch (command.method) {
      // navigate 的导航与等待策略交给 handleNavigate 页面处理器。
      case "navigate":
        return await handleNavigate(view, command, done, opts);
      case "getState":
        return await handleGetState(view, done);
      // 三个历史动作直接调用 webContents。
      case "back":
        view.webContents.goBack();
        return done({ ok: true, state: readState(view.webContents) });
      case "forward":
        view.webContents.goForward();
        return done({ ok: true, state: readState(view.webContents) });
      case "reload":
        view.webContents.reload();
        return done({ ok: true, state: readState(view.webContents) });
      case "screenshot":
        return await handleScreenshot(view, command, done);
      case "snapshot":
        return await handleSnapshot(view, command, done);
      case "click":
        return await handleClick(view, command, done);
      case "type":
        return await handleType(view, command, done);
      case "press":
        return await handlePress(view, command, done);
      case "cuaKeypress":
        return await handleCuaKeypress(view, command, done);
      case "scroll":
        return await handleScroll(view, command, done);
      case "cuaScroll":
        return await handleCuaScroll(view, command, done);
      case "domCuaScroll":
        return await handleDomCuaScroll(view, command, done);
      case "hover":
        return await handleHover(view, command, done);
      case "select":
        return await handleSelect(view, command, done);
      case "check":
        return await handleCheck(view, command, done);
      case "drag":
        return await handleDrag(view, command, done);
      case "cuaDrag":
        return await handleCuaDrag(view, command, done);
      case "elementInfo":
        return await handleElementInfo(view, command, done);
      // 脚本求值同样返回结构化错误。
      case "evaluate":
        return await handleEvaluate(view, command, done);
      // Playwright 命令只透传 action 与信号。
      case "playwright":
        // 取消信号必须进到动作内部。
        return await handlePlaywrightAction(view, command.action, done, opts?.signal);
      // 未实现能力显式失败，不静默。
      default:
        // fill/waitFor/capabilities/getDialog/handleDialog/close/list/playwrightWaitForTimeout
        // 未在本 executor 实现（由 manager 层或后续增量处理）。
        return done({
          ok: false,
          error: {
            // 错误码固定，便于上层分支。
            code: "capability_unsupported",
            message: `command ${command.method} is not supported by executor (available: navigate/getState/back/forward/reload/screenshot/snapshot/click/type/press/scroll/hover/select/check/drag/elementInfo/evaluate)`,
          },
        });
    }
  } catch (error) {
    // AbortError 表示调用方主动终止当前 generation。过去统一包装成 execution_error，
    // 会让上层误判为页面或 Playwright 执行失败，无法按取消生命周期清理请求。
    // 取消判定先于超时判定。
    const cancelled =
      opts?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
    // timedOut 同时看 TimeoutError 类型与 timed out 文案。
    const timedOut =
      !cancelled &&
      error instanceof Error &&
      (error.name === "TimeoutError" || /\b(?:timed out|timeout exceeded)\b/iu.test(error.message));
    return done({
      ok: false,
      error: {
        // 三类错误码互斥且稳定。
        code: cancelled ? "cancelled" : timedOut ? "timeout" : "execution_error",
        message: cancelled
          ? "Browser command cancelled"
          : error instanceof Error
            ? error.message
            : String(error),
      },
    });
  }
}
