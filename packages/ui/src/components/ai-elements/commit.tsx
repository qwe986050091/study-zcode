/*
 * Derived from vercel/ai-elements (packages/elements/src/commit.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// commit.tsx —— commit 卡片族的纯展示组件：整行折叠触发器、hash 排版、相对时间、复制按钮与文件变更行
//
// INV-01 hash 只作纯文本渲染，绝不包成链接；守住位置：CommitHash 的 span 与 children；改错故障：整行本就是展开触发器，嵌套锚点后点 hash 会跳走而不是展开详情
// INV-02 hash 切几位由调用方决定，组件不截断也不校验格式；守住位置：CommitHash 渲染的 children；改错故障：若在此再切一刀，调用方给的短 hash 被二次截断，多条 commit 显示成同一个前缀
// INV-03 hash 段必须等宽渲染；守住位置：CommitHash 的 font-mono；改错故障：比例字体下各字符宽度不一，纵向列表的 hash 左边界参差，用户无法扫读比对
// INV-04 作者与时间都由调用方保证存在，组件不做空值兜底；守住位置：initials 与 date 的必填类型；改错故障：缺值时不报错也不提示，界面出现空白头像与空时间，看起来像渲染故障
// INV-05 date 非法时 toISOString 直接抛错，不得静默吞掉；守住位置：CommitTimestamp 的 dateTime 属性；改错故障：吞掉后渲染出 dateTime 为空的时间元素，读屏与机器解析都拿不到时间
// INV-06 相对时间只在天粒度上四舍五入；守住位置：formatRelativeDate 的 Math.round；改错故障：改成向下取整后 1.9 天前显示成 1 天前，与同列表里的绝对时间自相矛盾
// INV-07 相对时间文本只在挂载后的 effect 里写入，首帧为空；守住位置：CommitTimestamp 的 useState 初值与 updateFormatted；改错故障：渲染期直接算会让服务端与客户端得到不同文本，水合报不匹配并闪烁
// INV-08 相对时间格式化器全模块共用一个实例且 locale 固定 en；守住位置：模块级 relativeTimeFormat；改错故障：逐条新建实例会在长列表滚动中反复付出构造开销，且区域设置不同会输出混合语言
// INV-09 头像只显示调用方给的 initials，不请求图片也不从名字自造首字母；守住位置：CommitAuthorAvatar 的 AvatarFallback；改错故障：名字为空时自动派生会渲染成空白圆，用户以为组件坏了却无从定位
// INV-10 操作区内的点击与按键一律拦截冒泡，不触达整行触发器；守住位置：handleActionsClick 与 handleActionsKeyDown；改错故障：点复制按钮会顺带展开或收起整条 commit，复制完成后布局突然跳动
// INV-11 操作区以 role=group 聚合，不夺取触发器的展开语义；守住位置：CommitActions 的 role 属性；改错故障：读屏把复制按钮念成与整行同级的一级控件，用户分不清它属于哪条 commit
// INV-12 复制必须双闸门：能力检测与未复制标志，重入直接忽略；守住位置：copyToClipboard 的两段守卫；改错故障：连点会叠加多个复位定时器，先排的那个提前把对勾抹掉，用户以为没复制成功
// INV-13 能力缺失与写入失败必须分流，前者固定文案、后者透传原始异常；守住位置：copyToClipboard 的首个分支与 catch；改错故障：把权限被拒也说成浏览器不支持，用户按错误方向排查
// INV-14 复制成功后按 timeout 复位图标，卸载时必须清掉该定时器；守住位置：timeoutRef 与清理 effect；改错故障：卸载后定时器仍写 state，React 报卸载组件上的状态更新，测试出现噪声失败
// INV-15 文件状态的标签与配色只由 status 决定，两张表键必须一一对应；守住位置：fileStatusStyles 与 fileStatusLabels；改错故障：新增状态只补一张表，会出现有色无字母或字面 undefined 的标记，用户分不清新增还是删除
// INV-16 每个状态色都要明暗两套，不允许只写浅色；守住位置：fileStatusStyles 的各条目；改错故障：暗色主题下绿字落在深底上几乎不可见，加减行数读不出来
// INV-17 增删计数不大于零时整个节点不渲染，而不是渲染零；守住位置：CommitFileAdditions 与 CommitFileDeletions 的入口守卫；改错故障：每个无增删的文件都多出加零减零两个标记，行宽被无意义信息占满
// INV-18 文件路径单行省略，commit 消息不做截断；守住位置：CommitFilePath 的 truncate 与 CommitMessage；改错故障：路径不截断会把右侧增删计数挤出容器，消息若截断则正文从第二行起永远看不到
import { Avatar, AvatarFallback } from "../ui/avatar.js";
import { Button } from "../ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import { CheckIcon, CopyIcon, FileIcon, GitCommitIcon, MinusIcon, PlusIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type CommitProps = ComponentProps<typeof Collapsible>;

// 根容器只是 Collapsible 的薄封装：展开态默认非受控，需要外部控制时由调用方透传 open 与 onOpenChange
// [权衡] className 已从 props 解构移除，因此 cn 的合并结果不会被展开的 props 整条覆盖，调用方只覆盖自己给的那部分
// 该组件不持有 state，展开态存在 Radix 的内部 context 里，父层重渲染不会把它重置
// [失败路径] 同时传 open 与 defaultOpen 时以 open 为准、defaultOpen 被忽略，二者矛盾不报错，只是安静地走受控模式
// children 原样透出，Header 与 Content 的配对和顺序由使用者维护，组件不做结构校验
// 边框与背景只在这里画一次，Header 与展开内容不再重复画外框，避免展开后出现双线
// 不额外声明 role 与 aria-expanded，这些由 CollapsibleTrigger 产出，重复声明会盖掉正确的展开语义
export const Commit = ({ className, children, ...props }: CommitProps) => (
  <Collapsible className={cn("rounded-lg border bg-background", className)} {...props}>
    {children}
  </Collapsible>
);

export type CommitHeaderProps = ComponentProps<typeof CollapsibleTrigger>;

// asChild 把触发器的交互与无障碍属性转交给内部 div，等于用一个可点击的 div 充当整行按钮
// 不用原生 button，是因为一行里同时有 hash、消息、元数据与操作区，button 的内容模型不允许这种嵌套交互
// [失败路径] 键盘可达性完全依赖 asChild 注入的 role、tabIndex 与 aria-expanded；去掉 asChild 后整行不可聚焦，键盘用户无法展开任何 commit
// cursor-pointer 与 hover:opacity-80 是可点击的唯一视觉暗示，删掉后用户只能靠试
// text-left 必须显式声明，否则祖先的文本对齐会连带把 commit 消息居中
// justify-between 把主信息与操作区分置两端，gap-4 保证长消息被压缩时两者不重叠
// p-3 与展开内容的内边距一致，展开前后左右边界不会跳动
export const CommitHeader = ({ className, children, ...props }: CommitHeaderProps) => (
  <CollapsibleTrigger asChild {...props}>
    <div
      className={cn(
        "group flex cursor-pointer items-center justify-between gap-4 p-3 text-left transition-colors hover:opacity-80",
        className,
      )}
    >
      {children}
    </div>
  </CollapsibleTrigger>
);

export type CommitHashProps = HTMLAttributes<HTMLSpanElement>;

// 只负责排版，不切 hash 也不校验格式：展示几位由调用方按数据源决定
// font-mono 让十六进制字符等宽，多条 commit 纵向排列时 hash 左边界才能对齐
// 图标内联在文本流里，替代单独一列，省掉一个需要对齐的 flex 项
// size-3 与正文同量级，图标不会把行高撑开
// [权衡] 不把 hash 包成链接：整行已经是展开触发器，嵌套锚点会让点击变成跳转而非展开
// children 原样渲染，调用方可以换成带省略号的短 hash 或自绘节点，组件不介入
// [失败路径] 传入空串会渲染成一个只有图标的空壳，组件不做兜底，调用方需自行保证非空
export const CommitHash = ({ className, children, ...props }: CommitHashProps) => (
  <span className={cn("font-mono text-ui-base", className)} {...props}>
    <GitCommitIcon className="mr-1 inline-block size-3" />
    {children}
  </span>
);

export type CommitMessageProps = HTMLAttributes<HTMLSpanElement>;

export const CommitMessage = ({ className, children, ...props }: CommitMessageProps) => (
  <span className={cn("font-medium text-ui-base", className)} {...props}>
    {children}
  </span>
);

export type CommitMetadataProps = HTMLAttributes<HTMLDivElement>;

export const CommitMetadata = ({ className, children, ...props }: CommitMetadataProps) => (
  <div
    className={cn("flex items-center gap-2 text-muted-foreground text-ui-base", className)}
    {...props}
  >
    {children}
  </div>
);

export type CommitSeparatorProps = HTMLAttributes<HTMLSpanElement>;

export const CommitSeparator = ({ className, children, ...props }: CommitSeparatorProps) => (
  <span className={className} {...props}>
    {children ?? "•"}
  </span>
);

export type CommitInfoProps = HTMLAttributes<HTMLDivElement>;

export const CommitInfo = ({ className, children, ...props }: CommitInfoProps) => (
  <div className={cn("flex flex-1 flex-col", className)} {...props}>
    {children}
  </div>
);

export type CommitAuthorProps = HTMLAttributes<HTMLDivElement>;

export const CommitAuthor = ({ className, children, ...props }: CommitAuthorProps) => (
  <div className={cn("flex items-center", className)} {...props}>
    {children}
  </div>
);

export type CommitAuthorAvatarProps = ComponentProps<typeof Avatar> & {
  initials: string;
};

export const CommitAuthorAvatar = ({ initials, className, ...props }: CommitAuthorAvatarProps) => (
  <Avatar className={cn("size-8", className)} {...props}>
    <AvatarFallback className="text-ui-base">{initials}</AvatarFallback>
  </Avatar>
);

export type CommitTimestampProps = HTMLAttributes<HTMLTimeElement> & {
  date: Date;
};

const relativeTimeFormat = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

// 相对时间以天为唯一单位，跨度取当前时刻与目标时刻的毫秒差
// Math.round 而不是截断：四舍五入让 23 小时显示为今天、25 小时显示为明天，与用户直觉一致
// [权衡] 只到天粒度，不展开成几分钟前：commit 列表的扫描目标是先后顺序，分钟级精度只会增加噪音
// 每次调用都重新读 Date.now，同一组件在不同时刻重算会得到不同文本，这正是相对时间应有的行为
// 格式化器在模块加载时构造一次并被所有实例复用，构造开销不进入渲染路径
// locale 固定 en 且 numeric 为 auto，负数天直接输出 yesterday 一类现成词，与上游英文界面保持一致
const formatRelativeDate = (date: Date) => {
  const days = Math.round((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return relativeTimeFormat.format(days, "day");
};

// 首帧故意渲染空串：服务端与客户端的当前时刻不同，渲染期就算相对时间会造成水合文本不一致
// [事务] 写入顺序是 effect 触发回调、回调写 state、state 驱动文本，中间那一帧 time 元素存在但无文字
// updateFormatted 以 date 为依赖重建，date 变化时 effect 会重跑并立刻刷新文案
// dateTime 用 toISOString 输出机器可读的绝对时间，相对文本只给人看，读屏与解析器读的是这个属性
// [失败路径] date 为 Invalid Date 时 toISOString 抛 RangeError，组件不捕获：这是上游数据错误，静默兜底只会藏住缺陷
// children 优先，调用方可用自定义格式完全替换相对时间，此时 state 仍被写入但没人读
// 不设 title 或 aria-label 补全相对时间，绝对时间已由 dateTime 承载，重复描述会让读屏念两遍
export const CommitTimestamp = ({ date, className, children, ...props }: CommitTimestampProps) => {
  const [formatted, setFormatted] = useState("");

  const updateFormatted = useCallback(() => {
    setFormatted(formatRelativeDate(date));
  }, [date]);

  useEffect(() => {
    updateFormatted();
  }, [updateFormatted]);

  return (
    <time className={cn("text-ui-base", className)} dateTime={date.toISOString()} {...props}>
      {children ?? formatted}
    </time>
  );
};

export type CommitActionsProps = HTMLAttributes<HTMLDivElement>;

// [并发] 操作区嵌在整行触发器内部，点击会先冒泡到触发器并切换展开态，必须在最内层拦下
// 点击与按键分别拦截：键盘事件不经过 click，只拦一个仍会让回车与空格触发展开
// 处理器定义在模块级而不是渲染内联，保证每次渲染拿到同一函数引用，减少无谓的子节点重渲染
// [失败路径] stopPropagation 只阻止冒泡、不阻止默认行为，因此不影响按钮自身的提交与聚焦
// [权衡] 用拦截而不是把操作区移出触发器：移出后布局要从两列改绝对定位，窄屏下会与长消息互相压盖
// 拦截只作用于这一组按钮，触发器本身的键盘展开仍可用，Tab 仍能停在整行上
const handleActionsClick = (e: React.MouseEvent) => e.stopPropagation();
const handleActionsKeyDown = (e: React.KeyboardEvent) => e.stopPropagation();

export const CommitActions = ({ className, children, ...props }: CommitActionsProps) => (
  <div
    className={cn("flex items-center gap-1", className)}
    onClick={handleActionsClick}
    onKeyDown={handleActionsKeyDown}
    role="group"
    {...props}
  >
    {children}
  </div>
);

export type CommitCopyButtonProps = ComponentProps<typeof Button> & {
  hash: string;
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CommitCopyButton = ({
  hash,
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CommitCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);

  // 第一道闸门检查运行环境与剪贴板能力：不在浏览器或缺少写入方法时直接走失败回调
  // [失败路径] 该分支不抛异常也不改状态，只调用 onError，调用方必须自己决定如何提示
  // 第二道闸门是成功标志：复制成功后的窗口期内再点无效，避免连续点击叠加多个复位定时器
  // 写剪贴板是异步的，await 之后再置成功态，保证图标切换代表真正写入完成
  // [并发] 依赖里带着成功标志，每次翻转都会重建回调；按钮拿到最新闭包，不会读到过期的成功值
  // onError 收到原始异常，组件不做文案包装，由调用方区分权限被拒与能力缺失
  // 定时器句柄存进 ref 而不是 state：写入它不应触发重渲染，卸载清理又要读到最新值
  // [权衡] 成功后不重置 timeout，重复点击被第二道闸门挡住；若要允许重复复制，必须先清旧定时器再排新的
  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(hash);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(() => setIsCopied(false), timeout);
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [hash, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      // [资源] 这是卸载清理，必须与设置定时器成对出现，否则组件卸载后仍会触发状态更新
      // 空依赖数组让清理只在真正卸载时执行，而不是每次重渲染都清一次
      // ref 初值为 0，从未复制时清的是一个无效句柄，属于安全的空操作
      // 清的是最近一次设置的句柄；正因为前面禁止重入，这里才不需要维护句柄集合
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("size-7 shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};

export type CommitContentProps = ComponentProps<typeof CollapsibleContent>;

export const CommitContent = ({ className, children, ...props }: CommitContentProps) => (
  <CollapsibleContent className={cn("border-t p-3", className)} {...props}>
    {children}
  </CollapsibleContent>
);

export type CommitFilesProps = HTMLAttributes<HTMLDivElement>;

export const CommitFiles = ({ className, children, ...props }: CommitFilesProps) => (
  <div className={cn("space-y-1", className)} {...props}>
    {children}
  </div>
);

export type CommitFileProps = HTMLAttributes<HTMLDivElement>;

export const CommitFile = ({ className, children, ...props }: CommitFileProps) => (
  <div
    className={cn(
      "flex items-center justify-between gap-2 rounded px-2 py-1 text-ui-base hover:bg-muted/50",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type CommitFileInfoProps = HTMLAttributes<HTMLDivElement>;

export const CommitFileInfo = ({ className, children, ...props }: CommitFileInfoProps) => (
  <div className={cn("flex min-w-0 items-center gap-2", className)} {...props}>
    {children}
  </div>
);

// 状态到颜色的映射集中在一处，标签表与它逐键对应，新增状态必须同时改两张表
// 每个条目都给出明暗两套色值：只写浅色会让暗色主题下的绿字落在深底上读不清
// 色相固定为绿增、红删、黄改、蓝重命名，与文件变更行的加减号颜色保持同一语义
// [权衡] 不用主题变量而用固定色阶，是为了四个状态在任何主题下都可区分；代价是换主题时要成对改这里
// [失败路径] 传入未列出的状态会取到 undefined，cn 忽略它从而退回继承色，标记变成无色的普通文字
// 状态联合类型与这两张表的键一致，编译器只在字面量层面保证不漏键，运行时仍依赖调用方传值合法
const fileStatusStyles = {
  added: "text-green-600 dark:text-green-400",
  deleted: "text-red-600 dark:text-red-400",
  modified: "text-yellow-600 dark:text-yellow-400",
  renamed: "text-blue-600 dark:text-blue-400",
};

const fileStatusLabels = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

export type CommitFileStatusProps = HTMLAttributes<HTMLSpanElement> & {
  status: "added" | "modified" | "deleted" | "renamed";
};

export const CommitFileStatus = ({
  status,
  className,
  children,
  ...props
}: CommitFileStatusProps) => (
  <span
    className={cn("font-medium font-mono text-ui-base", fileStatusStyles[status], className)}
    {...props}
  >
    {children ?? fileStatusLabels[status]}
  </span>
);

export type CommitFileIconProps = ComponentProps<typeof FileIcon>;

export const CommitFileIcon = ({ className, ...props }: CommitFileIconProps) => (
  <FileIcon className={cn("size-3.5 shrink-0 text-muted-foreground", className)} {...props} />
);

export type CommitFilePathProps = HTMLAttributes<HTMLSpanElement>;

export const CommitFilePath = ({ className, children, ...props }: CommitFilePathProps) => (
  <span className={cn("truncate font-mono text-ui-base", className)} {...props}>
    {children}
  </span>
);

export type CommitFileChangesProps = HTMLAttributes<HTMLDivElement>;

export const CommitFileChanges = ({ className, children, ...props }: CommitFileChangesProps) => (
  <div
    className={cn("flex shrink-0 items-center gap-1 font-mono text-ui-base", className)}
    {...props}
  >
    {children}
  </div>
);

export type CommitFileAdditionsProps = HTMLAttributes<HTMLSpanElement> & {
  count: number;
};

// 增删两个组件共用同一口径：计数不大于零就返回 null，节点整个不存在而不是渲染零
// [权衡] 返回 null 而非隐藏元素，让无增删的文件两侧不占宽度，路径能多显示几个字符
// 零与负数在这里不作区分：负数来自下游统计错误，同样不渲染，避免出现减号套减号的怪标记
// 图标与数字写在同一个 span 内，中间不插额外容器，纵向排列时与路径保持同一基线
// [失败路径] children 优先于默认内容，调用方自定义时不再追加图标与数字，需自行保证语义完整
// 颜色写在 span 上而不是图标上，图标继承文字色，暗色主题下两者不会分家
export const CommitFileAdditions = ({
  count,
  className,
  children,
  ...props
}: CommitFileAdditionsProps) => {
  if (count <= 0) {
    return null;
  }

  return (
    <span className={cn("text-green-600 dark:text-green-400", className)} {...props}>
      {children ?? (
        <>
          <PlusIcon className="inline-block size-3" />
          {count}
        </>
      )}
    </span>
  );
};

export type CommitFileDeletionsProps = HTMLAttributes<HTMLSpanElement> & {
  count: number;
};

export const CommitFileDeletions = ({
  count,
  className,
  children,
  ...props
}: CommitFileDeletionsProps) => {
  if (count <= 0) {
    return null;
  }

  return (
    <span className={cn("text-red-600 dark:text-red-400", className)} {...props}>
      {children ?? (
        <>
          <MinusIcon className="inline-block size-3" />
          {count}
        </>
      )}
    </span>
  );
};
