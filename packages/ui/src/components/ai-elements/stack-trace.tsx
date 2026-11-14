// StackTrace —— ai-elements 错误堆栈展示组件族：把纯文本堆栈解析成结构化帧并渲染可点击路径。
// 做：parseStackTrace 把首行拆成 errorType/errorMessage，把后续 at 行按两种正则解析成帧；
//     StackTrace/Header/Error/ErrorType/ErrorMessage/Actions/CopyButton/ExpandButton/Content/Frames
//     组成可组合的展示骨架，开合状态经 Context 下发给所有子件。
// 不做：不捕获异常、不生成堆栈、不做文件读写、不判断路径该由编辑器还是文件树打开。
// 依赖：Collapsible/Button 来自同仓 ui，图标来自 lucide-react，受控桥接来自 radix。
// 被调用：消息时间线的工具失败块、桌面错误详情；调用方只提供 trace 字符串与可选的点击回调。
// 边界：解析失败降级为原始文本；缺 Provider 直接抛错；不持有任何全局状态。
//
// INV-01 断言：Context 默认值是 null，缺 Provider 必须炸掉 —— 守住它的位置：useStackTrace 的 if (!context) throw —— 改错故障：默认空对象会让放错位置的子件渲染出无意义的空卡片。
// INV-02 断言：受控优先于内部状态 —— 守住它的位置：StackTrace 里 useControllableState 的 prop 参数 —— 改错故障：外部要求展开却在内部被关回，开合按钮来回抖动。
// INV-03 断言：解析是纯函数，只依赖入参 trace —— 守住它的位置：parseStackTrace 全函数 —— 改错故障：同一堆栈在两次渲染中给出不同帧，memo 比对永久失效。
// INV-04 断言：空白输入不抛错，返回空帧并保留原文 —— 守住它的位置：parseStackTrace 的 lines.length === 0 分支 —— 改错故障：只有一行错误消息的历史记录会让卡片直接崩溃。
// INV-05 断言：错误摘要只取首行 —— 守住它的位置：parseStackTrace 对 lines[0] 的读取 —— 改错故障：把 at 帧当成错误消息，卡片标题出现一串路径。
// INV-06 断言：帧只认 at 前缀，其余行一律丢弃 —— 守住它的位置：frames 的 filter 条件 —— 改错故障：运行时附注行被当成帧，行号列号整体错位。
// INV-07 断言：带括号形式必须先于裸位置形式匹配 —— 守住它的位置：parseStackFrame 两个 match 的先后顺序 —— 改错故障：函数名被吞进路径，点击打开错误文件。
// INV-08 断言：无法解析的帧也必须保留原始行 —— 守住它的位置：parseStackFrame 末尾的 fallback return —— 改错故障：不常见的运行时格式在 UI 上凭空消失，用户看不到任何线索。
// INV-09 断言：行列号解析失败必须是 null，不能是 NaN —— 守住它的位置：Number.parseInt 外的三元判断 —— 改错故障：路径后拼出 :NaN，污染调用方的打开参数。
// INV-10 断言：内部帧判定只看路径三类特征 —— 守住它的位置：isInternal 的 node_modules/node:/internal 三段或运算 —— 改错故障：过滤依赖帧时漏掉一类，用户被框架栈淹没。
// INV-11 断言：帧 key 使用原始行文本，必须唯一且稳定 —— 守住它的位置：StackTraceFrames 的 key={frame.raw} —— 改错故障：重复帧复用同一 DOM，展开态与高亮互相串行。
// INV-12 断言：复制超时定时器必须在卸载时清理 —— 守住它的位置：StackTraceCopyButton 的空依赖 useEffect 返回函数 —— 改错故障：卸载后仍执行 setState，控制台告警且句柄滞留。
// INV-13 断言：裁剪后的字符串是唯一解析输入 —— 守住它的位置：parseStackFrame 里 trimmed 的赋值 —— 改错故障：同一次调用混用原始行与裁剪行，得到两套不一致的判断结果。
// INV-14 断言：Context 的引用必须随五项依赖变化 —— 守住它的位置：contextValue 的 useMemo 依赖数组 —— 改错故障：漏项会让子件永远读到旧的开合状态或旧回调。
// INV-15 断言：操作区必须阻断点击冒泡 —— 守住它的位置：handleActionsClick 的 stopPropagation —— 改错故障：点复制会顺带收起内容，用户刚想看的堆栈消失。
// INV-16 断言：操作区只拦 Enter 与空格 —— 守住它的位置：handleActionsKeyDown 的键值判断 —— 改错故障：全键拦截会吃掉列表的方向键导航。
// INV-17 断言：复制失败只上报不改成功态 —— 守住它的位置：copyToClipboard 的 catch 分支 —— 改错故障：写入失败却显示对勾，用户以为已复制。
// INV-18 断言：成功态复位只依赖 timeout 参数 —— 守住它的位置：window.setTimeout 的延迟实参 —— 改错故障：把超时写成常量会让调用方的自定义时长失效。
// INV-19 断言：默认展示全部帧 —— 守住它的位置：showInternalFrames 的默认值 true —— 改错故障：默认过滤会隐藏用户真正关心的业务帧。
// INV-20 断言：路径按钮在无回调时必须禁用 —— 守住它的位置：FilePathButton 的 disabled={!onFilePathClick} —— 改错故障：按钮可点但没有任何反应，用户反复尝试。
//
// 阅读顺序：先看 parseStackFrame 与 parseStackTrace 的解析契约，再看根组件的受控与 Context，
// 最后看 CopyButton 的定时器与 Frames 的 key 选择；解析层与展示层之间只有 ParsedStackTrace。
// 常见误改：交换两个正则的匹配顺序、去掉空行兜底、把帧 key 改成索引、复制后不清定时器。
// 与外部的关系：StackTraceProps 与 onFilePathClick 是对外契约，改签名属于破坏性变更。
// 测试关注点：空 trace、只有错误消息、带函数名与不带函数名两种帧、内部帧过滤开关。
// 样式边界：类名只表达布局与层级色，语义色沿用 DESIGN 的 destructive 与 muted 语义。
// 国际化边界：No stack frames 是英文兜底，正式文案由外层容器注入。
// 性能边界：解析结果按 trace 做 useMemo，Context 引用随五个依赖变化，属于必要成本。
// 维护提示：新增运行时格式只在 parseStackFrame 加分支，不要在渲染层做字符串判断。
// 安全边界：原始堆栈可能含绝对路径，本文件只负责展示，不上报、不落日志。
"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Button } from "../ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Regex patterns for parsing stack traces
// [契约] 四个正则共同定义了什么算一帧，它们是对外可观察的解析口径，不能随意放宽。
// 带括号形式必须优先于裸位置形式，否则函数名会被并入路径，点击会打开错误文件。
// 错误类型只认 XxxError 或 Error 前缀，避免把 at 行误判成错误摘要。
const STACK_FRAME_WITH_PARENS_REGEX = /^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/;
const STACK_FRAME_WITHOUT_FN_REGEX = /^at\s+(.+):(\d+):(\d+)$/;
const ERROR_TYPE_REGEX = /^(\w+Error|Error):\s*(.*)$/;
const AT_PREFIX_REGEX = /^at\s+/;

// [契约] StackFrame 是解析层与渲染层之间的唯一数据形状，字段全部可空是刻意的。
// functionName 与 filePath 允许 null，表示这一行确实解析不出该信息，不是加载中。
// isInternal 在解析期算好并缓存，渲染层不再重复扫描路径字符串。
interface StackFrame {
  raw: string;
  functionName: string | null;
  filePath: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  isInternal: boolean;
}

interface ParsedStackTrace {
  errorType: string | null;
  errorMessage: string;
  frames: StackFrame[];
  raw: string;
}

interface StackTraceContextValue {
  trace: ParsedStackTrace;
  raw: string;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onFilePathClick?: (filePath: string, line?: number, column?: number) => void;
}

// [契约] Context 默认值是 null 而不是空对象，目的是让缺失 Provider 变成显式错误。
// 值里同时携带 parsedTrace 与原始 raw，复制用 raw、展示用 parsedTrace，两者不可互相替代。
// setIsOpen 由根组件持有，子件只调用不持有，保证开合只有一条写入路径。
const StackTraceContext = createContext<StackTraceContextValue | null>(null);

// [契约] 这是唯一的读取入口，任何子件都不要绕过它直接消费私有 context。
// 抛错信息写明用法，是为了让放错位置的组件在首次渲染就暴露，而不是渲染空白。
// [权衡] 抛错而不是返回默认值，代价是一个边界崩溃，收益是永不静默失真。
const useStackTrace = () => {
  const context = useContext(StackTraceContext);
  if (!context) {
    throw new Error("StackTrace components must be used within StackTrace");
  }
  return context;
};

// [契约] 单帧解析只处理一行，不做跨行推断，也不依赖任何外部状态。
// 两种格式按固定顺序尝试，命中即返回，后续分支不再执行。
// 返回对象的字段书写顺序只是风格，不要据此做结构比较或浅比较优化。
// [失败路径] 全部不匹配时走兜底分支，保留原始行，宁可展示原文也不丢信息。
const parseStackFrame = (line: string): StackFrame => {
  // [契约] 先对原始行 trim 再匹配，缩进与尾随空格属于排版噪声；后续判断只看 trimmed，避免同一行两种结论。
  // 后续判断全部基于裁剪后的字符串，不要混用原始行，否则同一行会得出两种结论。
  // [资源] 每次都新建字符串，但堆栈帧数量有限，这里不做额外缓存。
  const trimmed = line.trim();

  // Pattern: at functionName (filePath:line:column)
  // [契约] 带括号形式同时给出函数名与位置，是本文件信息最全的分支。
  // 解构出的四段都可能是空串，因此统一收敛成 null，不把空串当有效值。
  // 内部帧判定只看路径不看函数名，因为函数名在生产构建里可能被压缩混淆。
  const withParensMatch = trimmed.match(STACK_FRAME_WITH_PARENS_REGEX);
  if (withParensMatch) {
    const [, rawFunctionName, rawFilePath, lineNum, colNum] = withParensMatch;
    const functionName = rawFunctionName ?? null;
    const filePath = rawFilePath ?? null;
    const isInternal =
      (filePath?.includes("node_modules") ?? false) ||
      (filePath?.startsWith("node:") ?? false) ||
      (filePath?.includes("internal/") ?? false);
    return {
      columnNumber: colNum ? Number.parseInt(colNum, 10) : null,
      filePath,
      functionName,
      isInternal,
      lineNumber: lineNum ? Number.parseInt(lineNum, 10) : null,
      raw: trimmed,
    };
  }

  // Pattern: at filePath:line:column (no function name)
  // [契约] 裸位置形式没有函数名，functionName 固定为 null，不要伪造空字符串。
  // 该分支与带括号分支共用同样的内部帧判定，避免两条路径的行为漂移。
  // [权衡] 不为它生成占位函数名，是为了让 UI 能区分无函数名与函数名为空。
  const withoutFnMatch = trimmed.match(STACK_FRAME_WITHOUT_FN_REGEX);
  if (withoutFnMatch) {
    const [, rawFilePath, lineNum, colNum] = withoutFnMatch;
    const filePath = rawFilePath ?? null;
    const isInternal =
      (filePath?.includes("node_modules") ?? false) ||
      (filePath?.startsWith("node:") ?? false) ||
      (filePath?.includes("internal/") ?? false);
    return {
      columnNumber: colNum ? Number.parseInt(colNum, 10) : null,
      filePath,
      functionName: null,
      isInternal,
      lineNumber: lineNum ? Number.parseInt(lineNum, 10) : null,
      raw: trimmed,
    };
  }

  // Fallback: unparseable line
  return {
    columnNumber: null,
    filePath: null,
    functionName: null,
    isInternal: trimmed.includes("node_modules") || trimmed.includes("node:"),
    lineNumber: null,
    raw: trimmed,
  };
};

// [契约] 整段解析是纯函数：相同输入必得相同输出，便于 memo 与单测。
// parseStackTrace 不抛错：任何异常输入都收敛成空列表或原文，调用方因此不必再包 try/catch。
// [边界] 只有首行参与错误类型与消息提取，其余行只可能是帧或被丢弃。
const parseStackTrace = (trace: string): ParsedStackTrace => {
  // [契约] 先按换行切分再过滤空行，空行不参与首行判定。
  // 过滤条件是裁剪后的真值判断，纯空白行同样被剔除，避免首行是空白导致摘要为空。
  // [边界] 这里不裁剪每行内部空白，单帧解析会自己再做一次裁剪。
  const lines = trace.split("\n").filter((line) => line.trim());

  if (lines.length === 0) {
    return {
      errorMessage: trace,
      errorType: null,
      frames: [],
      raw: trace,
    };
  }

  // Bugfix: lines[0] 在 noUncheckedIndexedAccess 下不会因为 length 判断自动收窄，
  // 这里显式兜底，避免空栈字符串在解析首行时继续报可能为 undefined。
  // [契约] 显式兜底空串，是因为类型收窄不会跟随 length 判断自动生效。
  // 首行既是错误类型来源，也是消息默认值：不匹配冒号格式时整行就是消息。
  // [失败路径] 首行缺失时消息回落到原始文本，保证卡片不会没有标题。
  const firstLine = (lines[0] ?? "").trim();
  let errorType: string | null = null;
  let errorMessage = firstLine;

  // Try to extract error type from "ErrorType: message" format
  const errorMatch = firstLine.match(ERROR_TYPE_REGEX);
  if (errorMatch) {
    const [, type, msg] = errorMatch;
    errorType = type ?? null;
    errorMessage = msg ?? "";
  }

  // Parse stack frames (lines starting with "at")
  // [契约] 只保留以 at 开头的行，其余行（例如 Caused by 附注）不进入帧列表。
  // 跳过首行保证错误摘要不会被当成帧，即使它以 at 开头也仍然属于摘要。
  // 逐行独立解析，不允许把上一帧的上下文带进下一帧，否则行号会互相污染。
  // [权衡] 丢弃非 at 行会让部分运行时的附加信息不可见，但换来帧列表行号稳定。
  const frames = lines
    .slice(1)
    .filter((line) => line.trim().startsWith("at "))
    .map(parseStackFrame);

  return {
    errorMessage,
    errorType,
    frames,
    raw: trace,
  };
};

// [契约] trace 是必填字符串，组件不负责 JSON 序列化，也不接受 Error 对象。
// open/defaultOpen/onOpenChange 三件套遵循受控与非受控二选一的通用约定。
// onFilePathClick 可选：不传时路径按钮禁用，而不是退化成普通文本。
export type StackTraceProps = ComponentProps<"div"> & {
  trace: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onFilePathClick?: (filePath: string, line?: number, column?: number) => void;
};

export const StackTrace = memo(
  ({
    trace,
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    onFilePathClick,
    children,
    ...props
  }: StackTraceProps) => {
    // [契约] 开合状态交给 useControllableState，受控与非受控走同一套分支。
    // defaultOpen 只在首次挂载读取，运行期修改它不会改变当前开合。
    // [并发] 受控时内部写入仍会触发 onChange，但显示值始终以 prop 为准。
    const [isOpen, setIsOpen] = useControllableState({
      defaultProp: defaultOpen,
      onChange: onOpenChange,
      prop: open,
    });

    // [契约] 解析结果按 trace 缓存，引用不变就不重复解析。
    // [资源] 堆栈可能很长，而渲染频率由流式更新驱动，这里必须缓存。
    // [权衡] 依赖只放 trace，不放入任何渲染期变量，否则缓存形同虚设。
    const parsedTrace = useMemo(() => parseStackTrace(trace), [trace]);

    // [契约] Context 值必须 memo，否则每次渲染都会让全部子件重渲染。
    // 依赖数组包含 parsedTrace、trace、isOpen、setIsOpen 与点击回调，漏一项都会读到旧值。
    // isOpen 变化必须产生新引用，因为展开图标与内容显隐都依赖它。
    const contextValue = useMemo(
      () => ({
        isOpen,
        onFilePathClick,
        raw: trace,
        setIsOpen,
        trace: parsedTrace,
      }),
      [parsedTrace, trace, isOpen, setIsOpen, onFilePathClick]
    );

    return (
      <StackTraceContext.Provider value={contextValue}>
        <div
          className={cn(
            "not-prose w-full overflow-hidden rounded-lg border bg-background font-mono text-ui-base",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </StackTraceContext.Provider>
    );
  }
);

// [契约] 头部属性继承 CollapsibleTrigger，透传属性优先于内部默认值。
// className 与 children 被显式取出，其余属性整体展开，避免覆盖关键回调。
// [边界] 本组件不读堆栈内容，只读开合，因此不会因 trace 变化而重渲染。
export type StackTraceHeaderProps = ComponentProps<typeof CollapsibleTrigger>;

export const StackTraceHeader = memo(
  ({ className, children, ...props }: StackTraceHeaderProps) => {
    // [契约] 头部只负责把自身开合变化转给根状态，不持有第二份状态。
    // Collapsible 的开合回调直接接 setter，中间不加防抖或条件判断。
    // [边界] 触发器语义由 Radix 提供，内层 div 只承载样式。
    const { isOpen, setIsOpen } = useStackTrace();

    return (
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <CollapsibleTrigger asChild {...props}>
          <div
            className={cn(
              "flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-muted/50",
              className
            )}
          >
            {children}
          </div>
        </CollapsibleTrigger>
      </Collapsible>
    );
  }
);

export type StackTraceErrorProps = ComponentProps<"div">;

export const StackTraceError = memo(
  ({ className, children, ...props }: StackTraceErrorProps) => (
    <div
      className={cn(
        "flex flex-1 items-center gap-2 overflow-hidden",
        className
      )}
      {...props}
    >
      <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
      {children}
    </div>
  )
);

export type StackTraceErrorTypeProps = ComponentProps<"span">;

export const StackTraceErrorType = memo(
  ({ className, children, ...props }: StackTraceErrorTypeProps) => {
    // [契约] 错误类型优先使用 children，没有才回落到解析结果。
    // 回落值可能为 null，此时 span 为空而不是显示 null 字样。
    // [边界] 这里只展示类型，不拼接消息，两者分开是为了分别控制样式。
    const { trace } = useStackTrace();

    return (
      <span
        className={cn("shrink-0 font-semibold text-destructive", className)}
        {...props}
      >
        {children ?? trace.errorType}
      </span>
    );
  }
);

export type StackTraceErrorMessageProps = ComponentProps<"span">;

export const StackTraceErrorMessage = memo(
  ({ className, children, ...props }: StackTraceErrorMessageProps) => {
    const { trace } = useStackTrace();

    return (
      <span className={cn("truncate text-foreground", className)} {...props}>
        {children ?? trace.errorMessage}
      </span>
    );
  }
);

// [契约] 操作区是纯容器：分组语义交给 role，间距与对齐交给类名。
// 它不监听子按钮的加载态，也不统一管理禁用，状态由具体按钮自负。
// [权衡] 保持无状态，才能被复制、重试等不同组合复用。
export type StackTraceActionsProps = ComponentProps<"div">;

// [契约] 操作区吞掉 click 冒泡，避免点复制按钮时顺带触发展开或收起。
// 键盘只拦 Enter 与空格，其余按键继续冒泡，保留外层的键盘导航。
// [权衡] 处理器放在模块级常量，避免每次渲染新建函数导致 memo 失效。
const handleActionsClick = (e: React.MouseEvent) => e.stopPropagation();
const handleActionsKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.stopPropagation();
  }
};

export const StackTraceActions = memo(
  ({ className, children, ...props }: StackTraceActionsProps) => (
    <div
      className={cn("flex shrink-0 items-center gap-1", className)}
      onClick={handleActionsClick}
      onKeyDown={handleActionsKeyDown}
      role="group"
      {...props}
    >
      {children}
    </div>
  )
);

export type StackTraceCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const StackTraceCopyButton = memo(
  ({
    onCopy,
    onError,
    timeout = 2000,
    className,
    children,
    ...props
  }: StackTraceCopyButtonProps) => {
    // [契约] 复制成功态是本地瞬时状态，不进入 Context，避免整棵树重渲染。
    // 初值 false，成功后置真并在超时后复位，超时时长由属性决定。
    // [失败路径] 失败不改成功态，只把错误交给回调，图标保持在复制态。
    const [isCopied, setIsCopied] = useState(false);
    // [契约] 定时器句柄放在 ref 里而不是 state，避免每次复位都触发渲染。
    // [资源] timeoutRef 初值保持 0，清理时直接 clearTimeout(0)，不会因为句柄为空而多一次判空。
    const timeoutRef = useRef<number>(0);
    const { raw } = useStackTrace();

    // [契约] 先探测剪贴板能力，再发起写入；探测失败走错误回调而不是静默。
    // 写入是异步的，await 之后才置成功态，防止乐观 UI 与真实结果不一致。
    // [并发] 连续点击复用同一个定时器句柄，新值覆盖旧值前不会误清理。
    // [失败路径] 捕获到未知错误后交给调用方，本文件不做错误分类。
    const copyToClipboard = useCallback(async () => {
      if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
        onError?.(new Error("Clipboard API not available"));
        return;
      }

      try {
        await navigator.clipboard.writeText(raw);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout
        );
      } catch (error) {
        onError?.(error as Error);
      }
    }, [raw, onCopy, onError, timeout]);

    // [资源] 卸载时清掉复制超时定时器，否则回调会在已卸载组件上写入状态。
    // 依赖数组为空是刻意的：句柄是 ref，不参与闭包比较。
    // [边界] 这里只负责清理，注册发生在每次复制成功之后。
    useEffect(
      () => () => {
        window.clearTimeout(timeoutRef.current);
      },
      []
    );

    // [契约] 图标由成功态直接派生，只在一处判断，避免 JSX 里重复三元。
    // [边界] 调用方传入 children 时不再渲染默认图标，选择权完全交出。
    const Icon = isCopied ? CheckIcon : CopyIcon;

    return (
      <Button
        className={cn("size-7", className)}
        onClick={copyToClipboard}
        size="icon"
        variant="ghost"
        {...props}
      >
        {children ?? <Icon size={14} />}
      </Button>
    );
  }
);

export type StackTraceExpandButtonProps = ComponentProps<"div">;

export const StackTraceExpandButton = memo(
  ({ className, ...props }: StackTraceExpandButtonProps) => {
    const { isOpen } = useStackTrace();

    return (
      <div
        className={cn("flex size-7 items-center justify-center", className)}
        {...props}
      >
        <ChevronDownIcon
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            isOpen ? "rotate-180" : "rotate-0"
          )}
        />
      </div>
    );
  }
);

export type StackTraceContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  maxHeight?: number;
};

export const StackTraceContent = memo(
  ({
    className,
    maxHeight = 400,
    children,
    ...props
  }: StackTraceContentProps) => {
    const { isOpen } = useStackTrace();

    return (
      <Collapsible open={isOpen}>
        <CollapsibleContent
          className={cn(
            "overflow-auto border-t bg-muted/30",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in",
            className
          )}
          style={{ maxHeight }}
          {...props}
        >
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  }
);

// [契约] showInternalFrames 默认真，展示全部帧；关闭时才过滤依赖帧。
// 默认展示全部帧，包括 node_modules 与 node: 内部帧；过滤只在 showInternalFrames 为 false 时生效。
// [权衡] 过滤放在渲染期而不是解析期，frames 与运行时保持一致，切换 showInternalFrames 不必重新解析堆栈。
export type StackTraceFramesProps = ComponentProps<"div"> & {
  showInternalFrames?: boolean;
};

// [契约] 路径按钮只接收单帧与点击回调，不读 Context，便于独立测试。
// 路径、行、列三个参数都允许缺省，回调签名与本组件解耦。
// [边界] 组件不判断文件是否存在，存在性属于调用方的领域知识。
interface FilePathButtonProps {
  frame: StackFrame;
  onFilePathClick?: (
    filePath: string,
    lineNumber?: number,
    columnNumber?: number
  ) => void;
}

const FilePathButton = memo(
  ({ frame, onFilePathClick }: FilePathButtonProps) => {
    // [契约] 只有路径存在才回调，行列号用空值合并成 undefined 而不是 null。
    // 依赖数组包含帧与回调，帧变化必须换新闭包，否则会点开上一帧的文件。
    // [权衡] 不做点击防抖，重复点击由宿主的打开逻辑去重。
    const handleClick = useCallback(() => {
      if (frame.filePath) {
        onFilePathClick?.(
          frame.filePath,
          frame.lineNumber ?? undefined,
          frame.columnNumber ?? undefined
        );
      }
    }, [frame, onFilePathClick]);

    return (
      <button
        className={cn(
          "underline decoration-dotted hover:text-primary",
          onFilePathClick && "cursor-pointer"
        )}
        disabled={!onFilePathClick}
        onClick={handleClick}
        type="button"
      >
        {frame.filePath}
        {frame.lineNumber !== null && `:${frame.lineNumber}`}
        {frame.columnNumber !== null && `:${frame.columnNumber}`}
      </button>
    );
  }
);

// [契约] 手工补显示名，是因为 memo 包裹后组件名在开发者工具里会丢失。
// [边界] 名称必须与导出名一致，改名时两处同步，否则调试时难以定位。
FilePathButton.displayName = "FilePathButton";

// [契约] 这里是唯一把帧列表映射成 DOM 的位置，其他组件不要重复遍历。
// 只取堆栈与点击回调两个字段，不整体消费 Context，减少无关重渲染。
// [边界] 空列表渲染占位文案而不是返回 null，避免容器高度塌陷。
export const StackTraceFrames = memo(
  ({
    className,
    showInternalFrames = true,
    ...props
  }: StackTraceFramesProps) => {
    const { trace, onFilePathClick } = useStackTrace();

    // [契约] 过滤条件是内部帧取反，语义是隐藏依赖帧，不要改成路径关键字判断。
    // 过滤结果每次渲染重建数组，但帧数量有限且组件已 memo，成本可接受。
    // [权衡] 不缓存过滤结果，是为了让开关切换立即生效。
    const framesToShow = showInternalFrames
      ? trace.frames
      : trace.frames.filter((f) => !f.isInternal);

    return (
      <div className={cn("space-y-1 p-3", className)} {...props}>
        {framesToShow.map((frame) => (
          <div
            className={cn(
              "text-ui-base",
              frame.isInternal
                ? "text-muted-foreground/50"
                : "text-foreground/90"
            )}
            key={frame.raw}
          >
            <span className="text-muted-foreground">at </span>
            {frame.functionName && (
              <span className={frame.isInternal ? "" : "text-foreground"}>
                {frame.functionName}{" "}
              </span>
            )}
            {frame.filePath && (
              <>
                <span className="text-muted-foreground">(</span>
                <FilePathButton
                  frame={frame}
                  onFilePathClick={onFilePathClick}
                />
                <span className="text-muted-foreground">)</span>
              </>
            )}
            {!(frame.filePath || frame.functionName) && (
              <span>{frame.raw.replace(AT_PREFIX_REGEX, "")}</span>
            )}
          </div>
        ))}
        {framesToShow.length === 0 && (
          <div className="text-muted-foreground text-ui-base">No stack frames</div>
        )}
      </div>
    );
  }
);

// [契约] 所有导出组件在文件末尾统一挂显示名，顺序与导出顺序一致。
// 缺少任意一行都会让开发者工具显示为匿名组件，排查树结构变慢。
// [边界] 这些赋值是模块副作用，必须在组件定义之后，避免引用未初始化。
StackTrace.displayName = "StackTrace";
StackTraceHeader.displayName = "StackTraceHeader";
StackTraceError.displayName = "StackTraceError";
StackTraceErrorType.displayName = "StackTraceErrorType";
StackTraceErrorMessage.displayName = "StackTraceErrorMessage";
StackTraceActions.displayName = "StackTraceActions";
StackTraceCopyButton.displayName = "StackTraceCopyButton";
StackTraceExpandButton.displayName = "StackTraceExpandButton";
StackTraceContent.displayName = "StackTraceContent";
StackTraceFrames.displayName = "StackTraceFrames";
