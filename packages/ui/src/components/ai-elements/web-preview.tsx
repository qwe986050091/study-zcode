// INV-01 url 的唯一可写副本是 WebPreview 内的 useState，默认值只有 defaultUrl 一个入口；守住位置：WebPreview 的 setUrl 与 handleUrlChange；改错故障：地址栏显示与 iframe 实际加载的页面不一致。
// INV-02 defaultUrl 只在首次挂载时读取，之后改值不生效；守住位置：useState(defaultUrl) 初始化这一行；改错故障：切换会话后预览仍停在旧地址。
// INV-03 所有地址写入必须经过 handleUrlChange，消费方不得直写状态；守住位置：contextValue 的 setUrl 字段；改错故障：onUrlChange 漏发，父组件记录与实际地址分叉。
// INV-04 onUrlChange 在 url 落地之后同步调用一次，不做防抖也不延迟到下一帧；守住位置：handleUrlChange 回调体；改错故障：父级收到的地址落后于预览，或同一地址被通知多次。
// INV-05 地址栏只在 Enter 提交时写入 context，输入过程不污染全局 url；守住位置：handleKeyDown 的 Enter 分支；改错故障：边输入边重载 iframe，页面反复白屏。
// INV-06 受控 value 优先于内部草稿 inputValue；守住位置：Input 的 value 表达式；改错故障：传了受控 value 后输入无响应，或内部值覆盖外部控制。
// INV-07 外部 url 变化靠渲染期对比 prevUrl 同步进输入框，不使用 effect；守住位置：url 与 prevUrl 不相等的分支；改错故障：外部跳转后输入框仍显示旧地址。
// INV-08 consoleOpen 由 Provider 独占持有，Console 面板是受控 Collapsible；守住位置：consoleOpen 状态与 onOpenChange 接线；改错故障：两个面板展开状态互相打架。
// INV-09 消费组件必须在 Provider 内使用，缺失即同步抛错；守住位置：useWebPreview 的空 context 分支；改错故障：静默渲染空导航栏，问题推迟到更远处才暴露。
// INV-10 iframe 地址按 src 再 url 的顺序求值，空串降级为 undefined；守住位置：WebPreviewBody 的 src 属性；改错故障：空地址被当作相对路径，预览加载出宿主页面。
// INV-11 sandbox 固定放行脚本与同源，不随 props 覆盖；守住位置：iframe 的 sandbox 字面量；改错故障：预览页脚本失效白屏，或收紧过度导致登录态丢失。
// INV-12 iframe 没有命令式 reload 入口，刷新完全由 src 字符串变化驱动；守住位置：src 表达式与无 ref 的实现方式；改错故障：需要刷新时无处调用，只能靠改地址绕过。
// INV-13 loading 只是静态插槽，组件不监听 iframe 的 load 事件；守住位置：WebPreviewBody 中 loading 的渲染位置；改错故障：父级以为能自动收起加载态，遮罩永久停留。
// INV-14 组件不持有 effect、定时器与 window 监听，iframe 随容器卸载由 React 销毁；守住位置：WebPreviewBody 的无副作用实现；改错故障：新增监听未清理，卸载后仍向已销毁节点写入。
// INV-15 日志为空时渲染可读占位而不是 null；守住位置：logs.length 的三元分支；改错故障：面板展开后一片空白，用户以为面板坏了。
// INV-16 日志条目用时间戳、级别与消息拼接 key；守住位置：日志 map 的 key 表达式；改错故障：同毫秒同内容日志 key 冲突，列表渲染错位。
// INV-17 日志容器限高并允许纵向滚动；守住位置：max-h-48 与 overflow-auto 组合；改错故障：长错误栈把导航栏挤出可视区。
// INV-18 每个 Provider 内只有一份 url 与 consoleOpen，消费方不得自建副本；守住位置：contextValue 的字段来源；改错故障：地址栏与 iframe 分属两份状态，操作后互不响应。
//
// 模块职责：提供 WebPreview 外壳、地址导航、iframe 预览与 console 面板四个可组合单元，用 Context 共享地址与面板开合。
// 状态所有权：地址与面板开合归 WebPreview 的 useState，地址栏输入草稿与日志列表分别由 WebPreviewUrl 和调用方持有。
// 阅读顺序：WebPreview 看状态与 Context，再看 WebPreviewUrl 的受控桥接，然后 WebPreviewBody 的刷新与加载，最后 WebPreviewConsole 的空态与日志。
"use client";

import { Button } from "../ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { Input } from "../ui/input.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface WebPreviewContextValue {
  url: string;
  setUrl: (url: string) => void;
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
}

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

const useWebPreview = () => {
  const context = useContext(WebPreviewContext);
  if (!context) {
    // [失败路径] 脱离 Provider 使用任一子组件会在渲染期立即抛错，而不是渲染残缺 UI。
    // 错误信息固定指向包裹要求，便于从堆栈直接定位装配错误。
    // 该分支是唯一允许的抛错出口，其他位置不提供兜底默认值。
    throw new Error("WebPreview components must be used within a WebPreview");
  }
  return context;
};

// props 契约：className 与其余 div 属性原样透传给外层容器，children 由调用方组合导航、地址栏、预览与面板四段。
// defaultUrl 是非受控入口，只作初次渲染的地址种子，不是受控值。
// onUrlChange 是唯一对外通知通道，地址提交后回调一次，组件不等待返回值。
// [权衡] 未提供受控 url 属性，外部要驱动地址只能重挂载组件，以此避免双写。
export type WebPreviewProps = ComponentProps<"div"> & {
  defaultUrl?: string;
  onUrlChange?: (url: string) => void;
};

export const WebPreview = ({
  className,
  children,
  defaultUrl = "",
  onUrlChange,
  ...props
}: WebPreviewProps) => {
  // 地址状态的所有权落在这里，Provider 之下所有读取方共享同一份 url。
  // 初始化只在首次挂载执行，之后修改 defaultUrl 不会重置地址。
  // [权衡] 外部切换预览目标时应走地址栏提交或重挂载，而不是改 defaultUrl。
  const [url, setUrl] = useState(defaultUrl);
  const [consoleOpen, setConsoleOpen] = useState(false);

  // 事件桥接点：内部 setUrl 与外部 onUrlChange 在这里串联，先落状态再通知。
  // 回调身份随 onUrlChange 变化，被 useCallback 收敛，避免 contextValue 无谓刷新。
  // [并发] 连续提交不同地址以最后一次为准，回调仍按提交顺序同步触发。
  const handleUrlChange = useCallback(
    (newUrl: string) => {
      setUrl(newUrl);
      onUrlChange?.(newUrl);
    },
    [onUrlChange],
  );

  // Context 值由 url、consoleOpen 与两个写函数组成，字段来源全部是本组件状态。
  // memo 保证引用稳定，消费方不会因父级重渲染而整体重挂。
  // setUrl 指向 handleUrlChange 而不是裸 setState，确保通知链路无法被绕过。
  const contextValue = useMemo<WebPreviewContextValue>(
    () => ({
      consoleOpen,
      setConsoleOpen,
      setUrl: handleUrlChange,
      url,
    }),
    [consoleOpen, handleUrlChange, url],
  );

  return (
    <WebPreviewContext.Provider value={contextValue}>
      <div
        className={cn("flex size-full flex-col rounded-lg border bg-card", className)}
        {...props}
      >
        {children}
      </div>
    </WebPreviewContext.Provider>
  );
};

export type WebPreviewNavigationProps = ComponentProps<"div">;

export const WebPreviewNavigation = ({
  className,
  children,
  ...props
}: WebPreviewNavigationProps) => (
  <div className={cn("flex items-center gap-1 border-b p-2", className)} {...props}>
    {children}
  </div>
);

export type WebPreviewNavigationButtonProps = ComponentProps<typeof Button> & {
  tooltip?: string;
};

export const WebPreviewNavigationButton = ({
  onClick,
  disabled,
  tooltip,
  children,
  ...props
}: WebPreviewNavigationButtonProps) => (
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className="h-8 w-8 p-0 hover:text-foreground"
          disabled={disabled}
          onClick={onClick}
          size="sm"
          variant="ghost"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

export type WebPreviewUrlProps = ComponentProps<typeof Input>;

// 地址栏是半受控输入：value 与变更回调可从外部接管，未传时退回内部草稿。
// onKeyDown 先由内部处理 Enter 提交，再交给外部，外部无法阻止本次提交。
// onChange 支持整体替换：传了就完全跳过内部草稿写入。
// [权衡] 半受控让外部可只接管一层，代价是两套输入状态并存时需人工对齐。
export const WebPreviewUrl = ({ value, onChange, onKeyDown, ...props }: WebPreviewUrlProps) => {
  const { url, setUrl } = useWebPreview();
  const [prevUrl, setPrevUrl] = useState(url);
  const [inputValue, setInputValue] = useState(url);

  // Sync input value with context URL when it changes externally (derived state pattern)
  // 外部地址变化的同步点：渲染期对比上一帧 url，命中即写回输入框，不使用 effect。
  // 两个 setState 在渲染期触发，React 立即重渲染当前组件，不会提交中间 UI。
  // prevUrl 是防止重复同步的记忆位，与 url 成对更新。
  // [权衡] 渲染期写状态依赖派生状态约定，改成 effect 会多一次带旧值的提交。
  if (url !== prevUrl) {
    setPrevUrl(url);
    setInputValue(url);
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(event.target.value);
    onChange?.(event);
  };

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        const target = event.target as HTMLInputElement;
        setUrl(target.value);
      }
      onKeyDown?.(event);
    },
    [setUrl, onKeyDown],
  );

  return (
    <Input
      className="h-8 flex-1 text-ui-base"
      onChange={onChange ?? handleChange}
      onKeyDown={handleKeyDown}
      placeholder="Enter URL..."
      // 受控优先级最终落在这个表达式：外部 value 一旦传入，内部草稿立即失效。
      // 未传 value 时显示 inputValue，用户输入即时回显而不触发 iframe 刷新。
      // [失败路径] 传 value 却不接变更回调，输入会完全无响应，这是受控语义的必然结果。
      value={value ?? inputValue}
      {...props}
    />
  );
};

export type WebPreviewBodyProps = ComponentProps<"iframe"> & {
  loading?: ReactNode;
};

export const WebPreviewBody = ({ className, loading, src, ...props }: WebPreviewBodyProps) => {
  // 卸载清理说明：Body 只读取 url，不注册监听、不开定时器、不申请订阅，销毁成本由 React 承担。
  // iframe 一旦从树中移除，浏览器即释放其文档与脚本环境，无需手动置空 src。
  // [资源] 后续若要加 message 桥接，必须在 effect 的返回函数里移除监听，否则卸载后仍会收到旧消息。
  // 组件不阻止页面内弹窗与跳转，预览站点与宿主的隔离程度完全取决于 sandbox 声明。
  const { url } = useWebPreview();

  return (
    <div className="flex-1">
      <iframe
        className={cn("size-full", className)}
        // oxlint-disable-next-line eslint-plugin-react(iframe-missing-sandbox)
        // [资源] sandbox 固定放行脚本、同源、表单、弹窗与演示，预览站点因此能正常执行前端代码。
        // [权衡] 脚本加同源意味着被预览页面可触达宿主同源数据，只适用于可信内容。
        // 该属性不读取 props，调用方覆盖只会破坏一致性，故按不变量保持字面量。
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
        // 刷新语义集中在一个表达式：src 变化即换文档，组件不持有 iframe ref 去调用重载。
        // src 优先于 context 中的 url，允许调用方绕过地址栏直接指定目标页面。
        // 空串与 undefined 都落到 undefined，此时 iframe 不发起导航，保持空白文档。
        src={(src ?? url) || undefined}
        title="Preview"
        {...props}
      />
      {loading}
    </div>
  );
};

export type WebPreviewConsoleProps = ComponentProps<"div"> & {
  logs?: {
    level: "log" | "warn" | "error";
    message: string;
    timestamp: Date;
  }[];
};

export const WebPreviewConsole = ({
  className,
  logs = [],
  children,
  ...props
}: WebPreviewConsoleProps) => {
  const { consoleOpen, setConsoleOpen } = useWebPreview();

  return (
    <Collapsible
      className={cn("border-t bg-muted/50 font-mono text-ui-base", className)}
      // 面板开合是受控的：open 来自 Context，展开动作回写到 setConsoleOpen。
      // 受控意味着 Collapsible 自身不保存开合状态，两个入口看到的永远是同一份值。
      // [权衡] 折叠动画期间外部改 open 会打断过渡，属于可接受的表现层代价。
      onOpenChange={setConsoleOpen}
      open={consoleOpen}
      {...props}
    >
      <CollapsibleTrigger asChild>
        <Button
          className="flex w-full items-center justify-between p-4 text-left font-medium hover:bg-muted/50"
          variant="ghost"
        >
          Console
          <ChevronDownIcon
            className={cn("h-4 w-4 transition-transform duration-200", consoleOpen && "rotate-180")}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "px-4 pb-4",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        )}
      >
        <div className="max-h-48 space-y-1 overflow-auto">
          {/* Bugfix: Web preview console 可能输出很长的 URL/错误栈，手机窄屏只允许纵向滚动会裁掉右侧内容。 */}
          {logs.length === 0 ? (
            <p className="text-muted-foreground">No console output</p>
          ) : (
            logs.map((log) => (
              <div
                className={cn(
                  "text-ui-base",
                  log.level === "error" && "text-destructive",
                  log.level === "warn" && "text-yellow-600",
                  log.level === "log" && "text-foreground",
                )}
                key={`${log.timestamp.getTime()}-${log.level}-${log.message}`}
              >
                <span className="text-muted-foreground">{log.timestamp.toLocaleTimeString()}</span>{" "}
                {log.message}
              </div>
            ))
          )}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
