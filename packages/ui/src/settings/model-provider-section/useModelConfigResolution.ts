// INV-01 每次解析递增代次：守住位置 resolveCurrent；改错故障 旧回包覆盖新结果。
// INV-02 身份对象随三项变化重建：守住位置 useMemo；改错故障 A 到 B 再回 A 复用旧解析。
// INV-03 结果绑定身份：守住位置 返回值筛选；改错故障 旧身份结果被当前 UI 读取。
// INV-04 恢复路径单独放行：守住位置 条件；改错故障 恢复请求被默认值判断拦掉。
// INV-05 未打开不发请求：守住位置 早退；改错故障 弹层关闭时仍在打网络。
// INV-06 未启用不发请求：守住位置 早退；改错故障 禁用态触发无意义解析。
// INV-07 与原名相同不发请求：守住位置 早退；改错故障 继承态被当成显式选择。
// INV-08 代次、身份、启用三者共判：守住位置 isCurrent；改错故障 任一变化后旧结果仍提交。
// INV-09 默认值提示有节流：守住位置 定时器；改错故障 连续输入反复闪烁提示。
// INV-10 签名相同不重复提示：守住位置 比较；改错故障 同配置每次刷新都亮提示。
// INV-11 卸载时清定时器：守住位置 清理副作用；改错故障 卸载后仍写状态。
// INV-12 取消即增代次：守住位置 cancel；改错故障 在途请求回来仍提交。
// INV-13 失败也验代次：守住位置 捕获分支；改错故障 旧请求错误覆盖新字段反馈。
// INV-14 结束态按代次复位：守住位置 finally；改错故障 新一轮被旧轮置为未解析。
// INV-15 关闭时清签名：守住位置 条件分支；改错故障 重开弹层误判为已提示。
// INV-16 延迟触发有取消与立即两条：守住位置 触发器；改错故障 无法手动抢先解析。
// INV-17 结果对象不可变：守住位置 构造；改错故障 下游修改缓存结果。
// INV-18 返回值用只读断言：守住位置 末尾；改错故障 调用方误改返回结构。
//
// 模块职责：按打开态、启用态与模型标识调度一次配置解析。
// 状态所有权：结果、解析中、提示与代次都归本 hook。
// 阅读顺序：先看代次与身份，再看解析主体，最后看副作用与返回。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelConfigResolution } from "@zcode/provider";
import { useIdleTrigger } from "@/settings/model-provider-section/useIdleTrigger.js";

// 结果携带身份对象。
// resolving 与 defaultsLoaded 两个状态各自独立。
// 代次用 ref 避免额外渲染。
// identity 由 useMemo 随 open 与 modelId 变化重建。
// 启用态与身份都存 ref 供异步判断。
export function useModelConfigResolution({
  open,
  enabled = true,
  originalModelId,
  modelId,
  resolve,
}: {
  open: boolean;
  enabled?: boolean;
  originalModelId?: string;
  modelId: string;
  resolve?: (modelId: string) => Promise<ModelConfigResolution>;
}) {
  const [result, setResult] = useState<{
    readonly modelId: string;
    readonly identity: object;
    readonly resolution: ModelConfigResolution;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const generationRef = useRef(0);
  const identity = useMemo(() => ({}), [open, modelId, resolve]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const inheritedSignatureRef = useRef<string | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // resolveCurrent(restore) 传入 restore 时可跳过默认条件。
  // 模型标识先 trim。
  // generationRef.current 在请求前自增。
  // isCurrent() 综合 identity、generation 与 enabled 三项条件。
  // 成功后 setResult() 写结果，并由 restore.apply() 回调应用。
  const resolveCurrent = useCallback(
    async (restore?: {
      isCurrent: () => boolean;
      apply: (resolution: ModelConfigResolution) => void;
    }): Promise<ModelConfigResolution | undefined> => {
      const normalizedModelId = modelId.trim();
      if (
        !open ||
        !resolve ||
        !normalizedModelId ||
        (!restore && (!enabled || normalizedModelId === originalModelId))
      ) {
        return undefined;
      }
      const generation = ++generationRef.current;
      const isCurrent = () =>
        generationRef.current === generation &&
        identityRef.current === identity &&
        (restore ? restore.isCurrent() : enabledRef.current === enabled);
      setResolving(true);
      try {
        const resolution = await resolve(normalizedModelId);
        if (!isCurrent()) return undefined;
        const inheritedSignature = JSON.stringify(resolution.inheritedConfig);
        if (
          resolution.issues.length === 0 &&
          inheritedSignatureRef.current !== inheritedSignature
        ) {
          inheritedSignatureRef.current = inheritedSignature;
          setDefaultsLoaded(true);
          if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
          feedbackTimerRef.current = setTimeout(() => {
            feedbackTimerRef.current = null;
            setDefaultsLoaded(false);
          }, 3_500);
        }
        const nextResult = { modelId: normalizedModelId, identity, resolution };
        setResult(nextResult);
        restore?.apply(resolution);
        return resolution;
      } catch (error) {
        // 旧恢复请求的错误也必须服从身份/编辑代次，不能覆盖用户后来的字段反馈。
        if (!isCurrent()) return undefined;
        throw error;
      } finally {
        if (generationRef.current === generation) setResolving(false);
      }
    },
    [enabled, identity, modelId, open, originalModelId, resolve],
  );

  // idle 复用同一个 resolveCurrent()。
  // idle.cancel() 可取消，避免输入抖动。
  // idle 另提供立即触发入口，供手动刷新使用。
  // 触发只决定时序，条件仍由 effect 里的判断给出。
  const idle = useIdleTrigger(() => resolveCurrent());

  useEffect(() => {
    generationRef.current += 1;
    const normalizedModelId = modelId.trim();
    if (
      !open ||
      !enabled ||
      !resolve ||
      !normalizedModelId ||
      normalizedModelId === originalModelId
    ) {
      idle.cancel();
      setResult(null);
      setResolving(false);
      setDefaultsLoaded(false);
      if (!open) inheritedSignatureRef.current = null;
      return;
    }
    // 恢复成功与开启智能模式同批提交，沿用同一结果，不紧接着再发一次自动解析。
    if (result?.identity === identity) return;
    idle.schedule();
  }, [
    enabled,
    identity,
    idle.cancel,
    idle.schedule,
    modelId,
    open,
    originalModelId,
    resolve,
    result,
  ]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    },
    [],
  );

  // A→B→A 不能复用第一次 A 的回包；同 ID 不代表同一编辑/账号环境代次。
  // result.identity 与当前 identity 不符时，activeResult 对外为 null。
  // 该比较避免旧 identity 的结果短暂展示。
  // 取消与恢复都自增 generationRef，共用同一代次。
  // 返回的 result 结构整体只读。
  const activeResult = result?.identity === identity ? result.resolution : null;
  return {
    cancel: () => {
      generationRef.current += 1;
      idle.cancel();
      setResult(null);
    },
    restore: (intent: {
      isCurrent: () => boolean;
      apply: (resolution: ModelConfigResolution) => void;
    }) => {
      idle.cancel();
      return resolveCurrent(intent);
    },
    defaultsLoaded,
    flush: idle.flush,
    resolution: activeResult,
    resolving,
    scheduled: idle.scheduled,
  } as const;
}
