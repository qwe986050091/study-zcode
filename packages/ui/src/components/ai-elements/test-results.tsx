/*
 * Derived from vercel/ai-elements (packages/elements/src/test-results.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// TestResults 组件族：结果外壳、套件折叠分组、单条用例行与错误详情四层，各自持有独立上下文
// 只做展示投影，汇总数字、套件状态、用例耗时全部由调用方经 props 注入，组件不取数不写状态
// 不负责：测试执行与结果采集、排序过滤、状态持久化、词条本地化、焦点管理与长列表虚拟化
//
// INV-01 断言：状态四个取值必须与状态样式表、状态图标表两张查表的键集合完全一致 —— 守住它的位置：两个 Record 声明 —— 改错故障：查表得到 undefined，图标与配色在运行态消失
// INV-02 断言：汇总总数不得小于通过数与失败数之和 —— 守住它的位置：进度条宽度计算 —— 改错故障：两段色块总宽超过百分之百，右侧被轨道裁掉
// INV-03 断言：汇总总数为 0 时必须跳过进度条渲染 —— 守住它的位置：进度条除零分支 —— 改错故障：宽度渲染成无效数值百分比，整条进度塌陷
// INV-04 断言：顶栏耗时把 0 毫秒视同缺失，单条耗时把 0 毫秒视为有效 —— 守住它的位置：两处判空写法 —— 改错故障：统一口径后 0 毫秒用例在某一层莫名消失
// INV-05 断言：结果上下文的默认值必须是空对象 —— 守住它的位置：上下文初始值 —— 改错故障：脱离外层包裹渲染时整棵子树抛异常而不是静默隐藏
// INV-06 断言：套件上下文的兜底状态必须是通过 —— 守住它的位置：套件上下文初始值 —— 改错故障：漏包外层包裹的标题全变红叉，形成大面积误报
// INV-07 断言：三个上下文的值都经记忆化，依赖数组分别覆盖各自字段 —— 守住它的位置：三处记忆化调用 —— 改错故障：依赖漏项导致子组件长期读到旧的名称或耗时
// INV-08 断言：自定义子节点一旦传入就整体替换默认内容 —— 守住它的位置：各组件子节点兜底分支 —— 改错故障：默认徽章与自定义节点叠加，同一统计出现两次
// INV-09 断言：只有失败数与跳过数大于 0 才渲染对应徽章 —— 守住它的位置：摘要徽章条件渲染 —— 改错故障：满屏零失败噪声，摘要区宽度随结果抖动
// INV-10 断言：通过数徽章无条件渲染作为基线 —— 守住它的位置：摘要首个徽章 —— 改错故障：全部失败场景下摘要变空白，用户看不出用例总数
// INV-11 断言：单条用例仅在耗时字段非空时渲染耗时 —— 守住它的位置：用例行与耗时子组件 —— 改错故障：0 毫秒用例被判为缺数据而丢失耗时列
// INV-12 断言：耗时格式化以 1000 毫秒为分界并固定两位小数 —— 守住它的位置：格式化函数分支 —— 改错故障：阈值误改后毫秒被无条件当秒显示，数值差一千倍
// INV-13 断言：进度条不使用跳过数为任何一段着色 —— 守住它的位置：进度条两段色块 —— 改错故障：轨道出现第三种颜色或百分比之和越过边界
// INV-14 断言：折叠展开状态不由本组件持有 —— 守住它的位置：套件外壳与折叠组件传参 —— 改错故障：外部再传一次受控属性，展开动画与内部状态互相抢写
// INV-15 断言：错误堆栈容器必须保留滚动能力 —— 守住它的位置：堆栈组件的溢出类 —— 改错故障：多帧堆栈撑破卡片，遮挡下方用例列表
//
import { Badge } from "../ui/badge.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleDotIcon,
  CircleIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useMemo } from "react";

// 四种状态是闭集，界面只识别这四种，新增取值要同时改状态样式表、图标表与汇总口径
// 状态字符串直接参与类名与图标查表，拼错不会报错，只会静默渲染出空白
// 运行中与跳过在展示上不等价：前者带脉冲动画，后者用空心圈表示未执行
// 通过是最宽松的默认值，散落在两个上下文的兜底对象里，此处不要顺手改成失败
// [契约] 调用方传入的状态字符串必须精确匹配这四个字面量，大小写或下划线变体都会落到查表缺失分支
type TestStatus = "passed" | "failed" | "skipped" | "running";

// [契约] 总数与各分项计数之间没有运行时校验，组件完全信任调用方给出的数字
// 耗时单位是毫秒且可选，只用于顶栏文案，不参与进度条比例计算
// 跳过数不计入进度条宽度，视觉上表现为尾部留白，而不是第四段色块
// 该接口是跨层契约，增删字段会影响顶部摘要与外壳组件，改动需同步上游产出方
// 字段顺序无关紧要，但新增字段必须同时出现在外壳属性类型与上下文对象里
interface TestResultsSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration?: number;
}

interface TestResultsContextType {
  summary?: TestResultsSummary;
}

// 默认空对象是刻意的：脱离外层包裹单独渲染子组件时不抛异常，而是静默返回空节点
// 改成抛错或给一个默认汇总都会让只有在外壳内才有意义这一约束被绕过
// [失败路径] 未包裹时摘要、耗时、进度三个组件都返回空，页面上只留空白，排查时先确认外层是否存在
// 上下文类型把汇总声明为可选，正是为了配合这个空对象默认值
// 此处不要用非空断言兜底，那只会把配置错误推迟成运行期崩溃
const TestResultsContext = createContext<TestResultsContextType>({});

// 1000 毫秒是唯一分界：以下保留整数毫秒，以上换算为秒并固定两位小数
// 定点小数返回的是字符串，这里不做单位本地化，需要别的格式请用子节点覆盖
// 不做四舍五入到整秒，避免 1.004 秒显示成 1 秒后与真实耗时差异过大
// 负数与非法数值不会被拦截，直接拼接输出，上游给出异常耗时的校验责任不在本文件
// [权衡] 固定两位小数牺牲了极短耗时的可读精度，换取长耗时不会拖出一长串小数
const formatDuration = (ms: number) => {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
};

export type TestResultsHeaderProps = HTMLAttributes<HTMLDivElement>;

export const TestResultsHeader = ({ className, children, ...props }: TestResultsHeaderProps) => (
  <div className={cn("flex items-center justify-between border-b px-4 py-3", className)} {...props}>
    {children}
  </div>
);

export type TestResultsDurationProps = HTMLAttributes<HTMLSpanElement>;

// [失败路径] 判空写的是对汇总耗时取反，0 毫秒与缺失同等对待，两者都整块不渲染
// 若产品要求展示 0 毫秒，必须改成显式的非空判断，而不是直接删掉这层兜底
// 子节点优先于默认格式化结果，调用方可用它整体接管耗时文案
// 外层类名会与基础样式合并，覆盖字号时不要丢掉弱化配色的语义
// 该组件依赖结果上下文，放在包裹层外部只会得到空节点，不报错也不告警
export const TestResultsDuration = ({
  className,
  children,
  ...props
}: TestResultsDurationProps) => {
  const { summary } = useContext(TestResultsContext);

  if (!summary?.duration) {
    return null;
  }

  return (
    <span className={cn("text-muted-foreground text-ui-base", className)} {...props}>
      {children ?? formatDuration(summary.duration)}
    </span>
  );
};

export type TestResultsSummaryProps = HTMLAttributes<HTMLDivElement>;

// 汇总缺失时整块返回空，避免出现零个通过这类误导性数字
// 子节点一旦传入就完全替换默认徽章组，两条渲染路径不会叠加
// 失败与跳过徽章各自带大于零的判断，为零时不占位，摘要宽度会随结果变化
// 通过徽章无条件渲染，即使全部失败也显示零个通过，这是有意的基线信息
// [契约] 三个徽章的配色与文案是稳定的视觉契约，改文案会影响快照与端到端断言
export const TestResultsSummary = ({ className, children, ...props }: TestResultsSummaryProps) => {
  const { summary } = useContext(TestResultsContext);

  if (!summary) {
    return null;
  }

  return (
    <div className={cn("flex items-center gap-3", className)} {...props}>
      {children ?? (
        <>
          <Badge
            className="gap-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            variant="secondary"
          >
            <CheckCircle2Icon className="size-3" />
            {summary.passed} passed
          </Badge>
          {summary.failed > 0 && (
            <Badge
              className="gap-1 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              variant="secondary"
            >
              <XCircleIcon className="size-3" />
              {summary.failed} failed
            </Badge>
          )}
          {summary.skipped > 0 && (
            <Badge
              className="gap-1 bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
              variant="secondary"
            >
              <CircleIcon className="size-3" />
              {summary.skipped} skipped
            </Badge>
          )}
        </>
      )}
    </div>
  );
};

export type TestResultsProps = HTMLAttributes<HTMLDivElement> & {
  summary?: TestResultsSummary;
};

// 外壳只做两件事：建立上下文与画一张带边框的容器，自身不读取上下文
// [契约] 记忆化依赖只有汇总对象，调用方每次渲染重建该对象会让下游全部重渲染
// 子节点为空时才走默认顶栏，一旦传入自定义内容就不再自动附加摘要与耗时
// 汇总为缺失且子节点为空时，最终是一个空容器，不会崩但也没有任何内容
// 包裹层在容器之外，保证顶栏与用户自定义子节点读到的是同一份汇总
export const TestResults = ({ summary, className, children, ...props }: TestResultsProps) => {
  const contextValue = useMemo(() => ({ summary }), [summary]);

  return (
    <TestResultsContext.Provider value={contextValue}>
      <div className={cn("rounded-lg border bg-background", className)} {...props}>
        {children ??
          (summary && (
            <TestResultsHeader>
              <TestResultsSummary />
              <TestResultsDuration />
            </TestResultsHeader>
          ))}
      </div>
    </TestResultsContext.Provider>
  );
};

export type TestResultsProgressProps = HTMLAttributes<HTMLDivElement>;

// [失败路径] 两个百分比都直接除以总数，总数为 0 时得到非法数值，宽度写成无效百分比后进度条塌陷
// 判空只拦汇总缺失，不拦总数为 0，这是已知薄弱点，修复应在本组件内加保护而不是改调用方
// 条宽只由通过率与失败率决定，跳过用例不画任何颜色，呈现为右侧留白
// [契约] 百分比文案对通过率取整显示，条宽却用未取整值，两者允许存在亚像素差异
// 两段色块共用带溢出裁剪的轨道，任何一段宽度越界都会被裁掉而不是撑破容器
export const TestResultsProgress = ({
  className,
  children,
  ...props
}: TestResultsProgressProps) => {
  const { summary } = useContext(TestResultsContext);

  if (!summary) {
    return null;
  }

  const passedPercent = (summary.passed / summary.total) * 100;
  const failedPercent = (summary.failed / summary.total) * 100;

  return (
    <div className={cn("space-y-2", className)} {...props}>
      {children ?? (
        <>
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            <div className="bg-green-500 transition-all" style={{ width: `${passedPercent}%` }} />
            <div className="bg-red-500 transition-all" style={{ width: `${failedPercent}%` }} />
          </div>
          <div className="flex justify-between text-muted-foreground text-ui-base">
            <span>
              {summary.passed}/{summary.total} tests passed
            </span>
            <span>{passedPercent.toFixed(0)}%</span>
          </div>
        </>
      )}
    </div>
  );
};

export type TestResultsContentProps = HTMLAttributes<HTMLDivElement>;

export const TestResultsContent = ({ className, children, ...props }: TestResultsContentProps) => (
  <div className={cn("space-y-2 p-4", className)} {...props}>
    {children}
  </div>
);

interface TestSuiteContextType {
  name: string;
  status: TestStatus;
}

// 默认状态取通过只用于脱离包裹层的兜底，真实套件状态总是由套件外壳注入
// 把兜底改成失败会让所有忘记包裹的用例标题显示红叉，属于典型的误报来源
// 名称默认空串，标题组件在无上下文时渲染空白而不是崩溃
// 该上下文只有名称与状态两个字段，计数信息走属性不走上下文，两者不要混用
// [契约] 上下文对象与套件外壳的记忆化依赖一一对应，新增字段必须同步依赖数组
const TestSuiteContext = createContext<TestSuiteContextType>({
  name: "",
  status: "passed",
});

// [契约] 状态样式表与状态图标表是同一枚举的两张平行查表，新增状态必须同时补齐两张
// 漏补一张时映射类型的完整性能挡住编译，被绕过后则表现为颜色或图标单边缺失
// 类名里同时写浅色与深色两套，主题切换靠暗色前缀而不是运行时判断
// 运行中使用蓝色并与脉冲动画配套，改色时留意与跳过状态的黄色区分度
// 此处只放颜色，不放布局类，布局由使用方在外层容器上组合，避免样式重复覆盖
const statusStyles: Record<TestStatus, string> = {
  failed: "text-red-600 dark:text-red-400",
  passed: "text-green-600 dark:text-green-400",
  running: "text-blue-600 dark:text-blue-400",
  skipped: "text-yellow-600 dark:text-yellow-400",
};

const statusIcons: Record<TestStatus, React.ReactNode> = {
  failed: <XCircleIcon className="size-4" />,
  passed: <CheckCircle2Icon className="size-4" />,
  running: <CircleDotIcon className="size-4 animate-pulse" />,
  skipped: <CircleIcon className="size-4" />,
};

const TestStatusIcon = ({ status }: { status: TestStatus }) => (
  <span className={cn("shrink-0", statusStyles[status])}>{statusIcons[status]}</span>
);

export type TestSuiteProps = ComponentProps<typeof Collapsible> & {
  name: string;
  status: TestStatus;
};

// 套件外壳把名称与状态放进上下文，标题行与状态图标由子组件各自读取
// [契约] 记忆化依赖名称与状态，二者任意变化都会重建上下文对象并触发子树重渲染
// 折叠的展开状态完全交给折叠组件内部管理，本组件不接收也不转发展开属性
// 额外属性原样透传给折叠组件，包括展开变更回调，调用方需受控时从外层接管
// 类名与基础圆角边框合并，覆盖边框时注意深色主题下的对比度
export const TestSuite = ({ name, status, className, children, ...props }: TestSuiteProps) => {
  const contextValue = useMemo(() => ({ name, status }), [name, status]);

  return (
    <TestSuiteContext.Provider value={contextValue}>
      <Collapsible className={cn("rounded-lg border", className)} {...props}>
        {children}
      </Collapsible>
    </TestSuiteContext.Provider>
  );
};

export type TestSuiteNameProps = ComponentProps<typeof CollapsibleTrigger>;

export const TestSuiteName = ({ className, children, ...props }: TestSuiteNameProps) => {
  const { name, status } = useContext(TestSuiteContext);

  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50",
        className,
      )}
      {...props}
    >
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      <TestStatusIcon status={status} />
      <span className="font-medium text-ui-base">{children ?? name}</span>
    </CollapsibleTrigger>
  );
};

export type TestSuiteStatsProps = HTMLAttributes<HTMLDivElement> & {
  passed?: number;
  failed?: number;
  skipped?: number;
};

// 三个计数默认都是 0，且为零时不渲染对应文案，空套件因此不显示任何统计
// 子节点存在时整块替换默认统计，用于自定义文案或补充图标
// 自动外边距把统计推到标题行右侧，删掉会与套件名挤在一起
// [契约] 这里的计数是独立属性，不读取套件上下文，跨层复用时需自行保证与套件状态一致
// 数字为负数时同样会渲染，组件不做合法性校验，调用方需保证计数非负
export const TestSuiteStats = ({
  passed = 0,
  failed = 0,
  skipped = 0,
  className,
  children,
  ...props
}: TestSuiteStatsProps) => (
  <div className={cn("ml-auto flex items-center gap-2 text-ui-base", className)} {...props}>
    {children ?? (
      <>
        {passed > 0 && <span className="text-green-600 dark:text-green-400">{passed} passed</span>}
        {failed > 0 && <span className="text-red-600 dark:text-red-400">{failed} failed</span>}
        {skipped > 0 && (
          <span className="text-yellow-600 dark:text-yellow-400">{skipped} skipped</span>
        )}
      </>
    )}
  </div>
);

export type TestSuiteContentProps = ComponentProps<typeof CollapsibleContent>;

export const TestSuiteContent = ({ className, children, ...props }: TestSuiteContentProps) => (
  <CollapsibleContent className={cn("border-t", className)} {...props}>
    <div className="divide-y">{children}</div>
  </CollapsibleContent>
);

interface TestContextType {
  name: string;
  status: TestStatus;
  duration?: number;
}

const TestContext = createContext<TestContextType>({
  name: "",
  status: "passed",
});

export type TestNameProps = HTMLAttributes<HTMLSpanElement>;

export const TestName = ({ className, children, ...props }: TestNameProps) => {
  const { name } = useContext(TestContext);

  return (
    <span className={cn("flex-1", className)} {...props}>
      {children ?? name}
    </span>
  );
};

export type TestDurationProps = HTMLAttributes<HTMLSpanElement>;

// [契约] 判空用的是严格等于空值，与顶栏耗时组件的真值判断不同，0 毫秒在这里必须显示
// 这两处口径不一致是历史行为，改动任一处的比较方式都会导致 0 毫秒用例在某一层消失
// 默认格式固定拼毫秒后缀，不做秒换算，单条用例耗时通常很短
// 子节点可以覆盖默认文案，适合需要展示亚毫秒等高精度场景的调用方
// 自动外边距让耗时靠右，与左侧名称形成两端布局，去掉后长名称会挤压耗时
export const TestDuration = ({ className, children, ...props }: TestDurationProps) => {
  const { duration } = useContext(TestContext);

  if (duration === undefined) {
    return null;
  }

  return (
    <span className={cn("ml-auto text-muted-foreground text-ui-base", className)} {...props}>
      {children ?? `${duration}ms`}
    </span>
  );
};

export type TestStatusProps = HTMLAttributes<HTMLSpanElement>;

export const TestStatus = ({ className, children, ...props }: TestStatusProps) => {
  const { status } = useContext(TestContext);

  return (
    <span className={cn("shrink-0", statusStyles[status], className)} {...props}>
      {children ?? statusIcons[status]}
    </span>
  );
};

export type TestProps = HTMLAttributes<HTMLDivElement> & {
  name: string;
  status: TestStatus;
  duration?: number;
};

// 单条用例同时提供上下文与默认行布局，子节点为空时按状态、名称、耗时的顺序拼接
// [契约] 记忆化依赖耗时、名称、状态三项，漏掉耗时会让其变化后子组件读到旧值
// 行内再次判断耗时非空来决定是否挂载耗时节点，与耗时组件自身的判空形成双保险
// 状态与名称子组件都从上下文取值，顺序调整只影响视觉，不影响数据来源
// 额外属性挂到行容器上，点击或悬停交互由调用方在外层附加，组件本身不绑定事件
export const Test = ({ name, status, duration, className, children, ...props }: TestProps) => {
  const contextValue = useMemo(() => ({ duration, name, status }), [duration, name, status]);

  return (
    <TestContext.Provider value={contextValue}>
      <div className={cn("flex items-center gap-2 px-4 py-2 text-ui-base", className)} {...props}>
        {children ?? (
          <>
            <TestStatus />
            <TestName />
            {duration !== undefined && <TestDuration />}
          </>
        )}
      </div>
    </TestContext.Provider>
  );
};

export type TestErrorProps = HTMLAttributes<HTMLDivElement>;

export const TestError = ({ className, children, ...props }: TestErrorProps) => (
  <div className={cn("mt-2 rounded-md bg-red-50 p-3 dark:bg-red-900/20", className)} {...props}>
    {children}
  </div>
);

export type TestErrorMessageProps = HTMLAttributes<HTMLParagraphElement>;

export const TestErrorMessage = ({ className, children, ...props }: TestErrorMessageProps) => (
  <p
    className={cn("font-medium text-red-700 text-ui-base dark:text-red-400", className)}
    {...props}
  >
    {children}
  </p>
);

export type TestErrorStackProps = HTMLAttributes<HTMLPreElement>;

// [资源] 堆栈可能很长，溢出滚动配合预格式化标签保证在容器内滚动而不撑破外层卡片宽度
// 等宽字体用于保留缩进，堆栈的对齐信息是排障的主要线索，不能被比例字体破坏
// 浅色与深色各一套红色文本色，主题切换依赖暗色前缀
// 子节点直接透传不做解析，堆栈的高亮或折叠由调用方自行处理
// 这里不加最大高度，高度约束交给使用方布局决定，硬编码会裁掉关键帧
export const TestErrorStack = ({ className, children, ...props }: TestErrorStackProps) => (
  <pre
    className={cn(
      "mt-2 overflow-auto font-mono text-red-600 text-ui-base dark:text-red-400",
      className,
    )}
    {...props}
  >
    {children}
  </pre>
);
