// INV-01 一次一组：守住位置 已结算标记；改错故障：同一次打开重复上报。
// INV-02 起点明确：守住位置 身份建立时的计时；改错故障：耗时包含挂载前的等待。
// INV-03 超时兜底：守住位置 计时器；改错故障：挂起的打开永远没有结果。
// INV-04 超时清理：守住位置 结算与卸载分支；改错故障：卸载后计时器仍触发上报。
// INV-05 冷热归因：守住位置 打开类型推断；改错故障：复用会话被当成冷启动。
// INV-06 阶段耗时只给冷启：守住位置 类型判断；改错故障：把上一次订阅的耗时算进本次。
// INV-07 成功需活跃：守住位置 状态判断；改错故障：连接中或失败被提前记成成功。
// INV-08 快照需匹配：守住位置 会话一致性检查；改错故障：重连保留的旧快照让新会话记成成功。
// INV-09 绘制后结算：守住位置 两帧调度；改错故障：可交互耗时偏小。
// INV-10 调度可取消：守住位置 返回的取消函数；改错故障：状态回退后仍上报成功。
// INV-11 失败即时：守住位置 错误分支；改错故障：失败要等到超时才结算。
// INV-12 错误码收敛：守住位置 消息解析；改错故障：任意文本进入错误码字段。
// INV-13 耗时非负：守住位置 差值夹紧；改错故障：时钟回拨产生负耗时。
// INV-14 身份稳定：守住位置 追踪标识；改错故障：同一次打开被拆成多条轨迹。
// INV-15 禁用即静默：守住位置 开关判断；改错故障：禁用场景仍产生上报。
// INV-16 只读即静默：守住位置 只读判断；改错故障：只读面板污染打开统计。
// INV-17 上报器可选：守住位置 透传参数；改错故障：未安装上报器时抛错。
// INV-18 依赖完整：守住位置 三个布局效果；改错故障：闭包持有过期会话或上报器。
//
// 模块职责：以面板首次获取为起点，记录会话打开的开始、成功、失败与超时。
// 状态所有权：本次打开的运行态归引用；上报归外部上报器。
// 阅读顺序：常量 → 计时与调度 → 结算 → 参数 → 运行态建立 → 成功与失败分支。
import { useLayoutEffect, useRef } from "react";
import { createSessionTraceId } from "@zcode/shared";
import type { ConversationOpenTiming, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  reportSessionOpenResult,
  reportSessionOpenStart,
  type SessionOpenIdentity,
  type SessionOpenKind,
  type SessionOpenArmsReporter,
  type SessionOpenTrigger,
} from "@/lib/sessionOpenArmsTelemetry.js";
import type { SessionOpenRendererTiming } from "@/v4/conversationProjectionStore.js";

// 超时上限固定三十秒，防止悬挂打开永远无结果。
// SESSION_OPEN_TIMEOUT_MS 触顶后按兜底结果结算，不抛错也不重试。
//
const SESSION_OPEN_TIMEOUT_MS = 30_000;

interface SessionOpenRuntime {
  identity: SessionOpenIdentity;
  startedAt: number;
  finished: boolean;
  commitAt?: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

// now() 优先用 performance.now 高精度计时，环境缺失时回退 Date.now。
// 两者都只用于计算耗时差值。
//
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// 优先等两帧，确保绘制后再结算。
// 无 requestAnimationFrame 时退化为 setTimeout，保持同一回调契约。
//
function scheduleAfterPaint(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  firstFrame = window.requestAnimationFrame(() => {
    secondFrame = window.requestAnimationFrame(callback);
  });
  return () => {
    if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
    if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
  };
}

// errorCodeFromMessage 只接受 fault.* 标准形态，带括号的尾注也提取。
// 其它文本不当作错误码，避免污染统计。
//
function errorCodeFromMessage(message: string | null): string | undefined {
  if (!message) return undefined;
  return /^fault\.[A-Za-z0-9._-]+$/.test(message.trim())
    ? message.trim()
    : /\((fault\.[A-Za-z0-9._-]+)\)\s*$/.exec(message)?.[1];
}

// runtime.finished 已结算直接返回，保证一次打开只上报一次。
// 非 cold 启动不携带 openTiming 阶段耗时，避免混入上一次数据。
// 总耗时以 now() 单调差值计算并夹紧到零。
//
function finishSessionOpen(
  runtime: SessionOpenRuntime,
  status: "success" | "failed" | "timeout",
  options: {
    snapshot?: ConversationSnapshot | null;
    openTiming?: ConversationOpenTiming;
    rendererTiming?: SessionOpenRendererTiming;
    paintToInteractiveMs?: number;
    errorMessage?: string | null;
    reporter?: SessionOpenArmsReporter | null;
  } = {},
): void {
  if (runtime.finished) return;
  runtime.finished = true;
  if (runtime.timeoutId !== undefined) clearTimeout(runtime.timeoutId);
  // Bug 原因：warm/keep-warm 都复用已有 projection store，state 中的 timing 属于上一次
  // cold subscribe；只有本次真正创建 store 并订阅的 cold 打开才能携带这些阶段耗时。
  const hasCurrentSubscribeTiming = runtime.identity.openKind === "cold";
  const openTiming = hasCurrentSubscribeTiming ? options.openTiming : undefined;
  const rendererTiming = hasCurrentSubscribeTiming ? options.rendererTiming : undefined;
  const snapshot = options.snapshot;
  reportSessionOpenResult(
    {
      ...runtime.identity,
      status,
      totalMs: Math.max(0, now() - runtime.startedAt),
      errorPhase: status === "success" ? undefined : "conversation_subscribe",
      errorCode: errorCodeFromMessage(options.errorMessage ?? null),
      rendererPrepareMs: rendererTiming?.rendererPrepareMs,
      hostPrepareMs: openTiming?.hostPrepareMs,
      providerRegistrySyncMs: openTiming?.providerRegistrySyncMs,
      taskMetaReadMs: openTiming?.taskMetaReadMs,
      cliRequestMs: openTiming?.cliRequestMs,
      cliBootstrapMs: openTiming?.cliBootstrapMs,
      cliSessionRestoreMs: openTiming?.cliSessionRestoreMs,
      initialFrameEncodeMs: openTiming?.initialFrameEncodeMs,
      initialFrameTransportMs: rendererTiming?.initialFrameTransportMs,
      rendererSnapshotApplyMs: rendererTiming?.rendererSnapshotApplyMs,
      reactRenderMs:
        runtime.commitAt !== undefined && rendererTiming?.snapshotAppliedAt !== undefined
          ? Math.max(0, runtime.commitAt - rendererTiming.snapshotAppliedAt)
          : undefined,
      paintToInteractiveMs: options.paintToInteractiveMs,
      cliProcessState: openTiming?.cliProcessState,
      sessionRuntimeState: openTiming?.sessionRuntimeState,
      snapshotRowCount: openTiming?.snapshotRowCount ?? snapshot?.rows.window.length,
    },
    options.reporter,
  );
}

// 参数全部由调用方注入，hook 自身不读全局。
// 禁用与只读场景由开关控制，不上报。
//
export interface UseSessionOpenArmsTelemetryParams {
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
  openTiming?: ConversationOpenTiming;
  rendererTiming?: SessionOpenRendererTiming;
  openKind?: SessionOpenKind;
  openTrigger?: SessionOpenTrigger;
  startedAt?: number;
  status: "connecting" | "live" | "error" | "closed";
  lastError: string | null;
  enabled?: boolean;
  readOnly?: boolean;
  reporter?: SessionOpenArmsReporter | null;
}

/**
 * 以 pane 首次 acquire 为 Renderer 可观测的打开起点；同一逻辑打开只发一组 start/result。
 * Web/mobile 即使挂载，也因 reporter 未安装而保持 no-op。
 */
// 以首次获取为打开起点，同一逻辑打开只发一组事件。
// 上报器未安装时天然无操作。
//
export function useSessionOpenArmsTelemetry({
  sessionId,
  snapshot,
  openTiming,
  rendererTiming,
  openKind,
  openTrigger,
  startedAt,
  status,
  lastError,
  enabled = true,
  readOnly = false,
  reporter,
}: UseSessionOpenArmsTelemetryParams): void {
  const runtimeRef = useRef<SessionOpenRuntime | null>(null);
  const latestTimingRef = useRef<{
    openTiming?: ConversationOpenTiming;
    rendererTiming?: SessionOpenRendererTiming;
  }>({ openTiming, rendererTiming });
  latestTimingRef.current = { openTiming, rendererTiming };

  // 禁用、只读或缺少会话时清空运行时。
  // identity 变化时重建 runtimeRef 运行时并重新计时。
  //
  useLayoutEffect(() => {
    if (!enabled || readOnly || !sessionId) {
      runtimeRef.current = null;
      return undefined;
    }
    // 未显式指定时按快照会话是否一致推断冷热。
    // resolvedOpenKind 推断只影响归因，不改变订阅行为。
    //
    const resolvedOpenKind: SessionOpenKind =
      openKind ?? (snapshot?.sessionId === sessionId ? "keep_warm" : "cold");
    const runtime: SessionOpenRuntime = {
      identity: {
        sessionOpenId: createSessionTraceId(),
        sessionId,
        openTrigger: openTrigger ?? "pane",
        openKind: resolvedOpenKind,
        clientMode: "desktop-continuous",
      },
      startedAt: startedAt ?? now(),
      finished: false,
    };
    runtimeRef.current = runtime;
    reportSessionOpenStart(runtime.identity, reporter);
    runtime.timeoutId = setTimeout(() => {
      const latestTiming = latestTimingRef.current;
      finishSessionOpen(runtime, "timeout", {
        openTiming: latestTiming.openTiming,
        rendererTiming: latestTiming.rendererTiming,
        reporter,
      });
    }, SESSION_OPEN_TIMEOUT_MS);
    return () => {
      if (runtime.timeoutId !== undefined) clearTimeout(runtime.timeoutId);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [enabled, openKind, openTrigger, readOnly, reporter, sessionId, startedAt]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    // Bug 原因：runtime 重连会保留旧 snapshot；connecting/error 时仅凭 sessionId 命中会把
    // 尚不可交互或最终失败的打开提前记成 success。成功终态必须与 UI 的 live 状态一致。
    if (
      !runtime ||
      runtime.finished ||
      status !== "live" ||
      !sessionId ||
      snapshot?.sessionId !== sessionId
    ) {
      return;
    }
    runtime.commitAt = now();
    // 成功终态要求界面已进入活跃且快照匹配。
    // 重连时保留旧快照，仅凭会话命中会误记成功。
    //
    const cancelPaint = scheduleAfterPaint(() => {
      finishSessionOpen(runtime, "success", {
        snapshot,
        openTiming,
        rendererTiming,
        paintToInteractiveMs: Math.max(0, now() - runtime.commitAt!),
        reporter,
      });
    });
    return cancelPaint;
  }, [openTiming, rendererTiming, reporter, sessionId, snapshot, status]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || runtime.finished || status !== "error") return;
    finishSessionOpen(runtime, "failed", {
      openTiming,
      rendererTiming,
      errorMessage: lastError,
      reporter,
    });
  }, [lastError, openTiming, rendererTiming, reporter, status]);
}
