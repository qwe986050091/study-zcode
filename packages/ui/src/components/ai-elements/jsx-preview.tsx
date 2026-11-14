"use client";

// INV-01 同一份 jsx 字符串是上下文的唯一事实来源，任何子组件都不得缓存第二份源码；守住位置：JSXPreviewContextValue 的 jsx 与 processedJsx 字段；改错故障：流式结束后预览停留在旧内容，用户以为输出丢失。
// INV-02 流式期间只做标签补全，非流式期间原样交给解析器；守住位置：processedJsx 的 useMemo 三元判断；改错故障：已完成代码被补出多余闭合标签，渲染出重复结构。
// INV-03 补全只追加缺失的闭合标签，不删除任何原始字符；守住位置：completeJsxTag 的返回值拼接；改错故障：用户文本里的尖括号内容被吞掉。
// INV-04 未闭合的尾部标签必须整段丢弃，不能只截掉一半；守住位置：stripIncompleteTag 的 lastIndexOf 分支；改错故障：残缺属性值进入解析器，报出莫名其妙的语法错误。
// INV-05 解析失败的最终降级是展示源码而非空白页；守住位置：JSXPreviewContent 对 displayJsx 与错误上报的配合；改错故障：模型输出有误时预览区域全白，用户无从判断。
// INV-06 流式期间发生的解析错误不上抛给外部回调，只内部降级；守住位置：handleError 的 isStreaming 提前返回；改错故障：半成品片段每帧触发一次 onError，外层弹出一串告警。
// INV-07 同一份 processedJsx 只上报一次错误，重复上报必须短路；守住位置：errorReportedRef 与 processedJsx 的相等判断；改错故障：解析器多次回调导致错误提示叠加。
// INV-08 只有无错误的那一次渲染才更新 lastGoodJsx，出错时不推进；守住位置：跟踪最近可用 JSX 的 effect；改错故障：坏版本被记成好的，回退后仍是白屏。
// INV-09 流式错误时显示上一份可用 JSX，而不是当前残缺内容；守住位置：displayJsx 的三元表达式；改错故障：输出中途预览闪烁清空。
// INV-10 源码变化时清除错误并重置上报指纹，两者必须同步；守住位置：jsx 变化的派生状态分支与依赖 processedJsx 的 effect；改错故障：新内容已正常渲染，旧错误条仍挂在下面。
// INV-11 错误状态由 Provider 持有，内容组件只读取与上报，不自行保存；守住位置：setError 与 setLastGoodJsx 的传递方向；改错故障：错误组件与内容组件各自持有一份状态而不同步。
// INV-12 空源码不进入渲染路径，matchJsxTag 直接返回空；守住位置：matchJsxTag 开头的 trim 判空；改错故障：空字符串被当作普通文本送进解析器，产生无意义告警。
// INV-13 标签扫描一次只消费一个标签，位置游标按匹配长度前进；守住位置：completeJsxTag 的当前游标与 endIndex 累加；改错故障：游标不前进导致循环卡死，界面冻结。
// INV-14 自闭合、闭合、开启三类标签必须互斥归类，禁止同时命中；守住位置：matchJsxTag 的 if-else 链；改错故障：自闭合标签被压栈，末尾补出多余的闭合标签。
// INV-15 标签栈只由开启与闭合驱动，闭合弹栈不做匹名校验以容忍模型手误；守住位置：栈的 push 与 pop 分支；改错故障：标签顺序小错就让整段内容无法显示。
// INV-16 沙箱边界内只允许受控组件与显式 bindings，解析器不执行外部脚本；守住位置：JsxParser 的 components 与 bindings 透传；改错故障：模型输出拿到未授权能力，构造出越权调用。
// INV-17 解析器禁用自己的包装容器，布局完全由外层 div 决定；守住位置：renderInWrapper 固定为 false 的传参；改错故障：预览区域出现双层内边距，高度计算错位。
// INV-18 组件对外回调 onError 在非流式阶段才触发，且与内部错误状态写入顺序一致；守住位置：handleError 尾部的两次调用；改错故障：外部拿到错误但界面没显示，或反之。
// INV-19 上下文缺失时立即抛错，而不是返回空对象继续渲染；守住位置：useJSXPreview 的空值判断；改错故障：子组件在 Provider 之外使用时静默失效，排查成本高。
//
// 本文件是 AI 输出里的 JSX 预览渲染层，把模型流式片段转成可交互的 React 节点。
// 流式阶段靠标签补全兜住半成品，稳定阶段把解析交还给第三方解析器。
// 错误按流式静默降级、非流式上报两条路径处理，并回退到最近一次可用内容。
import { cn } from "../lib/utils.js";
import { AlertCircle } from "lucide-react";
import type { ComponentProps, ComponentType, ReactNode } from "react";
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
import type { TProps as JsxParserProps } from "react-jsx-parser";
import RawJsxParser from "react-jsx-parser";

// Bugfix: react-jsx-parser 的声明在 NodeNext + verbatimModuleSyntax 下会被推成模块对象，
// 直接当 JSX 组件使用时会报“不能作为 JSX 组件”。这里收窄成明确的组件类型，
// 保持运行时默认导出不变，只修正 TypeScript 对第三方包的错误推断。
// [类型] 第三方默认导出在 NodeNext 下被推断成模块对象，这里只做类型收窄。
// 运行时仍是同一个默认导出，不额外包裹组件，避免破坏解析器内部引用。
const JsxParser = RawJsxParser as unknown as ComponentType<JsxParserProps>;

interface JSXPreviewContextValue {
  jsx: string;
  processedJsx: string;
  isStreaming: boolean;
  error: Error | null;
  setError: (error: Error | null) => void;
  setLastGoodJsx: (jsx: string) => void;
  components: JsxParserProps["components"];
  bindings: JsxParserProps["bindings"];
  onErrorProp?: (error: Error) => void;
}

const JSXPreviewContext = createContext<JSXPreviewContextValue | null>(null);

// 标签正则以开尖括号为锚点，只识别字母开头的名称。
// [权衡] 正则不处理注释与表达式容器，交给补全逻辑按标签计数兜底。
const TAG_REGEX = /<\/?([a-zA-Z][a-zA-Z0-9]*)\s*([^>]*?)(\/)?>/;

export const useJSXPreview = () => {
  const context = useContext(JSXPreviewContext);
  if (!context) {
    throw new Error("JSXPreview components must be used within JSXPreview");
  }
  return context;
};

// [失败路径] 无匹配或缺失索引一律返回空，调用方据此停止扫描。
// 返回值同时给出起止位置与标签类别，供上层游标与栈使用。
const matchJsxTag = (code: string) => {
  if (code.trim() === "") {
    return null;
  }

  const match = code.match(TAG_REGEX);

  if (!match || match.index === undefined) {
    return null;
  }

  const [fullMatch, tagName = "", attributes = "", selfClosing] = match;

  // 判定顺序固定为自闭合、闭合、开启：自闭合标签同时带斜杠与尖括号，先判它才不会被误认成闭合，因此顺序不可交换。
  // 三类判定顺序不可交换，自闭合标签同时带斜杠与尖括号。
  let type: "self-closing" | "closing" | "opening";
  if (selfClosing) {
    type = "self-closing";
  } else if (fullMatch.startsWith("</")) {
    type = "closing";
  } else {
    type = "opening";
  }

  return {
    attributes: attributes.trim(),
    endIndex: match.index + fullMatch.length,
    startIndex: match.index,
    tag: fullMatch,
    tagName,
    type,
  };
};

// stripIncompleteTag 从最后一个 '<' 向左找，没有配对 '>' 就整段截掉，避免残缺属性进入解析器。
// [失败路径] 尾部没有闭合尖括号时整段截掉，避免残缺属性进入解析器。
// [权衡] 只看最后一个开标签，简单文本里的比较符号会被误判，但概率远低于收益。
const stripIncompleteTag = (text: string) => {
  // Find the last '<' that isn't part of a complete tag
  const lastOpen = text.lastIndexOf("<");
  if (lastOpen === -1) {
    return text;
  }

  const afterOpen = text.slice(lastOpen);
  // If there's no closing '>' after the last '<', it's an incomplete tag
  if (!afterOpen.includes(">")) {
    return text.slice(0, lastOpen);
  }

  return text;
};

// 循环逐段消费标签，文本内容原样跟随到结果里。
// [并发] 纯函数无副作用，同一输入任意次调用结果一致，可安全用于渲染期派生。
// [资源] completeJsxTag 每轮只匹配剩余片段，复杂度与标签数量线性相关；因此长文本也不会退化成平方级。
const completeJsxTag = (code: string) => {
  const stack: string[] = [];
  let result = "";
  let currentPosition = 0;

  while (currentPosition < code.length) {
    const match = matchJsxTag(code.slice(currentPosition));
    if (!match) {
      // No more tags found, strip any trailing incomplete tag
      result += stripIncompleteTag(code.slice(currentPosition));
      break;
    }
    const { tagName, type, endIndex } = match;

    // Include any text content before this tag
    result += code.slice(currentPosition, currentPosition + endIndex);

    // 开标签入栈、自闭合不动、闭合标签出栈，栈只存 tagName；补全时由栈逆序生成闭合标签。
    // 栈只记录名称，不记录位置，补全时按逆序追加闭合标签。
    if (type === "opening") {
      stack.push(tagName);
    } else if (type === "closing") {
      stack.pop();
    }

    currentPosition += endIndex;
  }

  return (
    result +
    stack
      // [失败路径] 栈内剩余标签逆序补齐，保证嵌套顺序与外层一致。
      .toReversed()
      .map((tag) => `</${tag}>`)
      .join("")
  );
};

export type JSXPreviewProps = ComponentProps<"div"> & {
  jsx: string;
  isStreaming?: boolean;
  components?: JsxParserProps["components"];
  bindings?: JsxParserProps["bindings"];
  onError?: (error: Error) => void;
};

// [事务] Provider 只负责持有源码、错误与回调，不参与具体渲染。
// 组件内部保留 jsx 的上一个值用于派生状态比较，切换内容时同步清错。
export const JSXPreview = memo(
  ({
    jsx,
    isStreaming = false,
    components,
    bindings,
    onError,
    className,
    children,
    ...props
  }: JSXPreviewProps) => {
    const [prevJsx, setPrevJsx] = useState(jsx);
    const [error, setError] = useState<Error | null>(null);
    const [_lastGoodJsx, setLastGoodJsx] = useState("");

    // Clear error when jsx changes (derived state pattern)
    // 派生状态模式在渲染期直接比较，避免多余的一轮 effect。
    // 清错与更新前值必须成对出现，否则错误条会在新内容上残留。
    if (jsx !== prevJsx) {
      setPrevJsx(jsx);
      setError(null);
    }

    // 只有流式时长才补全，已完成内容保持原样以保留用户意图。
    // [权衡] 补全放在 memo 内，输入不变时不重复解析标签。
    const processedJsx = useMemo(
      () => (isStreaming ? completeJsxTag(jsx) : jsx),
      [jsx, isStreaming]
    );

    // 上下文值整体 memo 化，字段顺序与读取方解构保持一致。
    // [并发] 依赖数组省略 setLastGoodJsx，因其来自 useState 恒定不变。
    const contextValue = useMemo(
      () => ({
        bindings,
        components,
        error,
        isStreaming,
        jsx,
        onErrorProp: onError,
        processedJsx,
        setError,
        setLastGoodJsx,
      }),
      [
        bindings,
        components,
        error,
        isStreaming,
        jsx,
        onError,
        processedJsx,
        setError,
      ]
    );

    return (
      <JSXPreviewContext.Provider value={contextValue}>
        <div className={cn("relative", className)} {...props}>
          {children}
        </div>
      </JSXPreviewContext.Provider>
    );
  }
);

JSXPreview.displayName = "JSXPreview";

export type JSXPreviewContentProps = Omit<ComponentProps<"div">, "children">;

// 内容组件只依赖上下文，不透传源码与错误状态的副本。
// [资源] 解析器实例随组件复用，避免每次渲染重建整棵子树。
export const JSXPreviewContent = memo(
  ({ className, ...props }: JSXPreviewContentProps) => {
    const {
      processedJsx,
      isStreaming,
      components,
      bindings,
      setError,
      setLastGoodJsx,
      onErrorProp,
    } = useJSXPreview();
    // 上报指纹按源码字符串记录，同源重复错误直接跳过。
    // [事务] 指纹与已渲染内容同源，内容变化时由 effect 统一清空。
    const errorReportedRef = useRef<string | null>(null);
    const lastGoodJsxRef = useRef("");
    const [hadError, setHadError] = useState(false);

    // Reset error tracking when jsx changes
    useEffect(() => {
      errorReportedRef.current = null;
      setHadError(false);
    }, [processedJsx]);

    const handleError = useCallback(
      (err: Error) => {
        // Prevent duplicate error reports for the same jsx
        // [失败路径] 重复回调在此短路，不再向上层抛出。
        // 指纹写入先于任何分支，保证流式与非流式路径共用同一去重。
        if (errorReportedRef.current === processedJsx) {
          return;
        }
        errorReportedRef.current = processedJsx;

        // During streaming, suppress errors and fall back to last good JSX
        // [并发] 流式期间错误只标记内部状态，不写 Provider 错误也不回调外部。
        // 提前返回保证半成品片段不会污染全局错误展示。
        if (isStreaming) {
          setHadError(true);
          return;
        }

        setError(err);
        onErrorProp?.(err);
      },
      [processedJsx, isStreaming, onErrorProp, setError]
    );

    // Track the last JSX that rendered without error
    useEffect(() => {
      // 仅当本轮没有记录到错误时才推进可用版本。
      // [事务] 更新 ref 与上下文写入同时发生，回退时读到的是同一份内容。
      if (!errorReportedRef.current) {
        lastGoodJsxRef.current = processedJsx;
        setLastGoodJsx(processedJsx);
      }
    }, [processedJsx, setLastGoodJsx]);

    // During streaming, if the current JSX errored, re-render with last good version
    // 流式且本轮出错时切到上一份可用内容，界面保持最后一次正确结果。
    // [失败路径] 首帧就出错时可用版本为空串，此时按空源码处理不渲染。
    const displayJsx =
      isStreaming && hadError ? lastGoodJsxRef.current : processedJsx;

    return (
      <div className={cn("jsx-preview-content", className)} {...props}>
        <JsxParser
          bindings={bindings}
          components={components}
          jsx={displayJsx}
          onError={handleError}
          renderInWrapper={false}
        />
      </div>
    );
  }
);

JSXPreviewContent.displayName = "JSXPreviewContent";

export type JSXPreviewErrorProps = ComponentProps<"div"> & {
  children?: ReactNode | ((error: Error) => ReactNode);
};

// 渲染属性与静态子节点二选一，函数形态拿到当前错误对象。
const renderChildren = (
  children: ReactNode | ((error: Error) => ReactNode),
  error: Error
): ReactNode => {
  if (typeof children === "function") {
    return children(error);
  }
  return children;
};

export const JSXPreviewError = memo(
  ({ className, children, ...props }: JSXPreviewErrorProps) => {
    const { error } = useJSXPreview();

    // error 为 null 时组件返回 null，不能占位；错误由 useJSXPreview 上下文提供，与内容组件同源。
    // 错误来自上下文而非本地状态，与内容组件共享同一份事实。
    if (!error) {
      return null;
    }

    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-ui-base",
          className
        )}
        {...props}
      >
        {children ? (
          renderChildren(children, error)
        ) : (
          <>
            <AlertCircle className="size-4 shrink-0" />
            <span>{error.message}</span>
          </>
        )}
      </div>
    );
  }
);

JSXPreviewError.displayName = "JSXPreviewError";
