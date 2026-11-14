// INV-01 [契约] 文件首行的 "use client" 指令必须保留并置于最前；守住位置：第 1 行指令与下方的 useContext、useMemo 调用；改错故障：组件被当作服务端组件执行，createContext 与 hooks 在服务端渲染阶段直接抛错。
// INV-02 [契约] ChangeType 联合类型是样式与图标映射的唯一键空间；守住位置：ChangeType 定义与 changeTypeStyles、changeTypeIcons 两张 Record；改错故障：新增取值却漏补映射，索引得到 undefined，徽章失去配色与图标。
// INV-03 [并发] 上下文值必须经 useMemo 缓存且四个依赖齐全；守住位置：PackageInfo 里 useMemo 的依赖数组 changeType、currentVersion、name、newVersion；改错故障：漏掉某个版本字段，父级更新后下游仍渲染旧版本号。
// INV-04 [契约] 上下文默认值只允许 name 为空串，其余三个字段保持 undefined；守住位置：createContext 的初始对象；改错故障：默认值填入版本或变更类型，脱离 Provider 的组件会渲染并不存在的假数据。
// INV-05 [失败路径] 没有 changeType 时 PackageInfoChangeType 直接返回 null；守住位置：组件体内的 if (!changeType) 早退；改错故障：继续渲染 Badge 并对映射取 undefined，出现没有文字和颜色的空徽章。
// INV-06 [事务] 版本区守卫必须先同时检查两个版本，再决定是否渲染 children；守住位置：if (!(currentVersion || newVersion)) 这一行；改错故障：把 children 提到守卫之前，只传自定义 children 时整块版本区被吞掉。
// INV-07 [契约] 名称展示用空值合并决定 children 与 name 的优先级；守住位置：PackageInfoName 的 children ?? name 表达式；改错故障：换成逻辑或后，调用方传入空字符串会被上下文名称顶替，无法主动清空。
// INV-08 [契约] 版本箭头只在旧新版本同时存在时出现；守住位置：PackageInfoVersion 默认内容里 currentVersion 与 newVersion 同时为真的分支；改错故障：单侧版本也画箭头，界面暗示一次并不存在的升级。
// INV-09 [契约] 新版本必须用 font-medium 与 text-foreground 提亮，旧版本继承容器 muted 色；守住位置：PackageInfoVersion 中两个 span 的类名分工；改错故障：两端同色，用户无法一眼分辨目标版本。
// INV-10 [权衡] changeTypeStyles 必须覆盖全部五个取值并同时保留浅色与深色两套；守住位置：Record 映射的键集合；改错故障：删掉任一键后该类型徽章退回 Badge 默认底色，深色主题下几乎不可见。
// INV-11 [契约] changeTypeIcons 与样式映射同键同量，added 与 removed 各有独立图标；守住位置：PackageInfoChangeType 对 changeTypeIcons 的索引与这两个键；改错故障：漏键时图标位为空，gap-1 仍占位，徽章文字出现偏移。
// INV-12 [契约] 每个根节点的 className 都先并入 cn 的基础类再展开 props；守住位置：各组件 className={cn("...", className)} 与紧随其后的 {...props}；改错故障：改成字符串拼接或调换展开顺序，调用方的 padding 与基础 p-4 冲突且无法被 tailwind 合并。
// INV-13 [契约] Provider 必须包住容器 div，保证默认组合里的子组件能读到上下文；守住位置：PackageInfo 返回的 PackageInfoContext.Provider 层级；改错故障：Provider 移到 div 内部或 children 之后，PackageInfoName 读到空名字。
// INV-14 [权衡] 默认组合在 Header 与版本位置各做一次条件渲染，与子组件守卫形成双保险；守住位置：children 缺省分支里的 changeType 与版本条件；改错故障：去掉外层条件后完全依赖内层守卫，任一守卫调整就会在头部留下空节点或多余间距。
// INV-15 [失败路径] 组件允许脱离 Provider 单独使用，但此时只能显示显式 children；守住位置：默认上下文的空 name 与 PackageInfoName 的回落；改错故障：把 name 当成必有值，独立使用时图标旁出现空白标签。
// INV-16 [契约] 依赖项的版本列按真值决定是否渲染；守住位置：PackageInfoDependency 内 version 条件片段；改错故障：改为判 undefined 后空串会渲染出空 span，两端对齐被撑出不可见占位。
// INV-17 [契约] Dependencies 标题目前是硬编码英文，转多语言时须与整体文案策略统一；守住位置：PackageInfoDependencies 的 span 文本；改错故障：只在这一处接入翻译而其余卡片部件仍写死英文，同一张卡出现中英混排。
// INV-18 [资源] 本文件只做 props 到视图的投影，不持有状态，也不发起订阅或计时器；守住位置：全部组件体除 useMemo 外没有任何 hook；改错故障：引入内部 state 复制版本或变更类型，外部更新与内部副本不同步。
//
// 模块职责：package-info 卡片族的无状态展示层，用 PackageInfoContext 把名称、新旧版本与变更类型下发给 Header、Name、ChangeType、Version 等子组件。
// 状态所有权：唯一状态是 PackageInfo 用 useMemo 生成的上下文对象，来源全部是 props；子组件只读取，不写回，也不缓存派生结果。
// 阅读顺序：先看类型与默认上下文，再读两张 Record 映射和三个带早退的展示组件，最后沿 PackageInfo 的 Provider 与默认组合理解整卡拼装。
"use client";

// 导入分三类：ui 包内的 Badge 与 cn、lucide 的四个图标，以及 react 的类型与 hooks。
// [契约] HTMLAttributes 走 type 导入，编译后消失，不会把 react 类型模块带进运行时。
// createContext、useContext、useMemo 构成全部运行时依赖，文件没有 effect、ref 或事件订阅。
// PackageIcon 标记名称行，PlusIcon 与 MinusIcon 分别表达新增和移除，ArrowRightIcon 表达版本递进。
// [权衡] 图标与徽章复用既有组件，不在此处手写颜色和 svg，深色主题由组件的 dark 变体统一承接。
import { Badge } from "../ui/badge.js";
import { cn } from "../lib/utils.js";
import { ArrowRightIcon, MinusIcon, PackageIcon, PlusIcon } from "lucide-react";
import type { HTMLAttributes } from "react";
import { createContext, useContext, useMemo } from "react";

// ChangeType 把语义版本的三档 major、minor、patch 与生命周期两态 added、removed 放进同一联合类型。
// 五个取值同时决定样式、图标与兜底文案，是两张 Record 必须穷举的键集合。
// PackageInfoContextType 里 name 必填，currentVersion、newVersion、changeType 可选，对应只显示名称的最小卡片。
// [契约] 上下文字段与 PackageInfoProps 同名，Provider 直接平移 props，不改名也不再包装一层。
// createContext 的默认对象只有空字符串 name，三个可选字段保持 undefined，作为脱离 Provider 时的安全兜底。
// [权衡] changeType 不给默认值，缺少变更信息时徽章整体不出现，而不是退化成中性的补丁标签。
type ChangeType = "major" | "minor" | "patch" | "added" | "removed";

interface PackageInfoContextType {
  name: string;
  currentVersion?: string;
  newVersion?: string;
  changeType?: ChangeType;
}

const PackageInfoContext = createContext<PackageInfoContextType>({
  name: "",
});

export type PackageInfoHeaderProps = HTMLAttributes<HTMLDivElement>;

// PackageInfoHeader 是横向容器，用 justify-between 把名称与变更徽章推到两端，gap-2 控制最小间距。
// PackageInfoDescription 直接渲染段落，只加顶部间距与 muted 文字色，不加截断或行数限制。
// PackageInfoContent 用上边框加内边距划分正文区，与头部之间靠 mt-3 与 pt-3 形成视觉分隔。
// PackageInfoDependencies 以 space-y-2 组织标题与列表，内层 space-y-1 收紧依赖项之间的行距。
// PackageInfoDependency 是两端对齐的一行，名称靠左用等宽 muted 色，版本靠右可选渲染。
// [契约] 这一组包装组件都把 children 直接交给调用方，既不补文案也不校验内容，空 children 渲染成空容器。
export const PackageInfoHeader = ({
  className,
  children,
  ...props
}: PackageInfoHeaderProps) => (
  <div
    className={cn("flex items-center justify-between gap-2", className)}
    {...props}
  >
    {children}
  </div>
);

export type PackageInfoNameProps = HTMLAttributes<HTMLDivElement>;

export const PackageInfoName = ({
  className,
  children,
  ...props
}: PackageInfoNameProps) => {
  // 从上下文只取 name，组件本身不接收 name 属性，因此名称的唯一来源是 Provider 或显式 children。
  // PackageIcon 固定 size-4 与 muted 色，作为名称的视觉锚点，不随卡片尺寸变化。
  // 文本用 font-mono 展示包名，与版本区的等宽字体保持一致，便于逐字符比对名称。
  // [契约] children 与 name 用空值合并取舍，传入空字符串时保持空白，不会被上下文名称顶替。
  // [失败路径] 脱离 Provider 且不传 children 时渲染空标签，只剩图标，这是默认上下文 name 为空串的直接结果。
  const { name } = useContext(PackageInfoContext);

  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      <PackageIcon className="size-4 text-muted-foreground" />
      <span className="font-medium font-mono text-ui-base">{children ?? name}</span>
    </div>
  );
};

// changeTypeStyles 把五种变更映射到浅色底加深色文字，并为每种补一组 dark 变体。
// [契约] 两个映射都是 Record<ChangeType, ...>，键集合必须与联合类型完全一致，缺键会先被类型检查拦住。
// added 用蓝色、removed 用灰色，major 红、minor 黄、patch 绿，颜色语义不与语义版本等级混用。
// changeTypeIcons 中 added 用加号、removed 用减号，其余三档共用右箭头，只表达前进方向。
// [权衡] 颜色与图标分表维护而不是放进一个对象，新增取值时能分别决定是否复用图标。
const changeTypeStyles: Record<ChangeType, string> = {
  added: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  major: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  minor:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  patch: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  removed: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
};

const changeTypeIcons: Record<ChangeType, React.ReactNode> = {
  added: <PlusIcon className="size-3" />,
  major: <ArrowRightIcon className="size-3" />,
  minor: <ArrowRightIcon className="size-3" />,
  patch: <ArrowRightIcon className="size-3" />,
  removed: <MinusIcon className="size-3" />,
};

export type PackageInfoChangeTypeProps = HTMLAttributes<HTMLDivElement>;

export const PackageInfoChangeType = ({
  className,
  children,
  ...props
}: PackageInfoChangeTypeProps) => {
  const { changeType } = useContext(PackageInfoContext);

  // [失败路径] 守卫先于任何渲染，changeType 缺失时返回 null，连 Badge 外壳都不会进入 DOM。
  // children 优先于 changeType 文本，允许调用方覆盖徽章文案，但仍沿用同一套配色与图标。
  // Badge 使用 secondary 变体与 capitalize，把英文枚举值首字母转成大写展示。
  // [契约] className 先并入 gap-1、text-ui-base 与类型样式，再展开 props，调用方只能追加不能抹掉基础类。
  // [权衡] 徽章不参与版本区布局，始终挂在 Header 右侧，与版本行分开，避免窄宽度下相互挤压。
  if (!changeType) {
    return null;
  }

  return (
    <Badge
      className={cn(
        "gap-1 text-ui-base capitalize",
        changeTypeStyles[changeType],
        className
      )}
      variant="secondary"
      {...props}
    >
      {changeTypeIcons[changeType]}
      {children ?? changeType}
    </Badge>
  );
};

export type PackageInfoVersionProps = HTMLAttributes<HTMLDivElement>;

export const PackageInfoVersion = ({
  className,
  children,
  ...props
}: PackageInfoVersionProps) => {
  const { currentVersion, newVersion } = useContext(PackageInfoContext);

  // [事务] 入口守卫要求新旧版本至少有一个，两者皆空时整块版本区不渲染，也不会渲染自定义 children。
  // 容器用 mt-2 与名称行拉开距离，font-mono 与 muted 色沿用信息行的次级文字层级。
  // 旧版本是普通 span，新版本额外用 font-medium 与 text-foreground 提亮，形成从前到后的视觉递进。
  // [契约] 箭头只在旧新版本同时存在时出现，单侧版本不画箭头，避免暗示不存在的变更关系。
  // 默认内容由调用方 children 整体替换，替换后容器类名仍在，间距与字体保持不变。
  // [失败路径] 只传 newVersion 时左侧没有旧版本节点，箭头同样不出现，用户看到的是单值而非对比。
  if (!(currentVersion || newVersion)) {
    return null;
  }

  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-2 font-mono text-muted-foreground text-ui-base",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {currentVersion && <span>{currentVersion}</span>}
          {currentVersion && newVersion && (
            <ArrowRightIcon className="size-3" />
          )}
          {newVersion && (
            <span className="font-medium text-foreground">{newVersion}</span>
          )}
        </>
      )}
    </div>
  );
};

export type PackageInfoProps = HTMLAttributes<HTMLDivElement> & {
  name: string;
  currentVersion?: string;
  newVersion?: string;
  changeType?: ChangeType;
};

// 这里把 name、currentVersion、newVersion、changeType 原样交给 useMemo，生成唯一的上下文值对象。
// [并发] 依赖数组必须列全四个字段，漏项会让下游拿到旧上下文，版本或徽章停留在上一次渲染。
// Provider 包住外层 div，任何层级的子组件都能读到上下文，而外层 div 负责圆角、边框、背景与内边距。
// [契约] children 缺省时才拼默认结构：Header 内放名称与可选徽章，其下按需放版本行。
// 默认组合里两处条件与子组件自身守卫重复，外层先挡住就不会产生空节点，内层再挡一次保证单独使用时同样干净。
// [权衡] 卡片不自带标题与关闭按钮，交互与容器语义全部交给调用方，保持 ai-elements 展示组件的纯粹性。
export const PackageInfo = ({
  name,
  currentVersion,
  newVersion,
  changeType,
  className,
  children,
  ...props
}: PackageInfoProps) => {
  const contextValue = useMemo(
    () => ({ changeType, currentVersion, name, newVersion }),
    [changeType, currentVersion, name, newVersion]
  );

  return (
    <PackageInfoContext.Provider value={contextValue}>
      <div
        className={cn("rounded-lg border bg-background p-4", className)}
        {...props}
      >
        {children ?? (
          <>
            <PackageInfoHeader>
              <PackageInfoName />
              {changeType && <PackageInfoChangeType />}
            </PackageInfoHeader>
            {(currentVersion || newVersion) && <PackageInfoVersion />}
          </>
        )}
      </div>
    </PackageInfoContext.Provider>
  );
};

export type PackageInfoDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const PackageInfoDescription = ({
  className,
  children,
  ...props
}: PackageInfoDescriptionProps) => (
  <p className={cn("mt-2 text-muted-foreground text-ui-base", className)} {...props}>
    {children}
  </p>
);

export type PackageInfoContentProps = HTMLAttributes<HTMLDivElement>;

export const PackageInfoContent = ({
  className,
  children,
  ...props
}: PackageInfoContentProps) => (
  <div className={cn("mt-3 border-t pt-3", className)} {...props}>
    {children}
  </div>
);

export type PackageInfoDependenciesProps = HTMLAttributes<HTMLDivElement>;

export const PackageInfoDependencies = ({
  className,
  children,
  ...props
}: PackageInfoDependenciesProps) => (
  <div className={cn("space-y-2", className)} {...props}>
    <span className="font-medium text-muted-foreground text-ui-base uppercase tracking-wide">
      Dependencies
    </span>
    <div className="space-y-1">{children}</div>
  </div>
);

export type PackageInfoDependencyProps = HTMLAttributes<HTMLDivElement> & {
  name: string;
  version?: string;
};

export const PackageInfoDependency = ({
  name,
  version,
  className,
  children,
  ...props
}: PackageInfoDependencyProps) => (
  <div
    className={cn("flex items-center justify-between text-ui-base", className)}
    {...props}
  >
    {children ?? (
      <>
        <span className="font-mono text-muted-foreground">{name}</span>
        {version && <span className="font-mono text-ui-base">{version}</span>}
      </>
    )}
  </div>
);
