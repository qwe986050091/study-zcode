// INV-01 缓存有效期一天：守住位置 TTL 常量；改错故障 每次进入升级页都打远端。
// INV-02 并发请求合并：守住位置 previewRequest；改错故障 多个面板同时挂载打出多份请求。
// INV-03 命中未过期缓存直接返回：守住位置 expiresAt 比较；改错故障 缓存写了却从不生效。
// INV-04 请求结束必清在飞引用：守住位置 finally；改错故障 失败后永久卡在同一个被拒 Promise。
// INV-05 禁用时不请求：守住位置 enabled 分支；改错故障 隐藏面板仍消耗配额。
// INV-06 服务缺失报 service_unavailable：守住位置 方法存在性判断；改错故障 面板空白且无原因。
// INV-07 错误文案统一归一化：守住位置 normalizeCodingPlanErrorMessage；改错故障 HTML 响应原样显示。
// INV-08 刷新保留旧预览：守住位置 函数式 setState；改错故障 每次刷新面板闪一下空白。
// INV-09 失败清空预览：守住位置 catch 内的 preview；改错故障 失败后仍展示过期套餐。
// INV-10 初始 loading 需三条件：守住位置 enabled 与服务与缓存；改错故障 有缓存时首帧仍显示转圈。
// INV-11 初始预览取缓存：守住位置 useState 初值；改错故障 首帧无内容，出现布局跳动。
// INV-12 effect 依赖 refresh：守住位置 依赖数组；改错故障 enabled 变化后不重新取数。
// INV-13 测试钩子只动模块缓存：守住位置 clear 与 prime；改错故障 测试需要挂载组件才能重置。
// INV-14 预览与套餐列表共用远端配置：守住位置 同一 client/configs；改错故障 两处限流互相踩踏。
//
// 模块职责：读取 Start Plan 预览配置，提供模块级缓存、请求合并与错误归一化。
// 阅读顺序：先看缓存与在飞变量，再看 hook 的初始态与刷新，最后看 loadStartPlanPreview。
import type { StartPlanPreviewConfig } from "@zcode/shared";
import { useCallback, useEffect, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { normalizeErrorMessage as normalizeCodingPlanErrorMessage } from "@/settings/model-provider-section/useCodingPlanProducts.js";

interface StartPlanPreviewState {
  preview: StartPlanPreviewConfig | null;
  loading: boolean;
  error: string | null;
}

// 缓存一天，跨会话复用同一份配置。
const START_PLAN_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// 模块级缓存独立于组件实例，卸载不丢。
let previewCache: { preview: StartPlanPreviewConfig | null; expiresAt: number } | null = null;
// `previewRequest` 是模块级单飞闸门，同一时刻只保留 1 个在飞请求。
let previewRequest: Promise<StartPlanPreviewConfig | null> | null = null;

export function useStartPlanPreview(options?: { enabled?: boolean }) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const enabled = options?.enabled !== false;
  const [state, setState] = useState<StartPlanPreviewState>({
    preview: previewCache?.preview ?? null,
    // 已有缓存时首帧不再显示加载。
    loading: enabled && Boolean(service) && !previewCache,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!enabled) {
      setState({
        preview: previewCache?.preview ?? null,
        loading: false,
        error: null,
      });
      return;
    }
    // `service` 为空或缺 `getStartPlanPreview` 方法时都落成不可用状态。
    if (!service || typeof service.getStartPlanPreview !== "function") {
      setState({
        preview: null,
        loading: false,
        error: "service_unavailable",
      });
      return;
    }

    // 刷新时保留旧预览，避免面板闪空。
    setState((current) => ({
      preview: current.preview,
      loading: true,
      error: null,
    }));

    try {
      const preview = await loadStartPlanPreview(service);
      setState({
        preview,
        loading: false,
        error: null,
      });
    } catch (error) {
      // Start Plan preview 和套餐列表共用 client/configs。
      // 远端返回 HTML/非 JSON 时也不能把解析错误原样显示到升级面板。
      // 错误统一归一化，非 JSON 响应不直接展示。
      const message = normalizeCodingPlanErrorMessage(error);
      logger.warn("[useStartPlanPreview] 读取 Start Plan 预览失败", {
        error: message,
      });
      setState({
        preview: null,
        loading: false,
        error: message,
      });
    }
  }, [enabled, service]);

  // refresh 标识变化即重新取数。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    ...state,
    refresh,
  };
}

export function clearStartPlanPreviewCacheForTest() {
  previewCache = null;
  previewRequest = null;
}

export function primeStartPlanPreviewCacheForTest(
  preview: StartPlanPreviewConfig | null,
) {
  // 测试钩子写入与真实缓存同形状。
  previewCache = {
    preview,
    expiresAt: Date.now() + START_PLAN_PREVIEW_CACHE_TTL_MS,
  };
  previewRequest = null;
}

async function loadStartPlanPreview(
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<StartPlanPreviewConfig | null> {
  const now = Date.now();
  // 未过期直接命中，不再打远端。
  if (previewCache && previewCache.expiresAt > now) {
    return previewCache.preview;
  }
  // 已有在飞请求就复用，避免重复打 client/configs。
  if (previewRequest) {
    return previewRequest;
  }

  // 远端配置一天内变化频率低，未登录设置页可能反复挂载，合并请求避免重复打 client/configs。
  previewRequest = service.getStartPlanPreview();
  try {
    const preview = await previewRequest;
    // 成功结果连同过期时间一起缓存。
    previewCache = {
      preview,
      expiresAt: now + START_PLAN_PREVIEW_CACHE_TTL_MS,
    };
    return preview;
  } finally {
    // 无论成功失败都要清掉在飞引用。
    previewRequest = null;
  }
}
