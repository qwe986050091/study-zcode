// INV-01 每次选择有独立运行号：守住位置 启动与取消；改错故障 迟到结果覆盖新一轮。
// INV-02 运行号不匹配直接丢弃：守住位置 回包判断；改错故障 旧选择被加入新会话。
// INV-03 executeJs 走 ref 固定：守住位置 依赖数组；改错故障 每次渲染重建回调。
// INV-04 回包先验形状：守住位置 类型守卫；改错故障 任意对象被当成选择结果。
// INV-05 上下文再验一次：守住位置 载荷构造；改错故障 缺字段载荷进入聊天队列。
// INV-06 取消要先递增运行号：守住位置 取消函数首行；改错故障 在途结果仍然生效。
// INV-07 取消失败只记调试：守住位置 捕获分支；改错故障 取消失败阻断状态复位。
// INV-08 只能以 origin 与路径记日志：守住位置 URL 清洗；改错故障 查询串中的敏感值进日志。
// INV-09 非法 URL 回退截断：守住位置 兜底分支；改错故障 清洗函数自身抛错。
// INV-10 Esc 有双通道：守住位置 窗口监听；改错故障 焦点在外层时无法取消。
// INV-11 仅在选择中挂监听：守住位置 早退分支；改错故障 空闲时吞掉 Escape。
// INV-12 捕获阶段监听：守住位置 addEventListener；改错故障 内层组件先消费按键。
// INV-13 卸载时取消：守住位置 清理副作用；改错故障 页面切换后选择态残留。
// INV-14 成功只发事件：守住位置 分发调用；改错故障 直接写聊天状态导致双写。
// INV-15 失败向上抛：守住位置 捕获末尾；改错故障 调用方无从感知错误。
// INV-16 结束态按运行号复位：守住位置 finally；改错故障 新一轮被旧轮复位成空闲。
// INV-17 标签可局部覆盖：守住位置 脚本构造；改错故障 调用方必须传全量文案。
// INV-18 返回值形状稳定：守住位置 末尾对象；改错故障 调用方解构时缺字段。
//
// 模块职责：封装网页元素选择的生命周期、取消与结果分发。
// 状态所有权：选择中标志与运行号归本 hook；载荷归聊天侧。
// 阅读顺序：先看运行号，再看启动与取消，最后看键盘兜底。
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/logger.js";
import {
  dispatchWebElementContextAddToChat,
  isWebElementContextPayload,
  type WebElementContextPayload,
} from "@/lib/webElementContext.js";
import {
  buildCancelWebElementPickerScript,
  buildWebElementPickerScript,
  type WebElementPickerScriptLabels,
  type WebElementPickerScriptResult,
} from "@/lib/webElementPickerScript.js";

interface UseWebElementPickerOptions {
  /**
   * 传输无关的脚本执行出口：把选择脚本送到目标网页并回传结果。
   * UnifiedBrowserView 走 main IPC（executeJavaScript）。
   */
  executeJs: (script: string) => Promise<unknown>;
  workspacePath: string;
  workspaceIdentity?: string;
  labels?: Partial<WebElementPickerScriptLabels>;
}

function isWebElementPickerScriptResult(result: unknown): result is WebElementPickerScriptResult {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const candidate = result as WebElementPickerScriptResult;
  return (
    candidate.status === "cancelled" ||
    (candidate.status === "selected" &&
      typeof candidate.element === "object" &&
      candidate.element !== null)
  );
}

function buildPayload(params: {
  result: Extract<WebElementPickerScriptResult, { status: "selected" }>;
  workspacePath: string;
  workspaceIdentity?: string;
}): WebElementContextPayload | null {
  const payload: WebElementContextPayload = {
    ...params.result.element,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };

  return isWebElementContextPayload(payload) ? payload : null;
}

function sanitizeUrlForLog(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/u)[0] ?? "";
  }
}

// isPicking 只控制界面态，不参与并发判定。
// activePickerRunRef 的运行号是并发正确性的核心。
// 执行出口用 ref 固定引用。
// startPicking 与 cancelPicking 共享 activePickerRunRef 同一运行号。
// 返回值四个成员都稳定。
export function useWebElementPicker({
  executeJs,
  workspacePath,
  workspaceIdentity,
  labels,
}: UseWebElementPickerOptions) {
  const [isPicking, setIsPicking] = useState(false);
  const activePickerRunRef = useRef(0);
  // executeJs 引用可能随每次渲染变化；用 ref 固定，避免 useCallback 依赖它而频繁重建。
  const executeJsRef = useRef(executeJs);
  executeJsRef.current = executeJs;

  // cancelPicking 先自增 activePickerRunRef 再复位 isPicking。
  // 随后才通过 executeJsRef 向页面发送取消脚本。
  // 取消脚本失败不影响 isPicking 已复位的状态。
  // logger.debug 只记录 error.message。
  // cancelPicking 的依赖数组为空，回调不依赖外部可变值。
  const cancelPicking = useCallback(async () => {
    activePickerRunRef.current += 1;
    setIsPicking(false);

    try {
      await executeJsRef.current(buildCancelWebElementPickerScript());
    } catch (error) {
      logger.debug("[UnifiedBrowserView] 取消网页元素选择失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  // startPicking 先自增 activePickerRunRef 占领运行号。
  // 回包后先比对 activePickerRunRef.current 与 runId。
  // 形状不符时只 logger.warn，不抛错。
  // activePickerRunRef.current 不一致说明已被取消，直接结束本次。
  // 载荷无效则丢弃并 logger.warn 记警告。
  const startPicking = useCallback(async () => {
    const runId = activePickerRunRef.current + 1;
    activePickerRunRef.current = runId;
    setIsPicking(true);
    logger.info("[UnifiedBrowserView] 开始网页元素选择");

    try {
      const result = await executeJsRef.current(
        buildWebElementPickerScript(labels ? { labels } : {}),
      );
      if (activePickerRunRef.current !== runId) {
        return;
      }

      if (!isWebElementPickerScriptResult(result)) {
        logger.warn("[UnifiedBrowserView] 网页元素选择返回了无法识别的结果");
        return;
      }

      if (result.status === "cancelled") {
        logger.info("[UnifiedBrowserView] 网页元素选择已取消");
        return;
      }

      const payload = buildPayload({
        result,
        workspacePath,
        workspaceIdentity,
      });
      if (!payload) {
        logger.warn("[UnifiedBrowserView] 网页元素上下文无效，已丢弃");
        return;
      }

      dispatchWebElementContextAddToChat(payload);
      logger.info("[UnifiedBrowserView] 网页元素上下文已加入聊天", {
        tagName: payload.tagName,
        url: sanitizeUrlForLog(payload.pageUrl),
      });
    } catch (error) {
      logger.warn("[UnifiedBrowserView] 网页元素选择失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (activePickerRunRef.current === runId) {
        setIsPicking(false);
      }
    }
  }, [labels, workspaceIdentity, workspacePath]);

  const togglePicking = useCallback(async () => {
    if (isPicking) {
      await cancelPicking();
      return;
    }
    await startPicking();
  }, [cancelPicking, isPicking, startPicking]);

  useEffect(() => {
    if (!isPicking) {
      return;
    }

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      // 受控视图获得焦点时由注入脚本处理 Esc；焦点还在外层工具栏时，
      // 这里兜底取消，保证选择态不会因为焦点位置不同而卡住。
      void cancelPicking();
    };

    // 捕获阶段先于业务组件。
    // 只拦截 Escape 一个键。
    // 卸载时用同一 handleWindowKeyDown 引用 removeEventListener。
    // 依赖包含取消回调与状态。
    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, [cancelPicking, isPicking]);

  useEffect(() => {
    return () => {
      void cancelPicking();
    };
  }, [cancelPicking]);

  return {
    cancelPicking,
    isPicking,
    startPicking,
    togglePicking,
  };
}
