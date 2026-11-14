// INV-01 延迟初始化：守住位置 就绪副作用；改错故障：严格模式首次挂载创建并泄漏 WebGL 上下文。
// INV-02 单帧延迟：守住位置 帧回调；改错故障：首帧就初始化，仍走一次丢弃挂载。
// INV-03 取消清理：守住位置 清理函数；改错故障：卸载后仍置就绪。
// INV-04 回调稳定：守住位置 回调引用；改错故障：父层每渲染都重建 Rive 实例。
// INV-05 最新回调：守住位置 引用更新副作用；改错故障：加载回调停留在首次渲染的闭包。
// INV-06 变体校验：守住位置 未知变体分支；改错故障：拼错变体名时静默白屏。
// INV-07 双主题来源：守住位置 类名与系统偏好顺序；改错故障：显式深色被系统浅色覆盖。
// INV-08 观察范围：守住位置 属性过滤；改错故障：任意属性变化都触发主题重算。
// INV-09 媒体监听：守住位置 深浅色查询；改错故障：系统切换主题后动画颜色不更新。
// INV-10 清理订阅：守住位置 观察者与监听退订；改错故障：卸载后回调仍写状态。
// INV-11 动态色开关：守住位置 模型分支判断；改错故障：不支持动态色的变体仍被设置颜色。
// INV-12 颜色值：守住位置 深色白浅色黑；改错故障：动画在深色背景上不可见。
// INV-13 状态输入：守住位置 四个布尔输入赋值；改错故障：状态切换后动画不响应。
// INV-14 输入更新：守住位置 依赖数组；改错故障：状态变化后输入不刷新。
// INV-15 模型降级：守住位置 无模型分支；改错故障：无模型变体仍调用模型钩子。
// INV-16 默认变体：守住位置 参数默认值；改错故障：未指定变体时动画缺失。
// INV-17 尺寸与类名：守住位置 容器类名；改错故障：调用方尺寸被固定值覆盖。
// INV-18 第三方来源：守住位置 文件头版权说明；改错故障：许可与出处丢失。
//
// 模块职责：封装 Rive 驱动的角色动画，按状态切换状态机输入并跟随主题着色。
// 状态所有权：就绪与主题归组件；Rive 实例、模型与状态机输入由库钩子持有。
// 阅读顺序：文件头 → 严格模式延迟 → 属性与资源表 → 主题 → 模型分支 → 主组件。
/*
 * Derived from vercel/ai-elements (packages/elements/src/persona.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { cn } from "../lib/utils.js";
import type { RiveParameters } from "@rive-app/react-webgl2";
import {
  useRive,
  useStateMachineInput,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceColor,
} from "@rive-app/react-webgl2";
import type { FC, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

// Delays Rive initialization by one frame so that React Strict Mode's
// immediate unmount cycle never creates a WebGL2 context. Only the
// second (real) mount will initialise, avoiding context exhaustion.
// 严格模式安全初始化：就绪状态默认关闭，等下一帧才打开。
// React 严格模式会立刻卸载再重挂，首帧创建 WebGL 上下文会被丢弃并泄漏。
// 延迟一帧后只有真实挂载会创建上下文。
// 卸载时取消帧回调并复位就绪，避免卸载后仍持有实例。
//
const useStrictModeSafeInit = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => {
      cancelAnimationFrame(id);
      setReady(false);
    };
  }, []);

  return ready;
};

// 角色状态：空闲、聆听、思考、说话与睡眠，对应状态机的四个布尔输入。
// idle 态由 state 的四个布尔输入全为假表示。
//
export type PersonaState = "idle" | "listening" | "thinking" | "speaking" | "asleep";

// 属性：状态、变体与一组生命周期回调，回调原样透传给 Rive。
// variant 决定 sources 取项，缺省变体为 obsidian。
//
interface PersonaProps {
  state: PersonaState;
  onLoad?: RiveParameters["onLoad"];
  onLoadError?: RiveParameters["onLoadError"];
  onReady?: () => void;
  onPause?: RiveParameters["onPause"];
  onPlay?: RiveParameters["onPlay"];
  onStop?: RiveParameters["onStop"];
  className?: string;
  variant?: keyof typeof sources;
}

// The state machine name is always 'default' for Elements AI visuals
const stateMachine = "default";

// sources 表：每个 variant 声明 source 地址，并带 hasModel 与 dynamicColor 两个开关。
// 无模型的变体不启用模型钩子，支持动态色的变体才跟随主题改色。
// 地址是远程资源，加载失败由调用方的错误回调处理。
//
const sources = {
  command: {
    dynamicColor: true,
    hasModel: true,
    source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/command-2.0.riv",
  },
  glint: {
    dynamicColor: true,
    hasModel: true,
    source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/glint-2.0.riv",
  },
  halo: {
    dynamicColor: true,
    hasModel: true,
    source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv",
  },
  mana: {
    dynamicColor: false,
    hasModel: true,
    source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/mana-2.0.riv",
  },
  obsidian: {
    dynamicColor: true,
    hasModel: true,
    source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/obsidian-2.0.riv",
  },
  opal: {
    dynamicColor: false,
    hasModel: false,
    source: "https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/orb-1.2.riv",
  },
};

// getCurrentTheme：先看 documentElement 的 dark 类名，再看 prefers-color-scheme，都没有时返回 light。
// 类名判断优先，保证应用内手动切换能覆盖系统设置。
//
const getCurrentTheme = (): "light" | "dark" => {
  if (typeof window !== "undefined") {
    if (document.documentElement.classList.contains("dark")) {
      return "dark";
    }
    if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
  }
  return "light";
};

// useTheme 订阅：仅在 source.dynamicColor 为真时挂 MutationObserver 与 matchMedia 监听。
// 根元素只观察 class 属性，系统侧只监听 prefers-color-scheme 变化。
//
const useTheme = (enabled: boolean) => {
  const [theme, setTheme] = useState<"light" | "dark">(getCurrentTheme);

  useEffect(() => {
    // Skip if not enabled (avoids unnecessary observers for non-dynamic-color variants)
    if (!enabled) {
      return;
    }

    // Watch for classList changes
    const observer = new MutationObserver(() => {
      setTheme(getCurrentTheme());
    });

    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });

    // Watch for OS-level theme changes
    let mql: MediaQueryList | null = null;
    const handleMediaChange = () => {
      setTheme(getCurrentTheme());
    };

    if (window.matchMedia) {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", handleMediaChange);
    }

    return () => {
      observer.disconnect();
      if (mql) {
        mql.removeEventListener("change", handleMediaChange);
      }
    };
  }, [enabled]);

  return theme;
};

interface PersonaWithModelProps {
  rive: ReturnType<typeof useRive>["rive"];
  source: (typeof sources)[keyof typeof sources];
  children: React.ReactNode;
}

// 有模型分支：useViewModelInstance 创建默认实例并取颜色通道，跟随 theme 写入黑白。
// theme 变化时重新写入颜色，dark 用白、light 用黑。
// dynamicColor 为假的 variant 直接跳过写入。
//
const PersonaWithModel = memo(({ rive, source, children }: PersonaWithModelProps) => {
  const theme = useTheme(source.dynamicColor);
  const viewModel = useViewModel(rive, { useDefault: true });
  const viewModelInstance = useViewModelInstance(viewModel, {
    rive,
    useDefault: true,
  });
  const viewModelInstanceColor = useViewModelInstanceColor("color", viewModelInstance);

  useEffect(() => {
    if (!(viewModelInstanceColor && source.dynamicColor)) {
      return;
    }

    const [r, g, b] = theme === "dark" ? [255, 255, 255] : [0, 0, 0];
    viewModelInstanceColor.setRgb(r, g, b);
  }, [viewModelInstanceColor, theme, source.dynamicColor]);

  return children;
});

PersonaWithModel.displayName = "PersonaWithModel";

interface PersonaWithoutModelProps {
  children: ReactNode;
}

const PersonaWithoutModel = memo(({ children }: PersonaWithoutModelProps) => children);

PersonaWithoutModel.displayName = "PersonaWithoutModel";

// 主组件：校验变体、稳定回调、延迟初始化，再把状态写进状态机输入。
// 回调放进引用里，传给 Rive 的是只读引用的稳定函数。
//
export const Persona: FC<PersonaProps> = memo(
  ({
    variant = "obsidian",
    state = "idle",
    onLoad,
    onLoadError,
    onReady,
    onPause,
    onPlay,
    onStop,
    className,
  }) => {
    const source = sources[variant];

    if (!source) {
      throw new Error(`Invalid variant: ${variant}`);
    }

    // Stabilize callbacks to prevent useRive from reinitializing
    const callbacksRef = useRef({
      onLoad,
      onLoadError,
      onPause,
      onPlay,
      onReady,
      onStop,
    });

    useEffect(() => {
      callbacksRef.current = {
        onLoad,
        onLoadError,
        onPause,
        onPlay,
        onReady,
        onStop,
      };
    }, [onLoad, onLoadError, onPause, onPlay, onReady, onStop]);

    const stableCallbacks = useMemo(
      () => ({
        onLoad: ((loadedRive) =>
          callbacksRef.current.onLoad?.(loadedRive)) as RiveParameters["onLoad"],
        onLoadError: ((err) =>
          callbacksRef.current.onLoadError?.(err)) as RiveParameters["onLoadError"],
        onPause: ((event) => callbacksRef.current.onPause?.(event)) as RiveParameters["onPause"],
        onPlay: ((event) => callbacksRef.current.onPlay?.(event)) as RiveParameters["onPlay"],
        onReady: () => callbacksRef.current.onReady?.(),
        onStop: ((event) => callbacksRef.current.onStop?.(event)) as RiveParameters["onStop"],
      }),
      [],
    );

    // Delay initialisation by one frame to avoid creating (and leaking)
    // a WebGL2 context during React Strict Mode's first throw-away mount.
    // 就绪开关决定是否向 Rive 传配置，未就绪时传空值即不初始化。
    // 初始化完成后不再回到未就绪态。
    //
    const ready = useStrictModeSafeInit();

    const { rive, RiveComponent } = useRive(
      ready
        ? {
            autoplay: true,
            onLoad: stableCallbacks.onLoad,
            onLoadError: stableCallbacks.onLoadError,
            onPause: stableCallbacks.onPause,
            onPlay: stableCallbacks.onPlay,
            onRiveReady: stableCallbacks.onReady,
            onStop: stableCallbacks.onStop,
            src: source.source,
            stateMachines: stateMachine,
          }
        : null,
    );

    const listeningInput = useStateMachineInput(rive, stateMachine, "listening");
    const thinkingInput = useStateMachineInput(rive, stateMachine, "thinking");
    const speakingInput = useStateMachineInput(rive, stateMachine, "speaking");
    const asleepInput = useStateMachineInput(rive, stateMachine, "asleep");

    // Rive state machine inputs are mutable objects that must be set via direct
    // property assignment — this is the intended Rive API, not a React anti-pattern.
    useEffect(() => {
      if (listeningInput) {
        listeningInput.value = state === "listening";
      }
      if (thinkingInput) {
        thinkingInput.value = state === "thinking";
      }
      if (speakingInput) {
        speakingInput.value = state === "speaking";
      }
      if (asleepInput) {
        asleepInput.value = state === "asleep";
      }
    }, [state, listeningInput, thinkingInput, speakingInput, asleepInput]);

    const Component = source.hasModel ? PersonaWithModel : PersonaWithoutModel;

    return (
      <Component rive={rive} source={source}>
        <RiveComponent className={cn("size-16 shrink-0", className)} />
      </Component>
    );
  },
);

Persona.displayName = "Persona";
