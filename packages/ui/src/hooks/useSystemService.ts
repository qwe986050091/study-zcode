// INV-01 超时下限一百毫秒：守住位置 归一化下界；改错故障 过小超时导致误判离线。
// INV-02 超时上限十秒：守住位置 归一化上界；改错故障 极端配置长时间拖住界面。
// INV-03 非数值回落默认超时：守住位置 有限值判断；改错故障 非数值进入请求。
// INV-04 尝试次数上限三次：守住位置 次数上界；改错故障 重试风暴拖垮探针。
// INV-05 尝试次数至少一次：守住位置 次数下界；改错故障 零次尝试永远没有结果。
// INV-06 成功数不超过目标数：守住位置 上界取目标长度；改错故障 门槛永远无法满足。
// INV-07 成功数至少一：守住位置 门槛下界；改错故障 空门槛让探测恒为真。
// INV-08 服务目标标识可缺省：守住位置 空值回退地址；改错故障 分组键为空互相覆盖。
// INV-09 标记与令牌去空白：守住位置 裁剪后判空；改错故障 空白被当成有效标记。
// INV-10 TCP 端口范围校验：守住位置 端口上下界；改错故障 非法端口进入连接。
// INV-11 非法端口回落二十二：守住位置 默认端口常量；改错故障 连接直接失败。
// INV-12 稳定键不重排目标：守住位置 保持入参顺序；改错故障 键随顺序变化。
// INV-13 稳定键含尝试与门槛：守住位置 三字段序列化；改错故障 参数变化不触发重探。
// INV-14 空请求键为固定串：守住位置 空值分支；改错故障 空请求键变成未定义。
// INV-15 仅最新探测可写回：守住位置 编号相等判断；改错故障 迟到结果覆盖新状态。
// INV-16 每次探测自增代际：守住位置 前置自增；改错故障 两次探测共用同一编号。
// INV-17 自动探测按稳定键触发：守住位置 effect 依赖；改错故障 内联对象导致持续重探。
// INV-18 本模块不缓存系统信息：守住位置 状态归各 hook；改错故障 多组件共享过期数据。
//
// 模块职责：系统信息与内网探测的 React hooks 及稳定键工具。
// 状态所有权：结果与加载态归各 hook 实例；服务实例来自服务容器。
// 阅读顺序：先看四个归一化函数，再读稳定键，最后看两个 hook 的代际控制。
/**
 * useSystemService —— 系统服务 hooks
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  IntranetProbeRequest,
  IntranetProbeResult,
  IntranetProbeTarget,
  SystemInfo,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "./useServices.js";

const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_PROBE_ATTEMPTS = 2;
const DEFAULT_PROBE_PORT = 22;
const MAX_PROBE_ATTEMPTS = 3;

function normalizeProbeTimeoutForStableKey(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(10_000, Math.max(100, Math.floor(timeoutMs)))
    : DEFAULT_PROBE_TIMEOUT_MS;
}

function normalizeProbeAttemptsForStableKey(attempts: number | undefined): number {
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) {
    return DEFAULT_PROBE_ATTEMPTS;
  }

  return Math.min(MAX_PROBE_ATTEMPTS, Math.max(1, Math.floor(attempts)));
}

function normalizeRequiredSuccessCountForStableKey(
  requiredSuccessCount: number | undefined,
  totalTargets: number,
): number {
  if (totalTargets <= 0) {
    return 1;
  }

  if (
    typeof requiredSuccessCount !== "number" ||
    !Number.isFinite(requiredSuccessCount)
  ) {
    return 1;
  }

  return Math.min(totalTargets, Math.max(1, Math.floor(requiredSuccessCount)));
}

function normalizeProbeTargetForStableKey(target: IntranetProbeTarget) {
  if (target.kind === "service") {
    const normalizedUrl = target.url.trim();
    const normalizedMarker = target.expectedMarker?.trim();
    const normalizedToken = target.token?.trim();

    return {
      kind: "service",
      id: target.id?.trim() || normalizedUrl,
      url: normalizedUrl,
      expectedMarker:
        normalizedMarker && normalizedMarker.length > 0 ? normalizedMarker : undefined,
      token: normalizedToken && normalizedToken.length > 0 ? normalizedToken : undefined,
      timeoutMs: normalizeProbeTimeoutForStableKey(target.timeoutMs),
    };
  }

  const normalizedHost = target.host.trim();
  const resolvedPort =
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535
      ? target.port
      : DEFAULT_PROBE_PORT;

  return {
    kind: "tcp",
    id: target.id?.trim() || `${normalizedHost}:${resolvedPort}`,
    host: normalizedHost,
    port: resolvedPort,
    timeoutMs: normalizeProbeTimeoutForStableKey(target.timeoutMs),
  };
}

/** 生成 request 的稳定 key，避免调用方传 inline object 时因引用变化导致重复自动探测 */
// request 为 null 时返回字符串 "null"，调用方可直接比较 key。
// normalizeProbeTargetForStableKey 逐个归一化 targets，host 与 port 的默认值在此时落定。
// attempts 与 requiredSuccessCount 一并进 JSON.stringify，数量配比变化会换 key。
// 键为 JSON 字符串。
// 目标顺序保持入参顺序。
// 该函数不缓存结果。
export function createIntranetProbeRequestStableKey(
  request: IntranetProbeRequest | null,
): string {
  if (!request) {
    return "null";
  }

  const normalizedTargets = request.targets.map(normalizeProbeTargetForStableKey);
  return JSON.stringify({
    attempts: normalizeProbeAttemptsForStableKey(request.attempts),
    requiredSuccessCount: normalizeRequiredSuccessCountForStableKey(
      request.requiredSuccessCount,
      normalizedTargets.length,
    ),
    targets: normalizedTargets,
  });
}

/** 只允许最后一次探测写回，防止并发请求乱序覆盖新状态 */
export function shouldApplyIntranetProbeRunResult(runId: number, latestRunId: number): boolean {
  return runId === latestRunId;
}

/** 获取系统信息，自带 loading/error/refresh 状态管理 */
// useState(true) 让 loading 初始为真，首帧不显示空信息。
// refresh 开头 setLoading(true) 并 setError(null)，重试不残留旧错误。
// systemService.info() 成功时把结果写入 setInfo。
// 抛出的值统一包成 Error 再 setError，非 Error 也保留 message。
// finally 里 setLoading(false)，失败路径同样结束加载。
// useEffect 依赖 refresh 并立即调用，挂载时自动探测一次系统信息。
export function useSystemInfo() {
  const { systemService } = useServices();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await systemService.info();
      setInfo(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [systemService]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { info, loading, error, refresh };
}

interface UseIntranetProbeOptions {
  enabled?: boolean;
  autoProbe?: boolean;
}

/** 探测当前运行环境是否满足内网判定条件 */
export function useIntranetProbe(
  request: IntranetProbeRequest | null,
  options: UseIntranetProbeOptions = {},
) {
  const { systemService } = useServices();
  const [result, setResult] = useState<IntranetProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const enabled = options.enabled ?? true;
  const autoProbe = options.autoProbe ?? true;
  const latestProbeRunIdRef = useRef(0);
  const latestRequestRef = useRef<IntranetProbeRequest | null>(request);
  latestRequestRef.current = request;
  const requestStableKey = createIntranetProbeRequestStableKey(request);

  // probeNow 先把 latestProbeRunIdRef 自增，用 runId 标记本次探测。
  // latestRequestRef.current 提供最新请求，避免 useCallback 闭包读到旧值。
  // enabled 为假或 request 为空时清空 result 与 error 并复位 probing。
  // setResult 之前用 shouldApplyIntranetProbeRunResult 校验代际，丢弃过期响应。
  // 失败路径同样校验 runId，只有最新一次探测能 setError。
  const probeNow = useCallback(async () => {
    // 并发探测需要代际控制，否则先发起的请求可能晚返回并覆盖新状态。
    // 这里用 runId 守卫，只允许最新一次探测落库，避免 isIntranet 在网络抖动时来回闪烁。
    const runId = latestProbeRunIdRef.current + 1;
    latestProbeRunIdRef.current = runId;
    const latestRequest = latestRequestRef.current;

    if (!enabled || !latestRequest) {
      setResult(null);
      setProbing(false);
      setError(null);
      return null;
    }

    setProbing(true);
    setError(null);
    try {
      const nextResult = await systemService.probeIntranet(latestRequest);
      if (!shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        return null;
      }
      setResult(nextResult);
      return nextResult;
    } catch (probeError) {
      const normalizedError =
        probeError instanceof Error ? probeError : new Error(String(probeError));
      if (!shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        return null;
      }
      setError(normalizedError);
      logger.warn("[IntranetProbe] 内网探测失败", normalizedError);
      return null;
    } finally {
      if (shouldApplyIntranetProbeRunResult(runId, latestProbeRunIdRef.current)) {
        setProbing(false);
      }
    }
  }, [enabled, systemService]);

  // autoProbe 为假时 useEffect 直接返回，不注册任何探测。
  // probeNow 的 useCallback 依赖只有 enabled 与 systemService，引用保持稳定。
  // requestStableKey 由 createIntranetProbeRequestStableKey 生成，内容变化才换键。
  // 依赖数组用稳定键替代 request 引用，内联对象不会触发重探。
  // 该 effect 无清理函数。
  useEffect(() => {
    if (!autoProbe) {
      return;
    }

    // 自动探测不能依赖 request 对象引用：调用方传 inline object 时，每次 render 都会变引用，
    // 使 effect 持续重探测。因此 probeNow 通过 ref 读取最新 request，并保持自身引用稳定；
    // effect 使用 requestStableKey 感知内容变化，避免仅引用变化就触发自动探测。
    void probeNow();
  }, [autoProbe, enabled, probeNow, requestStableKey]);

  return {
    result,
    isIntranet: result?.isIntranet ?? false,
    probing,
    error,
    probeNow,
  };
}
