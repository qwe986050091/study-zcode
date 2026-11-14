// INV-01 代码只由 Provider 注入：守住位置 SnippetContext；改错故障 子组件各存一份而不同步。
// INV-02 默认上下文为空串：守住位置 createContext 初值；改错故障 脱离 Provider 时渲染 undefined。
// INV-03 value 用 useMemo：守住位置 contextValue；改错故障 每次渲染刷新全部消费者。
// INV-04 输入框只读：守住位置 readOnly；改错故障 用户可改动展示用的代码。
// INV-05 外部不能覆盖 value：守住位置 类型上 Omit value；改错故障 传入值与上下文不一致。
// INV-06 复制前判能力：守住位置 clipboard 探测；改错故障 非安全上下文下未捕获异常。
// INV-07 复制中不重复写：守住位置 !isCopied 判断；改错故障 连点产生多次回调。
// INV-08 超时后回退图标：守住位置 setTimeout 复位；改错故障 勾选态永久停留。
// INV-09 定时器卸载清理：守住位置 useEffect 的 cleanup；改错故障 卸载后 setState 告警。
// INV-10 错误交给调用方：守住位置 onError?.()；改错故障 失败被静默吞掉无法归因。
// INV-11 图标随状态切换：守住位置 isCopied 三元；改错故障 复制成功没有视觉反馈。
// INV-12 默认超时可覆盖：守住位置 timeout = 2000；改错故障 无法按场景调整提示时长。
// INV-13 可访问性固定：守住位置 aria-label 与 title；改错故障 纯图标按钮无朗读文本。
// INV-14 子节点优先于图标：守住位置 children ?? Icon；改错故障 自定义内容被图标覆盖。
//
// 模块职责：只读代码片段展示与一键复制按钮。
// 阅读顺序：先看上下文与外壳，再看输入的只读绑定，最后看复制按钮的状态机。
/*
 * Derived from vercel/ai-elements (packages/elements/src/snippet.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "../ui/input-group.js";
import { cn } from "../lib/utils.js";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface SnippetContextType {
  code: string;
}

// 上下文只暴露代码串，避免各组件分别取数。
const SnippetContext = createContext<SnippetContextType>({
  code: "",
});

export type SnippetProps = ComponentProps<typeof InputGroup> & {
  code: string;
};

// 外壳同时提供上下文与等宽排版。
export const Snippet = ({ code, className, children, ...props }: SnippetProps) => {
  // 对象身份随代码变化，消费者才不会空转。
  const contextValue = useMemo(() => ({ code }), [code]);

  return (
    <SnippetContext.Provider value={contextValue}>
      <InputGroup className={cn("font-mono", className)} {...props}>
        {children}
      </InputGroup>
    </SnippetContext.Provider>
  );
};

export type SnippetAddonProps = ComponentProps<typeof InputGroupAddon>;

export const SnippetAddon = (props: SnippetAddonProps) => <InputGroupAddon {...props} />;

export type SnippetTextProps = ComponentProps<typeof InputGroupText>;

export const SnippetText = ({ className, ...props }: SnippetTextProps) => (
  <InputGroupText className={cn("pl-2 font-normal text-muted-foreground", className)} {...props} />
);

export type SnippetInputProps = Omit<ComponentProps<typeof InputGroupInput>, "readOnly" | "value">;

// 输入框从上下文取值，外部无法传值覆盖。
export const SnippetInput = ({ className, ...props }: SnippetInputProps) => {
  const { code } = useContext(SnippetContext);

  return (
    <InputGroupInput
      className={cn("text-foreground", className)}
      readOnly
      value={code}
      {...props}
    />
  );
};

export type SnippetCopyButtonProps = ComponentProps<typeof InputGroupButton> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

// 复制按钮自带状态机与超时复位。
export const SnippetCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: SnippetCopyButtonProps) => {
  // 勾选态只用于图标与防重入。
  const [isCopied, setIsCopied] = useState(false);
  // 定时器句柄存 ref，避免每次渲染重建。
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(SnippetContext);

  // 复制逻辑收敛到一个回调，便于声明依赖。
  const copyToClipboard = useCallback(async () => {
    // 能力缺失走 onError，而不是抛未捕获异常。
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        // `writeText` 成功后先置 `isCopied` 反馈，再启动复位定时器。
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        // 新句柄覆盖旧句柄，卸载时只需清一个。
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  // 卸载清定时器，防止卸载后 setState。
  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  // 图标跟随状态切换，无需额外分支渲染。
  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <InputGroupButton
      aria-label="Copy"
      className={className}
      onClick={copyToClipboard}
      size="icon-sm"
      title="Copy"
      {...props}
    >
      {children ?? <Icon className="size-3.5" size={14} />}
    </InputGroupButton>
  );
};
