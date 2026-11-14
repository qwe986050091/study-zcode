"use client";

// INV-01 未显式开启时一律遮蔽，任何环境变量的值都不得直接渲染；守住位置：EnvironmentVariableValue 的 displayValue 三元；改错故障：首次渲染就把明文密钥画上屏幕，截图或投屏即泄露。
// INV-02 显隐开关只改内存与回调，不得写入 localStorage、URL 或 cookie；守住位置：setShowValues；改错故障：状态落盘后下次打开默认明文，遮蔽机制整体失效。
// INV-03 受控模式下以 controlledShowValues 为准，同时内部 state 照写；守住位置：showValues 的取值与 setShowValues；改错故障：父层拒绝更新时开关图标与实际渲染分叉，用户无法判断当前是否明文。
// INV-04 遮蔽串长度取 value.length 与 20 的较小值，是截断而非等长；守住位置：displayValue 的 repeat 上界；改错故障：等长圆点泄露密钥精确长度，超长值还会撑破行布局。
// INV-05 遮蔽态必须叠加 select-none，圆点不得被当作正文选中复制；守住位置：EnvironmentVariableValue 的 className 拼装；改错故障：全选复制得到一串圆点并粘进配置，调用方误判为真实取值。
// INV-06 复制内容严格由 copyFormat 决定，name、value、export 三路互不掺杂；守住位置：getTextToCopy；改错故障：格式错配会把整行 export 语句粘进只需要变量名的输入框。
// INV-07 export 分支输出带双引号的赋值语句，值内的双引号与反斜杠必须转义；守住位置：formatMap 的 export 模板；改错故障：值含双引号时 shell 语句被提前闭合，变量被截断甚至注入出非法命令。
// INV-08 复位定时器句柄由 timeoutRef 独占，新一次复制覆盖旧句柄；守住位置：copyToClipboard 内的 setTimeout 赋值；改错故障：连点会让先前定时器提前把 isCopied 置回，对勾图标闪现即消失。
// INV-09 组件卸载必须 clearTimeout，定时器不得跨越组件生命周期存活；守住位置：useEffect 的空依赖清理函数；改错故障：卸载后仍写状态，反复挂载会累积未释放的定时器。
// INV-10 剪贴板能力缺失时走 onError 分支，不得抛异常；守住位置：copyToClipboard 的 window 与 navigator 前置判断；改错故障：非安全上下文点一下按钮就抛错，整块面板白屏。
// INV-11 writeText 被拒绝时同样转成 onError，且 isCopied 必须保持 false；守住位置：copyToClipboard 的 catch；改错故障：权限被拒仍显示对勾，用户以为已复制，粘贴出空内容。
// INV-12 成功路径次序固定为先置 isCopied、再回调 onCopy、最后起定时器；守住位置：copyToClipboard 的 try 块；改错故障：次序倒置时 onCopy 抛错会跳过定时器，对勾永远不复位。
// INV-13 上下文缺省值必须是 showValues 为 false 与 setShowValues 为 noop，脱离 Provider 也安全；守住位置：EnvironmentVariablesContext 的 createContext 初值；改错故障：缺省 true 让单独渲染的 Value 直接输出明文。
// INV-14 Value 优先渲染 children，其次才回落到遮蔽后的 context 值；守住位置：children 与 displayValue 的空值合并；改错故障：自定义子节点绕过遮蔽路径，调用方以为受保护实际明文。
// INV-15 变量名与值分处两个 context，Name 不订阅 showValues 以免无谓重渲染；守住位置：两个 context 的职责划分；改错故障：合并后每次切换显隐整行重算，长列表明显掉帧。
// INV-16 显隐状态只保存布尔，不得额外缓存明文副本；守住位置：EnvironmentVariables 的状态链与 Value 的取值链；改错故障：多存一份明文让遮蔽可被一次结构检查读出，等于没有遮蔽。
// INV-17 名称与值不得写入 console、错误 message 或上报载荷；守住位置：copyToClipboard 两处 onError 只传 Error 本身；改错故障：错误上报长期留存密钥明文，泄露面从界面扩散到日志系统。
// INV-18 每条变量自建 Provider，name 与 value 不得提到列表外层共享；守住位置：EnvironmentVariable 的 useMemo 与 Provider；改错故障：上下文串行后相邻行互相显示对方的键值，等于错配凭据。
// INV-19 切换显隐只替换文本内容，不得改变 DOM 结构与行高；守住位置：Toggle 的图标分支与 Value 的渲染；改错故障：展开瞬间整行跳动，鼠标目标移位导致误点相邻操作。
// INV-20 值缺失时按空串遮蔽渲染，不得回落到 undefined 文案；守住位置：EnvironmentVariableContext 的缺省对象与 Value 取值；改错故障：界面出现 undefined 字样，用户误以为变量未设置而重复填写。
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Switch } from "../ui/switch.js";
import { cn } from "../lib/utils.js";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface EnvironmentVariablesContextType {
  showValues: boolean;
  setShowValues: (show: boolean) => void;
}

// Default noop for context default value
// oxlint-disable-next-line eslint(no-empty-function)
const noop = () => {};

const EnvironmentVariablesContext =
  createContext<EnvironmentVariablesContextType>({
    setShowValues: noop,
    showValues: false,
  });

export type EnvironmentVariablesProps = HTMLAttributes<HTMLDivElement> & {
  showValues?: boolean;
  defaultShowValues?: boolean;
  onShowValuesChange?: (show: boolean) => void;
};

export const EnvironmentVariables = ({
  showValues: controlledShowValues,
  defaultShowValues = false,
  onShowValuesChange,
  className,
  children,
  ...props
}: EnvironmentVariablesProps) => {
  const [internalShowValues, setInternalShowValues] =
    useState(defaultShowValues);
  // [权衡] 单一变量同时承载受控与非受控两条来源，用 ?? 而不是 ||：
  // defaultShowValues 显式为 false 时 ?? 会保留它，|| 却会误判成未提供而回落到内部值。
  // 受控时父层不传 onShowValuesChange，内部 state 仍会前进但被本行丢弃，
  // 表现为开关点下去不动；这是有意的受控契约，不是允许内部值偷偷生效。
  // 显隐状态只活在 React 树内，本文件不写 localStorage、不拼进 URL、不落 cookie，
  // 否则「上次展开过」会变成默认明文，INV-02 与 INV-01 会一起被破坏。
  // [失败路径] 若把 ?? 换成对布尔转换后的取值，受控 false 会被当成空值，
  // 用户在父层关闭显示后依然看到明文，且没有任何报错可以追查。
  const showValues = controlledShowValues ?? internalShowValues;

  const setShowValues = useCallback(
    (show: boolean) => {
      // [权衡] 即使处于受控模式也照写内部 state，不做「受控就跳过更新」的优化。
      // 父组件可能在受控与不受控之间来回切换，跳过写入会让内部值停在旧快照，
      // 一旦切回非受控，开关立刻跳回历史状态，用户会认为点击被吞。
      // [事务] 两次状态推进顺序固定：先内部 state，再回调父组件。
      // 反过来的话，父层回调里同步卸载本组件会触发对已卸载树的状态写入。
      // 回调是可选的，缺失时开关仍可用，只是状态不外露，这是非受控的默认路径。
      // 回调只传布尔，绝不把明文值一并带出，避免父层把密钥存进全局 store。
      // 任何在这里追加的副作用（写盘、带值埋点）都会同时破坏 INV-02 与 INV-17。
      setInternalShowValues(show);
      onShowValuesChange?.(show);
    },
    [onShowValuesChange]
  );

  const contextValue = useMemo(
    () => ({ setShowValues, showValues }),
    [setShowValues, showValues]
  );

  return (
    <EnvironmentVariablesContext.Provider value={contextValue}>
      <div
        className={cn("rounded-lg border bg-background", className)}
        {...props}
      >
        {children}
      </div>
    </EnvironmentVariablesContext.Provider>
  );
};

export type EnvironmentVariablesHeaderProps = HTMLAttributes<HTMLDivElement>;

export const EnvironmentVariablesHeader = ({
  className,
  children,
  ...props
}: EnvironmentVariablesHeaderProps) => (
  <div
    className={cn(
      "flex items-center justify-between border-b px-4 py-3",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type EnvironmentVariablesTitleProps = HTMLAttributes<HTMLHeadingElement>;

export const EnvironmentVariablesTitle = ({
  className,
  children,
  ...props
}: EnvironmentVariablesTitleProps) => (
  <h3 className={cn("font-medium text-ui-base", className)} {...props}>
    {children ?? "Environment Variables"}
  </h3>
);

export type EnvironmentVariablesToggleProps = ComponentProps<typeof Switch>;

export const EnvironmentVariablesToggle = ({
  className,
  ...props
}: EnvironmentVariablesToggleProps) => {
  const { showValues, setShowValues } = useContext(EnvironmentVariablesContext);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="text-muted-foreground text-ui-base">
        {showValues ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
      </span>
      <Switch
        // 开关是受控的，checked 与 onCheckedChange 都接到 context，不留本地状态；
        // [失败路径] 一旦让它自管 checked，图标会跟着走而真实遮蔽仍由父层决定，
        // 于是出现「眼睛图标显示已展开、值仍是圆点」的自相矛盾界面。
        // aria-label 固定为英文常量，因为视觉上只有图标，读屏用户全靠这行识别用途。
        aria-label="Toggle value visibility"
        checked={showValues}
        onCheckedChange={setShowValues}
        {...props}
      />
    </div>
  );
};

export type EnvironmentVariablesContentProps = HTMLAttributes<HTMLDivElement>;

export const EnvironmentVariablesContent = ({
  className,
  children,
  ...props
}: EnvironmentVariablesContentProps) => (
  <div className={cn("divide-y", className)} {...props}>
    {children}
  </div>
);

interface EnvironmentVariableContextType {
  name: string;
  value: string;
}

const EnvironmentVariableContext =
  createContext<EnvironmentVariableContextType>({
    name: "",
    value: "",
  });

export type EnvironmentVariableGroupProps = HTMLAttributes<HTMLDivElement>;

export const EnvironmentVariableGroup = ({
  className,
  children,
  ...props
}: EnvironmentVariableGroupProps) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export type EnvironmentVariableNameProps = HTMLAttributes<HTMLSpanElement>;

export const EnvironmentVariableName = ({
  className,
  children,
  ...props
}: EnvironmentVariableNameProps) => {
  const { name } = useContext(EnvironmentVariableContext);

  return (
    <span className={cn("font-mono text-ui-base", className)} {...props}>
      {children ?? name}
    </span>
  );
};

export type EnvironmentVariableValueProps = HTMLAttributes<HTMLSpanElement>;

export const EnvironmentVariableValue = ({
  className,
  children,
  ...props
}: EnvironmentVariableValueProps) => {
  const { value } = useContext(EnvironmentVariableContext);
  const { showValues } = useContext(EnvironmentVariablesContext);

  // 遮蔽是渲染期派生值，不改写 props 也不缓存明文，开关切换只是重算这一行。
  // [权衡] 遮蔽串取 value.length 与 20 的较小值：等长会让攻击者从圆点个数读出长度，
  // 不封顶则五百字符的 base64 令牌会把整行撑开甚至溢出容器。
  // 圆点是定宽字符，长度变化不引起明显抖动，这是选它而不选星号串的原因。
  // [失败路径] 值为空串时 repeat(0) 得到空文本，视觉上像没渲染，这是对的：
  // 空值本来就该看起来是空的，补占位符会让用户分不清未设置与空值。
  // 只有 showValues 为真才直出明文；任何「方便调试默认展开」的改动都违反 INV-01。
  // children 传值时会整段替换本派生值，因此遮蔽只对走 context 的默认渲染生效。
  const displayValue = showValues
    ? value
    : "•".repeat(Math.min(value.length, 20));

  return (
    <span
      className={cn(
        "font-mono text-muted-foreground text-ui-base",
        !showValues && "select-none",
        className
      )}
      {...props}
    >
      {children ?? displayValue}
    </span>
  );
};

export type EnvironmentVariableProps = HTMLAttributes<HTMLDivElement> & {
  name: string;
  value: string;
};

export const EnvironmentVariable = ({
  name,
  value,
  className,
  children,
  ...props
}: EnvironmentVariableProps) => {
  // 每行变量各自建 Provider，对象只按引用比较，父级列表重渲染时不必重算消费者。
  // [权衡] name 与 value 合进同一个对象 memo，而不是拆成两个 Provider：
  // 拆开会多一层树，而两者总是同时变化（同一条记录被编辑），收益为零。
  // 依赖数组只放 name 与 value，不放 className；样式变化不该触发 context 更新，
  // 否则父层每次传新的内联 className 都会让整行消费者重新渲染。
  // [失败路径] 若把本 Provider 提到列表外层复用，所有行会共享最后一条记录，
  // 相邻变量在界面上显示同一个键值，用户复制到的是错误凭据。
  // 缺省空串是安全的：空串遮蔽后仍是空，不会把 undefined 漏到界面上（INV-20）。
  const envVarContextValue = useMemo(() => ({ name, value }), [name, value]);

  return (
    <EnvironmentVariableContext.Provider value={envVarContextValue}>
      <div
        className={cn(
          "flex items-center justify-between gap-4 px-4 py-3",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <div className="flex items-center gap-2">
              <EnvironmentVariableName />
            </div>
            <EnvironmentVariableValue />
          </>
        )}
      </div>
    </EnvironmentVariableContext.Provider>
  );
};

export type EnvironmentVariableCopyButtonProps = ComponentProps<
  typeof Button
> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
  copyFormat?: "name" | "value" | "export";
};

export const EnvironmentVariableCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  copyFormat = "value",
  children,
  className,
  ...props
}: EnvironmentVariableCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { name, value } = useContext(EnvironmentVariableContext);

  const getTextToCopy = useCallback((): string => {
    const formatMap = {
      export: () => `export ${name}="${value}"`,
      name: () => name,
      value: () => value,
    };
    // [权衡] 三路输出用查表而非 if 与 switch：分支长度相近，表驱动把支持格式
    // 收敛成一个对象，新增格式只动这里，不必在组件里再加分支。
    // 表在 useCallback 内重建，闭包捕获本次渲染的 name 与 value，不会读到陈旧值。
    // [失败路径] export 不给值加双引号时，含空格或美元符号的值会被 shell 拆成多段；
    // 值内的双引号与反斜杠还要按双引号规则转义，否则语句被提前闭合，
    // 轻则变量被截断，重则后半段被 shell 当作命令执行（INV-07）。
    // name 分支只回变量名，value 分支只回原始值，都不加 export 前缀与引号。
    // 任何在此拼接日志或埋点的做法都会把明文带出组件，违反 INV-17。
    return formatMap[copyFormat]();
  }, [name, value, copyFormat]);

  const copyToClipboard = useCallback(async () => {
    // [失败路径] 三层前置判断缺一不可：服务端预渲染没有 window，
    // 旧浏览器可能没有 navigator，部分实现有 clipboard 却没有 writeText，
    // 任一缺失都会让下行调用抛 TypeError，而不是返回可捕获的 Promise。
    // 非安全上下文（http 页面）里 writeText 存在但必然拒绝，这一层拦不住，
    // 必须由 catch 兜底，两条路径都收敛到 onError，界面不能留下未处理拒绝。
    // 错误对象只携带「能力缺失」这一事实，不把待写文本塞进 message，
    // 否则错误被上报或打日志时，密钥明文就跟着离开了组件（INV-17）。
    // 此处直接返回而不回落到已废弃的 execCommand：它要插临时 DOM 节点并抢焦点。
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(getTextToCopy());
      setIsCopied(true);
      onCopy?.();
      // [资源] 句柄存 ref 而非 state：定时器变化不需要渲染，存 state 会多一轮更新。
      // 每次成功复制直接覆盖 ref，旧定时器仍在跑但不再被引用，这是有意的，
      // 提前 clear 再设新的也可以，覆盖则让「最后一次点击决定复位时刻」。
      // [失败路径] 若改用局部变量保存句柄，卸载清理就取不到它，
      // 组件销毁后回调仍会 setIsCopied，控制台报未挂载告警。
      // timeout 由调用方传入并归入依赖数组，改值时回调重建，句柄仍是同一个 ref。
      // 定时器只负责把 isCopied 复位，不做任何复制重试，避免重复写剪贴板。
      // 置回 false 而非累加计数：图标只有两态，计数会让状态与视觉脱节。
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  }, [getTextToCopy, onCopy, onError, timeout]);

  useEffect(
    () => () => {
      // [资源] 卸载清理与延迟复位共用同一 ref；空依赖数组保证清理函数只注册一次。
      // 清理时必须走 window.clearTimeout 而不是直接丢引用：浏览器定时器不会自行回收。
      // 这里不把 ref 置零，是因为组件即将销毁，残留 id 不会再有第二次使用。
      // [权衡] 没有在每次复制前先 clearTimeout，代价是极端情况下有两个定时器并存，
      // 但两者都只写同一个布尔，最坏结果是复位早一次，不会产生错误状态。
      // 开发期严格模式会挂载两次，清理函数因此必须幂等，重复 clear 必须无害。
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("size-6 shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={12} />}
    </Button>
  );
};

export type EnvironmentVariableRequiredProps = ComponentProps<typeof Badge>;

export const EnvironmentVariableRequired = ({
  className,
  children,
  ...props
}: EnvironmentVariableRequiredProps) => (
  <Badge className={cn("text-ui-base", className)} variant="secondary" {...props}>
    {children ?? "Required"}
  </Badge>
);
