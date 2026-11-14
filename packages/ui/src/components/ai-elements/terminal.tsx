// INV-01 守住位置：TerminalContext 的默认值必须先于任何消费者定义；改错故障：默认对象缺字段会让 Provider 之外的读取拿到 undefined，滚动或流式分支静默走错。
// INV-02 守住位置：子组件一律从上下文取值，不额外接收 output 或 isStreaming 属性；改错故障：允许属性透传后，自定义 children 组合会绕过 Provider 读到另一份过期文本。
// INV-03 守住位置：TerminalStatus 与 TerminalClearButton 的提前返回必须排在各自的 useContext 之后；改错故障：把返回提前到 hook 之前会打乱 hooks 调用顺序，切换 isStreaming 时渲染中断。
// INV-04 守住位置：复制回执的计时器句柄必须存进 ref；改错故障：换成普通局部变量后每次渲染都会新建计时器，卸载清理摸不到旧句柄，迟到的 setState 落在已卸载组件上。
// INV-05 守住位置：清理 effect 的依赖数组必须保持为空；改错故障：把 timeout 写进依赖会在超时变更时重建清理函数，反而漏掉对上一轮计时器的清除。
// INV-06 守住位置：写剪贴板前先确认 window 与 navigator.clipboard.writeText 都存在；改错故障：删掉守卫后服务端首帧没有 window，点击直接抛 ReferenceError 且 onError 收不到。
// INV-07 守住位置：写入成功后先置回执再回调 onCopy；改错故障：顺序颠倒时消费者在 onCopy 里重挂载面板，会看到按钮仍停留在复制图标。
// INV-08 守住位置：失败路径只把错误交给 onError，不置任何成功态；改错故障：catch 里顺手置成功会让界面谎报复制完成，用户粘贴出旧内容。
// INV-09 守住位置：复制回调的依赖必须覆盖 output 与三个回调参数；改错故障：漏掉 output 后闭包锁住首帧文本，流式追加后再点复制得到的仍是旧快照。
// INV-10 守住位置：自动滚动 effect 的依赖键同时包含 output 与 autoScroll；改错故障：只留 autoScroll 时新输出不滚动，只留 output 时关闭开关后仍被拽回底部。
// INV-11 守住位置：scrollTop 的赋值只能发生在 effect 内；改错故障：渲染期直接写 DOM，首帧容器 ref 尚为 null，提交阶段抛错并拖垮整个面板。
// INV-12 守住位置：滚动容器 ref 只在 TerminalContent 内部创建与持有；改错故障：把 ref 提到 Terminal 层，自定义 children 会与默认内容争用同一节点，滚动目标错位。
// INV-13 守住位置：Ansi 的收窄只发生在编译期，运行时仍是 RawAnsi 本身；改错故障：换成真正的包装组件会截断 linkify 与 useClasses 的透传语义，链接与配色一起失效。
// INV-14 守住位置：ANSI 转义统一交给 ansi-to-react，不另写颜色映射；改错故障：自研映射覆盖不了 38;5;n 这类 256 色序列，输出会出现错色或残留控制字符。
// INV-15 守住位置：流式光标仅在 isStreaming 为真时渲染，且与正文同处一个 pre；改错故障：把光标挪出 pre 会破坏等宽换行对齐，追加内容时整段跳动。
// INV-16 守住位置：只有 children 为空才走默认组合，即 Header 加 Content；改错故障：无条件渲染默认结构会让自定义组合出现两套标题与两组按钮。
// INV-17 守住位置：上下文值由 useMemo 生成，依赖四项输入；改错故障：改成内联对象字面量后父组件每次渲染都换引用，所有消费者跟着重渲染。
// INV-18 守住位置：onClear 是可选项，缺失时清空按钮整体不渲染；改错故障：把它兜底成空函数会让按钮常驻却毫无反应，用户误以为终端已被清屏。
//
// 模块职责：把可能仍在流式追加的终端输出渲染成可滚动、可复制、可清空的黑底面板，并托管 ANSI 解析。
// 状态所有权：output、isStreaming、autoScroll、onClear 由调用方持有并经上下文单向下发，本地状态只有复制回执与计时器句柄。
// 阅读顺序：先看 Provider 与默认上下文，再看状态与操作按钮的守卫，最后看内容区的滚动同步与默认组合。
/*
 * Derived from vercel/ai-elements (packages/elements/src/terminal.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// 本文件所有内部相对导入都写 .js 后缀，因为包以 NodeNext 解析到编译产物。
// 按钮与样式取自同级 ui、lib 目录，不引入 ai-elements 之外的新依赖，避免循环引用。
// 图标库按名导入四个具体图标而非整体导入，保证 tree-shaking 生效。
// 类型导入单独走 import type，运行时被完全擦除，不产生额外求值。
// 此处模块求值无 DOM 访问，只完成图标常量绑定，可在服务端渲染阶段安全加载。
import { Button } from "../ui/button.js";
import { cn } from "../lib/utils.js";
import RawAnsi from "ansi-to-react";
import { CheckIcon, CopyIcon, TerminalIcon, Trash2Icon } from "lucide-react";
import type { ComponentProps, ComponentType, HTMLAttributes } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type AnsiProps = {
  children?: string;
  className?: string;
  linkify?: boolean | "fuzzy";
  useClasses?: boolean;
};

// ansi-to-react 在当前 NodeNext 配置下也会被推成模块对象类型，
// 直接写成 <Ansi /> 会误报 JSX 组件不可调用。这里仅把第三方默认导出收窄成组件类型，
// 不改变运行时加载方式。
// ansi-to-react 在 NodeNext 下被推断为模块命名空间，直接当 JSX 用会报不可调用。
// 因此这里只做类型断言：不包装、不改 props、不接管解析逻辑。
// AnsiProps 只声明本文件实际依赖的四个字段，其余字段由运行时原样透传。
// 若改成真正的包装组件，链接化与样式类开关会在此处被静默丢弃。
const Ansi = RawAnsi as unknown as ComponentType<AnsiProps>;

interface TerminalContextType {
  output: string;
  isStreaming: boolean;
  autoScroll: boolean;
  onClear?: () => void;
}

// 默认值是一份无 Provider 也能渲染的冻结语义：output 为空、未在流式、自动滚动开启。
// 默认对象刻意不给 onClear，于是脱离 Provider 时清空按钮整体缺席，而不是退化成空操作。
// 该默认值是所有 useContext 的解构兜底，字段顺序无关，但字段集合必须与上层类型一致。
// 新增上下文字段时三处要同步：类型定义、这里的默认值、Terminal 里 useMemo 的返回值。
// 漏改任一处都会让消费者读到 undefined，并在解构或条件判断处静默降级而非报错。
const TerminalContext = createContext<TerminalContextType>({
  autoScroll: true,
  isStreaming: false,
  output: "",
});

export type TerminalHeaderProps = HTMLAttributes<HTMLDivElement>;

export const TerminalHeader = ({ className, children, ...props }: TerminalHeaderProps) => (
  <div
    className={cn(
      "flex items-center justify-between border-zinc-800 border-b px-4 py-2",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TerminalTitleProps = HTMLAttributes<HTMLDivElement>;

export const TerminalTitle = ({ className, children, ...props }: TerminalTitleProps) => (
  <div className={cn("flex items-center gap-2 text-ui-base text-zinc-400", className)} {...props}>
    <TerminalIcon className="size-4" />
    {children ?? "Terminal"}
  </div>
);

export type TerminalStatusProps = HTMLAttributes<HTMLDivElement>;

export const TerminalStatus = ({ className, children, ...props }: TerminalStatusProps) => {
  const { isStreaming } = useContext(TerminalContext);

  // 是否渲染完全由上下文里的 isStreaming 决定，组件自身不保留开关状态。
  // 这个提前返回位于 useContext 之后，hook 调用顺序与渲染分支无关，切换时安全。
  // 关闭流式时整段状态区消失而非留空占位，标题栏由 flex 布局自动收拢。
  // children 仍会被传入但被丢弃，因此自定义内容不能依赖自身的挂载副作用。
  if (!isStreaming) {
    return null;
  }

  return (
    <div className={cn("flex items-center gap-2 text-ui-base text-zinc-400", className)} {...props}>
      {children}
    </div>
  );
};

export type TerminalActionsProps = HTMLAttributes<HTMLDivElement>;

export const TerminalActions = ({ className, children, ...props }: TerminalActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type TerminalCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const TerminalCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: TerminalCopyButtonProps) => {
  // isCopied 只表达刚刚复制成功的短暂回执，不持久化、不上报、不参与主题切换。
  // 计时器句柄放 ref 而非 state，避免定时器赋值本身触发重渲染。
  // 初值给 0 而不是 undefined，使未复制前的 clearTimeout 调用也安全。
  // 本组件不读 isStreaming，流式追加剧间复制按钮同样可用，副本是点击那一刻的快照。
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { output } = useContext(TerminalContext);

  // 守卫先于异步写入：无 window（服务端首帧）或无剪贴板能力时直接走 onError 返回。
  // 成功路径按置回执、回调、再起计时器的顺序推进，回调里重挂载面板也不会丢计时器。
  // 失败只把错误交给 onError，不设置任何成功态，避免界面谎报复制完成。
  // 依赖数组覆盖 output 与三个回调，漏项会让闭包锁住旧文本或旧回调。
  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(output);
      setIsCopied(true);
      onCopy?.();
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  }, [output, onCopy, onError, timeout]);

  useEffect(
    () => () => {
      // 卸载时清掉未到期的回执计时器，否则定时器会在组件消失后再次 setState。
      // 外围 effect 依赖数组为空，只在卸载时执行，输出或超时变化都不重建这个清理函数。
      // 重挂载时 ref 重新初始化，新旧两套计时器互不干扰。
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn(
        "size-7 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
        className,
      )}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};

export type TerminalClearButtonProps = ComponentProps<typeof Button>;

export const TerminalClearButton = ({
  children,
  className,
  ...props
}: TerminalClearButtonProps) => {
  const { onClear } = useContext(TerminalContext);

  if (!onClear) {
    return null;
  }

  return (
    <Button
      className={cn(
        "size-7 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
        className,
      )}
      onClick={onClear}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Trash2Icon size={14} />}
    </Button>
  );
};

export type TerminalContentProps = HTMLAttributes<HTMLDivElement>;

export const TerminalContent = ({ className, children, ...props }: TerminalContentProps) => {
  const { output, isStreaming, autoScroll } = useContext(TerminalContext);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      // `output` 或 `autoScroll` 变化后把容器 `scrollTop` 推到底部，让最新追加的行可见。
      // 写入点放在 effect 而非渲染期，因为首帧 ref 仍为 null，渲染期写 DOM 会抛错。
      // 关闭 autoScroll 后本分支整体跳过，用户上滚的位置得以保留，不会被新输出拽回。
      // 这里直接改 scrollTop，不走平滑滚动接口，避免高速追加时动画排队积压。
      // isStreaming 不参与依赖：光标闪烁不应单独改变滚动位置。
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [output, autoScroll]);

  return (
    <div
      className={cn("max-h-96 overflow-auto p-4 font-mono text-ui-base leading-relaxed", className)}
      ref={containerRef}
      {...props}
    >
      {children ?? (
        <pre className="whitespace-pre-wrap break-words">
          <Ansi>{output}</Ansi>
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-zinc-100" />
          )}
        </pre>
      )}
    </div>
  );
};

export type TerminalProps = HTMLAttributes<HTMLDivElement> & {
  output: string;
  isStreaming?: boolean;
  autoScroll?: boolean;
  onClear?: () => void;
};

export const Terminal = ({
  output,
  isStreaming = false,
  autoScroll = true,
  onClear,
  className,
  children,
  ...props
}: TerminalProps) => {
  // 上下文值按四项输入缓存，父组件因无关状态重渲染时消费者不会被动失效。
  // 依赖项必须与解构出的字段一一对应，多写造成无谓失效，少写会发出陈旧上下文。
  // onClear 允许为 undefined，是否渲染清空按钮由消费者自行判断，这里不做兜底。
  // 该对象同时决定默认组合分支，Provider 覆盖整个面板，兄弟节点读到同一份快照。
  const contextValue = useMemo(
    () => ({ autoScroll, isStreaming, onClear, output }),
    [autoScroll, isStreaming, onClear, output],
  );

  return (
    <TerminalContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <TerminalHeader>
              <TerminalTitle />
              <div className="flex items-center gap-1">
                <TerminalStatus />
                <TerminalActions>
                  <TerminalCopyButton />
                  {onClear && <TerminalClearButton />}
                </TerminalActions>
              </div>
            </TerminalHeader>
            <TerminalContent />
          </>
        )}
      </div>
    </TerminalContext.Provider>
  );
};
