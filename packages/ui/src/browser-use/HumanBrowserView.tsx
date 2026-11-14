// INV-01 普通标签页持久化显示偏好：守住位置 偏好回调挂载；改错故障 用户调整后刷新即丢失。
// INV-02 Agent 弹窗使用独立默认视口：守住位置 条件分支；改错故障 弹窗继承用户偏好。
// INV-03 初始偏好只计算一次：守住位置 引用缓存；改错故障 设置刷新后覆盖用户调整。
// INV-04 加载完成前不计算偏好：守住位置 加载判断；改错故障 用默认值锁死首帧。
// INV-05 视口拖动写入做合并：守住位置 定时器分支；改错故障 每帧都写一次设置。
// INV-06 非视口来源立即落盘：守住位置 来源判断；改错故障 关闭面板前最后调整丢失。
// INV-07 待写偏好只保留最后一次：守住位置 覆盖赋值；改错故障 连续调整排队写入。
// INV-08 落盘前取走待写值：守住位置 取值后清空；改错故障 同一调整被写两次。
// INV-09 卸载时冲刷待写值：守住位置 清理函数；改错故障 关闭页面后偏好未保存。
// INV-10 写入失败只记日志：守住位置 捕获分支；改错故障 保存异常打断渲染。
// INV-11 偏好深拷贝后再保存：守住位置 克隆函数；改错故障 后续修改污染已存对象。
// INV-12 更新函数走引用持有：守住位置 引用赋值；改错故障 定时器闭包用旧更新器。
// INV-13 加载态返回骨架占位：守住位置 提前返回；改错故障 未就绪时渲染空白。
// INV-14 骨架暴露加载状态属性：守住位置 数据属性；改错故障 自动化无法判断就绪。
// INV-15 偏好就绪后才渲染浏览器：守住位置 空值判断；改错故障 传入空视口崩溃。
// INV-16 其余属性原样透传：守住位置 解构剩余；改错故障 上层配置被组件吞掉。
// INV-17 定时器句柄可空表示无待写：守住位置 空值判断；改错故障 清空不存在的定时器。
// INV-18 组件不改变访客实时视口：守住位置 回调语义；改错故障 合并写入导致画面卡顿。
//
// 模块职责：人类可见的浏览器视图，负责显示偏好的加载与持久化。
// 状态所有权：初始偏好、待写偏好与写入定时器都由组件引用持有。
// 阅读顺序：先看偏好初始化，再看写入合并，最后看渲染分支。
import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import {
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  type EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";

const HUMAN_BROWSER_VIEWPORT_PREFERENCE_WRITE_DELAY_MS = 200;

type HumanBrowserViewProps = Omit<
  ComponentProps<typeof UnifiedBrowserView>,
  "initialHumanViewportPreference" | "onHumanViewportPreferenceChange"
> & { agentOpened?: boolean };

function clonePreference(
  preference: EmbeddedBrowserViewportPreference,
): EmbeddedBrowserViewportPreference {
  return {
    ...preference,
    viewport: { ...preference.viewport },
  };
}

/** Browser 显示边界：普通 human tab 持久化偏好，Agent popup 使用独立默认 viewport。 */
// agentOpened 为真时取 DEFAULT_AGENT_BROWSER_VIEWPORT，否则取持久化偏好。
// initialPreferenceRef 只在 loading 转假后计算一次。
// settings 在 loading 为真时不参与初值计算。
// unifiedProps 的其余属性原样透传给子视图。
export function HumanBrowserView(props: HumanBrowserViewProps): React.JSX.Element {
  const { agentOpened, ...unifiedProps } = props;
  const { loading, settings, update } = useSettings();
  const initialPreferenceRef = useRef<EmbeddedBrowserViewportPreference | null>(null);
  const pendingPreferenceRef = useRef<EmbeddedBrowserViewportPreference | null>(null);
  const writeTimerRef = useRef<number | null>(null);
  const updateRef = useRef(update);
  updateRef.current = update;

  if (!loading && !initialPreferenceRef.current) {
    initialPreferenceRef.current = clonePreference(
      agentOpened
        ? {
            mode: "responsive",
            viewport: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
            zoom: "fit",
          }
        : (settings?.embeddedBrowserViewportPreference ??
            DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE),
    );
  }

  // commitPreference 保存前先经 clonePreference 做深拷贝。
  // update 从 updateRef.current 读取，避免闭包过期。
  // catch 分支只经 logger.warn 记录，不向上抛出。
  const commitPreference = useCallback((preference: EmbeddedBrowserViewportPreference) => {
    void updateRef
      .current({ embeddedBrowserViewportPreference: clonePreference(preference) })
      .catch((error) => {
        logger.warn("[browser] 保存人类浏览器显示偏好失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  // writeTimerRef.current 为 null 时直接返回。
  // clearTimeout 之后把 writeTimerRef.current 置空。
  // clearPendingWrite 幂等，重复调用安全。
  const clearPendingWrite = useCallback(() => {
    if (writeTimerRef.current === null) return;
    window.clearTimeout(writeTimerRef.current);
    writeTimerRef.current = null;
  }, []);

  const handlePreferenceChange = useCallback(
    (
      preference: EmbeddedBrowserViewportPreference,
      source: HumanBrowserViewportPreferenceChangeSource,
    ) => {
      pendingPreferenceRef.current = clonePreference(preference);
      if (source === "viewport") {
        clearPendingWrite();
        // resize handle 每帧都会产生 CSS viewport；只合并 settings IO，不改变 guest 实时更新。
        writeTimerRef.current = window.setTimeout(() => {
          writeTimerRef.current = null;
          const pendingPreference = pendingPreferenceRef.current;
          pendingPreferenceRef.current = null;
          if (pendingPreference) commitPreference(pendingPreference);
        }, HUMAN_BROWSER_VIEWPORT_PREFERENCE_WRITE_DELAY_MS);
        return;
      }

      clearPendingWrite();
      const pendingPreference = pendingPreferenceRef.current;
      pendingPreferenceRef.current = null;
      if (pendingPreference) commitPreference(pendingPreference);
    },
    [clearPendingWrite, commitPreference],
  );

  useEffect(
    () => () => {
      clearPendingWrite();
      const pendingPreference = pendingPreferenceRef.current;
      pendingPreferenceRef.current = null;
      if (pendingPreference) commitPreference(pendingPreference);
    },
    [clearPendingWrite, commitPreference],
  );

  const initialPreference = initialPreferenceRef.current;
  if (!initialPreference) {
    return (
      <div
        aria-busy="true"
        data-browser-human-viewport-preference-state="loading"
        className="h-full min-h-0 w-full min-w-0 bg-background"
      />
    );
  }

  return (
    <UnifiedBrowserView
      {...unifiedProps}
      initialHumanViewportPreference={initialPreference}
      onHumanViewportPreferenceChange={agentOpened ? undefined : handlePreferenceChange}
    />
  );
}
