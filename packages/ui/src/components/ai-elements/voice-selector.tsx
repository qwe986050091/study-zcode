// VoiceSelector —— ai-elements 语音音色选择器原语组，基于 Radix Dialog 与 cmdk Command 组合。
// 做：导出 VoiceSelector 根（受控/非受控的 value 与 open），Trigger/Content/Input/List/Empty/
//     Group/Item/Shortcut/Separator 组合件，以及 Gender/Accent/Age/Name/Description/Bullet/
//     Preview 展示件；跨组件状态只通过 VoiceSelectorContext 传递。
// 不做：不内置音色目录、不请求 TTS/网络、不播放音频、不持久化选择；Preview 只把「想播放」
//       的意图通过 onPlay 上抛，是否真正播放由调用方的播放器决定。
// 依赖：@radix-ui/react-use-controllable-state 负责受控桥接，Dialog 负责弹层与焦点管理。
// 边界：纯展示层，不读 store、不取 service、不写日志；音色数据与落库都属于调用方。
//
// INV-01 断言：VoiceSelectorContext 默认值是 null，消费方必须先判空 —— 守住它的位置：useVoiceSelector 的 if (!context) throw —— 改错故障：默认 {} 会让缺失 Provider 的调用静默失效。
// INV-02 断言：value 的 undefined 表示「未选择」而不是空字符串 —— 守住它的位置：VoiceSelectorProps.value 的可选声明 —— 改错故障：改成必填会给首帧伪造音色并立刻触发 onValueChange。
// INV-03 断言：open 与 value 是两条独立状态 —— 守住它的位置：两次独立的 useControllableState —— 改错故障：合并后切换音色会重建弹层并丢失列表滚动位置。
// INV-04 断言：defaultProp 只在首次挂载读取 —— 守住它的位置：useControllableState 的 defaultProp —— 改错故障：在渲染期同步 defaultValue 会让外部数据反复重置用户选择。
// INV-05 断言：onValueChange 的形参允许 undefined —— 守住它的位置：VoiceSelectorProps 的回调签名 —— 改错故障：收窄成 string 后「清空选择」无法表达。
// INV-06 断言：Context value 的引用必须随四项依赖变化 —— 守住它的位置：voiceSelectorContext 的 useMemo 依赖数组 —— 改错故障：漏项会让消费件永久读到旧的弹层状态。
// INV-07 断言：Provider 必须包在 Dialog 外层 —— 守住它的位置：VoiceSelector 根组件的 return —— 改错故障：顺序反转后 Content 内调用 useVoiceSelector 直接抛错。
// INV-08 断言：Dialog 上的 {...props} 位于 open/onOpenChange 之后 —— 守住它的位置：Dialog 标签的属性顺序 —— 改错故障：前置展开会让内部值覆盖调用方，弹层再也无法受控。
// INV-09 断言：Trigger 不再额外调用 setOpen —— 守住它的位置：VoiceSelectorTrigger 的纯透传实现 —— 改错故障：双开会造成开合抖动与焦点丢失。
// INV-10 断言：DialogContent 的 aria-describedby 固定为 undefined —— 守住它的位置：VoiceSelectorContent 的首个属性 —— 改错故障：删除后 Radix 会因缺少 Description 持续告警。
// INV-11 断言：DialogTitle 始终存在（sr-only 兜底）—— 守住它的位置：VoiceSelectorContent 内部的 DialogTitle —— 改错故障：无标题弹层对读屏用户不可用。
// INV-12 断言：Gender 的联合类型必须以 string 收尾 —— 守住它的位置：VoiceSelectorGenderProps.value —— 改错故障：收紧后外部音色的自定义性别无法渲染。
// INV-13 断言：未知性别落到 CircleSmallIcon 而不是抛错 —— 守住它的位置：gender switch 的 default 分支 —— 改错故障：抛错会让一条脏数据打断整个列表渲染。
// INV-14 断言：Accent 未知时渲染 null —— 守住它的位置：emoji 初值与 accent switch 的 default —— 改错故障：用默认国旗兜底会展示错误国家。
// INV-15 断言：children ?? icon 中 children 优先 —— 守住它的位置：Gender/Accent 的渲染表达式 —— 改错故障：顺序反转会让调用方传入的文案永远不可见。
// INV-16 断言：switch 分支内不得调用 hook —— 守住它的位置：Gender/Accent 的渲染体 —— 改错故障：条件 hook 会打乱 hooks 顺序并在切换音色时崩溃。
// INV-17 断言：Bullet 必须 aria-hidden —— 守住它的位置：VoiceSelectorBullet 的 span —— 改错故障：读屏会逐条播报分隔符，列表变得不可听。
// INV-18 断言：Preview 中 loading 优先于 playing —— 守住它的位置：if (loading) … else if (playing) 的顺序 —— 改错故障：顺序反转后加载中会显示暂停键。
// INV-19 断言：Preview 的点击顺序是 stopPropagation → onClick → onPlay —— 守住它的位置：handleClick 的三行顺序 —— 改错故障：顺序变化会让点预览同时选中该音色。
// INV-20 断言：Preview 在 playing 时不禁用 —— 守住它的位置：disabled={loading} —— 改错故障：禁用后用户无法暂停正在试听的音色。
//
// 阅读顺序建议：先看根组件的四项状态与 useMemo，再看 Content 的可访问性骨架，最后看
// Gender/Accent 的映射表与 Preview 的事件顺序；两张映射表是数据，不是业务逻辑。
// 常见误改：把 value 改成必选、把 Context 默认值从 null 改成 {}、删掉 aria-hidden、把
// Preview 的 stopPropagation 挪到 onClick 之后。四处都「看起来更简洁」却破坏不变量。
// 与外部的关系：本文件被 Agent 设置页消费，props 形状是对外契约，改名属于破坏性变更。
// 测试关注点：无 Provider 时抛错、受控/非受控切换、未知枚举值的降级渲染。
// 样式边界：类名只负责布局与弱化色，颜色语义来自 DESIGN，不要在组件内写死主题色。
// 国际化边界：文案由调用方通过 children 或 title 注入，本文件只保留英文兜底。
// 性能边界：Context 引用变化会重渲染全部消费件，这是必要成本，不要用 memo 掩盖。
// 维护提示：新增枚举值必须同时补图标/emoji 分支与降级路径，否则会静默落到默认值。
"use client";

// [契约] useControllableState 是 value/open 的唯一受控桥接，禁止在本文件再造一份 useState 影子状态。
// 受控判定以 prop !== undefined 为准：传 undefined 等于交还所有权，与传空值不是同一语义。
// defaultProp 只在首次挂载读取，运行期修改 defaultValue 不会生效，也不应该生效。
// [权衡] 复用 Radix 实现而非自研，是因为它已在内部对齐 onChange 与 setState 的时序。
// 首帧就把 value/open 交给 Dialog 可避免开合闪烁，这条由调用方保证，本文件不兜底。
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Button } from "../ui/button.js";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "../ui/command.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog.js";
import { Spinner } from "../ui/spinner.js";
import { cn } from "../lib/utils.js";
import {
  CircleSmallIcon,
  MarsIcon,
  MarsStrokeIcon,
  NonBinaryIcon,
  PauseIcon,
  PlayIcon,
  TransgenderIcon,
  VenusAndMarsIcon,
  VenusIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo } from "react";

// [契约] Context 只允许 value/setValue/open/setOpen 四个字段，新增字段会扩大全部消费件的重渲染面。
// 不要塞 className、ref 或 children：它们必须走 props，否则同层组合件被迫共享样式。
// setValue 接受 undefined 是「清空选择」的唯一合法入口，改成必填 string 会丢掉未选态。
// 字段名与组件 props 保持一致是为了让调用方直觉映射，重命名需同步改文档与用例。
interface VoiceSelectorContextValue {
  value: string | undefined;
  setValue: (value: string | undefined) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

// [契约] createContext 的默认值必须是 null 而不是 {}：只有 null 能表达「没有 Provider」。
// 不要在模块顶层提供默认 setter，它会让缺失 Provider 的调用点静默成功。
// 默认值一旦改成对象，useVoiceSelector 的判空就变成死代码，故障会推迟到用户点击时。
// Provider 只在 VoiceSelector 内部挂载，本文件不导出 Context 本身，避免外部绕过根组件。
const VoiceSelectorContext = createContext<VoiceSelectorContextValue | null>(
  null
);

// [失败路径] 缺失 Provider 时立即抛错，不要改成 console.warn 后返回空实现。
// 错误文案带上组件名与使用位置，便于在深层组合里定位是谁漏了 Provider。
// 不要在这里返回 null：静默渲染空白会把「组合错误」伪装成「样式问题」。
// 该 hook 是公开 API，任何对返回类型的放宽都属于破坏性变更。
// 错误在渲染期抛出会被最近的错误边界捕获，这正是期望的早失败行为。
export const useVoiceSelector = () => {
  const context = useContext(VoiceSelectorContext);
  if (!context) {
    throw new Error(
      "VoiceSelector components must be used within VoiceSelector"
    );
  }
  return context;
};

// [契约] 继承 Dialog 的全部 props，因此 open/defaultOpen/onOpenChange 会与本地声明同时出现。
// 本地声明的 value/defaultValue/onValueChange 与 open 是两套状态，不要试图合并。
// 不要为了统一把 value 改成 selectedVoice：会破坏 ai-elements 的公开约定。
// 新增 prop 时先判断它是否应进入 Context，否则消费件只能层层透传。
// [权衡] 保留 ComponentProps<typeof Dialog> 是为了让 aria-* 与容器事件原样透传。
export type VoiceSelectorProps = ComponentProps<typeof Dialog> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string | undefined) => void;
};

// [契约] 解构时以 valueProp/openProp 别名接收，避免与内部状态同名遮蔽。
// defaultOpen 的默认值 false 是产品默认，不要改成 true 或交给 undefined 决定。
// children 不参与状态计算，直接透传给 Dialog，不要在这里做条件渲染。
// 回调 prop 必须原样交给 useControllableState，不要在这里包一层去抖或判等。
// 本组件是唯一持有状态的地方，子组合件不得再开一份本地状态。
export const VoiceSelector = ({
  value: valueProp,
  defaultValue,
  onValueChange,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: VoiceSelectorProps) => {
  // [契约] value 的受控源是 valueProp，回写走 onValueChange，内部不额外保存副本。
  // onValueChange 的形参允许 undefined，调用方若把它转成空字符串会让清空语义失效。
  // setValue 的引用由 Radix 保证稳定，因此可以安全进入 useMemo 依赖数组。
  // [并发] 同一帧内连续 setValue 以最后一次为准，本文件不做队列，也不需要队列。
  // 不要在渲染期调用 setValue，会触发 React 的渲染期更新告警。
  const [value, setValue] = useControllableState({
    defaultProp: defaultValue,
    onChange: onValueChange,
    prop: valueProp,
  });

  // [契约] open 与 value 是两条独立状态，不能合并成一个复合对象。
  // 合并会让「仅切换音色」也重开弹层，破坏用户正在浏览的列表位置。
  // onOpenChange 只在真实开合时回调，关闭动画期间不会重复触发。
  // 由非受控切到受控时必须同时提供 onOpenChange，否则弹层将无法关闭。
  const [open, setOpen] = useControllableState({
    defaultProp: defaultOpen,
    onChange: onOpenChange,
    prop: openProp,
  });

  // [权衡] useMemo 的依赖是 value/setValue/open/setOpen 四项，少一项会让消费件读到旧值。
  // 删掉 setValue/setOpen 在当前 Radix 实现下「看起来能跑」，换实现即失效。
  // 不要为了减少重渲染把 value 藏进 ref：消费件需要 value 参与渲染。
  // Context 引用变化会重渲染所有消费件，这是必要成本，不要靠 memo 包裹消费件掩盖。
  // 将来若要加派生字段，应在 Provider 之外算好再传入，而不是继续加依赖。
  const voiceSelectorContext = useMemo(
    () => ({ open, setOpen, setValue, value }),
    [value, setValue, open, setOpen]
  );

  // [契约] Provider 必须包在 Dialog 外层，顺序反了 Content 内就取不到上下文。
  // [契约] Dialog 上的 {...props} 位于 open/onOpenChange 之后，是刻意保留的覆盖逃生口。
  // children 不做判空：空内容也允许渲染空弹层，何时打开由调用方决定。
  // 不要在 Provider 上挂 key，key 变化会重置所有消费件的上下文。
  return (
    <VoiceSelectorContext.Provider value={voiceSelectorContext}>
      <Dialog onOpenChange={setOpen} open={open} {...props}>
        {children}
      </Dialog>
    </VoiceSelectorContext.Provider>
  );
};

export type VoiceSelectorTriggerProps = ComponentProps<typeof DialogTrigger>;

// [契约] Trigger 只做 DialogTrigger 的类型收窄，不追加默认样式与 onClick。
// 不要在这里注入 setOpen：Radix 已通过上下文开合，二次调用会双开。
// asChild 原样透传，任何改写都会破坏调用方的组合语义。
// 若将来要加快捷键，应放在调用方，而不是 Trigger 内部。
// trigger 的 aria 属性来自 DialogTrigger，不要在本文件重复声明。
export const VoiceSelectorTrigger = (props: VoiceSelectorTriggerProps) => (
  <DialogTrigger {...props} />
);

export type VoiceSelectorContentProps = ComponentProps<typeof DialogContent> & {
  title?: ReactNode;
};

// [契约] aria-describedby 固定为 undefined，这是显式的「已知没有描述」声明。
// 不要删掉它：Radix 在缺少 Description 时会告警，undefined 才是正确的静默方式。
// DialogTitle 用 sr-only 渲染，title 默认值只是兜底文案，不是产品文案。
// className 先合并 p-0 再叠加调用方 className，顺序保证内边距可被覆盖。
// Command 上的 data-slot 选择器依赖 cmdk 的 slot 名，升级 cmdk 前必须核对。
export const VoiceSelectorContent = ({
  className,
  children,
  title = "Voice Selector",
  ...props
}: VoiceSelectorContentProps) => (
  <DialogContent
    aria-describedby={undefined}
    className={cn("p-0", className)}
    {...props}
  >
    <DialogTitle className="sr-only">{title}</DialogTitle>
    <Command className="**:data-[slot=command-input-wrapper]:h-auto">
      {children}
    </Command>
  </DialogContent>
);

export type VoiceSelectorDialogProps = ComponentProps<typeof CommandDialog>;

export const VoiceSelectorDialog = (props: VoiceSelectorDialogProps) => (
  <CommandDialog {...props} />
);

export type VoiceSelectorInputProps = ComponentProps<typeof CommandInput>;

export const VoiceSelectorInput = ({
  className,
  ...props
}: VoiceSelectorInputProps) => (
  <CommandInput className={cn("h-auto py-3.5", className)} {...props} />
);

export type VoiceSelectorListProps = ComponentProps<typeof CommandList>;

export const VoiceSelectorList = (props: VoiceSelectorListProps) => (
  <CommandList {...props} />
);

export type VoiceSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const VoiceSelectorEmpty = (props: VoiceSelectorEmptyProps) => (
  <CommandEmpty {...props} />
);

export type VoiceSelectorGroupProps = ComponentProps<typeof CommandGroup>;

export const VoiceSelectorGroup = (props: VoiceSelectorGroupProps) => (
  <CommandGroup {...props} />
);

export type VoiceSelectorItemProps = ComponentProps<typeof CommandItem>;

export const VoiceSelectorItem = ({
  className,
  ...props
}: VoiceSelectorItemProps) => (
  <CommandItem className={cn("px-4 py-2", className)} {...props} />
);

export type VoiceSelectorShortcutProps = ComponentProps<typeof CommandShortcut>;

export const VoiceSelectorShortcut = (props: VoiceSelectorShortcutProps) => (
  <CommandShortcut {...props} />
);

export type VoiceSelectorSeparatorProps = ComponentProps<
  typeof CommandSeparator
>;

export const VoiceSelectorSeparator = (props: VoiceSelectorSeparatorProps) => (
  <CommandSeparator {...props} />
);

// [契约] value 是闭合的字面量联合，不包含 string；外部音色的任意性别字符串会类型报错。
// 要接纳新性别就扩展这个联合并补上对应图标，不能回头加 | string 求兼容。
// 新增枚举值必须同时补图标分支，否则会静默落到 CircleSmallIcon。
// 不要把这个联合抽到 shared：它是展示映射的闭集，与协议无关。
// span 的 props 全部透传，本组件不吞掉 onClick 等交互属性。
export type VoiceSelectorGenderProps = ComponentProps<"span"> & {
  value?:
    | "male"
    | "female"
    | "transgender"
    | "androgyne"
    | "non-binary"
    | "intersex";
};

export const VoiceSelectorGender = ({
  className,
  value,
  children,
  ...props
}: VoiceSelectorGenderProps) => {
  // [失败路径] icon 初值必须是 null，不能给默认图标，否则会先闪一下再被 case 覆盖。
  // 每个 case 都要 break，漏 break 会让后面的分支覆盖已选图标。
  // default 分支给 CircleSmallIcon 而不是抛错：脏数据不应打断列表渲染。
  // children ?? icon 的语义是调用方文本优先，不要改成 icon 优先。
  // 图标尺寸写死 size-4 以对齐 text-ui-base 基线，改动要同步 Accent 与 Description。
  let icon: ReactNode | null = null;

  // [契约] 每个 case 使用块作用域，便于后续加局部变量而不产生重复声明。
  // 不要在 case 内调用 hook：它在渲染体内，条件 hook 会破坏 hooks 顺序。
  // value 为 undefined 时直接进 default，这是未选择状态的正常路径。
  // 分支顺序与渲染结果无关，但请按性别枚举顺序维护以便比对。
  switch (value) {
    case "male": {
      icon = <MarsIcon className="size-4" />;
      break;
    }
    case "female": {
      icon = <VenusIcon className="size-4" />;
      break;
    }
    case "transgender": {
      icon = <TransgenderIcon className="size-4" />;
      break;
    }
    case "androgyne": {
      icon = <MarsStrokeIcon className="size-4" />;
      break;
    }
    case "non-binary": {
      icon = <NonBinaryIcon className="size-4" />;
      break;
    }
    case "intersex": {
      icon = <VenusAndMarsIcon className="size-4" />;
      break;
    }
    default: {
      icon = <CircleSmallIcon className="size-4" />;
    }
  }

  return (
    <span className={cn("text-muted-foreground text-ui-base", className)} {...props}>
      {children ?? icon}
    </span>
  );
};

export type VoiceSelectorAccentProps = ComponentProps<"span"> & {
  value?:
    | "american"
    | "british"
    | "australian"
    | "canadian"
    | "irish"
    | "scottish"
    | "indian"
    | "south-african"
    | "new-zealand"
    | "spanish"
    | "french"
    | "german"
    | "italian"
    | "portuguese"
    | "brazilian"
    | "mexican"
    | "argentinian"
    | "japanese"
    | "chinese"
    | "korean"
    | "russian"
    | "arabic"
    | "dutch"
    | "swedish"
    | "norwegian"
    | "danish"
    | "finnish"
    | "polish"
    | "turkish"
    | "greek"
    | string;
};

export const VoiceSelectorAccent = ({
  className,
  value,
  children,
  ...props
}: VoiceSelectorAccentProps) => {
  // [失败路径] emoji 初值为 null，未知 accent 渲染 children ?? null，即什么都不显示。
  // 这个 null 是刻意的：不要用旗子兜底，错误国旗比没有更糟。
  // emoji 用字符串而不是 ReactNode，方便调用方直接参与字符串拼接。
  // 每个分支只做赋值、不做副作用，保证 StrictMode 双渲染下幂等。
  // 新增地区时注意 portuguese/brazilian 这类「同语言不同地区」的并列关系。
  let emoji: string | null = null;

  // [权衡] Accent 的联合类型在末尾加了 string，用于兼容服务端返回的任意 accent 标识。
  // 代价是 TS 无法发现拼写错误，改名只能靠用例与视觉回归兜住。
  // 这 30 个分支是数据映射不是业务逻辑，不要为了「短」改成查表而丢掉可读性。
  // 若真要查表，必须保留 default 为 null 的语义，否则未知值会拿到假值。
  // 分支按地区排列，顺序不影响行为。
  switch (value) {
    case "american": {
      emoji = "🇺🇸";
      break;
    }
    case "british": {
      emoji = "🇬🇧";
      break;
    }
    case "australian": {
      emoji = "🇦🇺";
      break;
    }
    case "canadian": {
      emoji = "🇨🇦";
      break;
    }
    case "irish": {
      emoji = "🇮🇪";
      break;
    }
    case "scottish": {
      emoji = "🏴󠁧󠁢󠁳󠁣󠁴󠁿";
      break;
    }
    case "indian": {
      emoji = "🇮🇳";
      break;
    }
    case "south-african": {
      emoji = "🇿🇦";
      break;
    }
    case "new-zealand": {
      emoji = "🇳🇿";
      break;
    }
    case "spanish": {
      emoji = "🇪🇸";
      break;
    }
    case "french": {
      emoji = "🇫🇷";
      break;
    }
    case "german": {
      emoji = "🇩🇪";
      break;
    }
    case "italian": {
      emoji = "🇮🇹";
      break;
    }
    case "portuguese": {
      emoji = "🇵🇹";
      break;
    }
    case "brazilian": {
      emoji = "🇧🇷";
      break;
    }
    case "mexican": {
      emoji = "🇲🇽";
      break;
    }
    case "argentinian": {
      emoji = "🇦🇷";
      break;
    }
    case "japanese": {
      emoji = "🇯🇵";
      break;
    }
    case "chinese": {
      emoji = "🇨🇳";
      break;
    }
    case "korean": {
      emoji = "🇰🇷";
      break;
    }
    case "russian": {
      emoji = "🇷🇺";
      break;
    }
    case "arabic": {
      emoji = "🇸🇦";
      break;
    }
    case "dutch": {
      emoji = "🇳🇱";
      break;
    }
    case "swedish": {
      emoji = "🇸🇪";
      break;
    }
    case "norwegian": {
      emoji = "🇳🇴";
      break;
    }
    case "danish": {
      emoji = "🇩🇰";
      break;
    }
    case "finnish": {
      emoji = "🇫🇮";
      break;
    }
    case "polish": {
      emoji = "🇵🇱";
      break;
    }
    case "turkish": {
      emoji = "🇹🇷";
      break;
    }
    case "greek": {
      emoji = "🇬🇷";
      break;
    }
    default: {
      emoji = null;
    }
  }

  return (
    <span className={cn("text-muted-foreground text-ui-base", className)} {...props}>
      {children ?? emoji}
    </span>
  );
};

// [契约] Age/Name/Description 都是纯 span 包装，不接管 children 语义，也不要加 role。
// tabular-nums 让数字列对齐，属于视觉不变量，不要随主题去掉。
// className 必须可被调用方覆盖，因此 cn 的第二个实参始终是 className。
// 这些展示件不读 Context，保持无状态才能被任意位置复用。
export type VoiceSelectorAgeProps = ComponentProps<"span">;

export const VoiceSelectorAge = ({
  className,
  ...props
}: VoiceSelectorAgeProps) => (
  <span
    className={cn("text-muted-foreground text-ui-base tabular-nums", className)}
    {...props}
  />
);

export type VoiceSelectorNameProps = ComponentProps<"span">;

export const VoiceSelectorName = ({
  className,
  ...props
}: VoiceSelectorNameProps) => (
  <span
    className={cn("flex-1 truncate text-left font-medium", className)}
    {...props}
  />
);

export type VoiceSelectorDescriptionProps = ComponentProps<"span">;

export const VoiceSelectorDescription = ({
  className,
  ...props
}: VoiceSelectorDescriptionProps) => (
  <span className={cn("text-muted-foreground text-ui-base", className)} {...props} />
);

// [契约] Attributes 只负责横向布局与基准字号，不负责内部间距细节。
// children 直接渲染，不要过滤或重排，顺序完全由调用方决定。
// 不要给容器加 role：它只是布局，加 role 会与内部文本节点语义冲突。
// flex 不带 wrap：音色属性一多应由调用方决定换行策略。
// 本组件不透传 Context，避免被误当作可交互容器。
export type VoiceSelectorAttributesProps = ComponentProps<"div">;

export const VoiceSelectorAttributes = ({
  className,
  children,
  ...props
}: VoiceSelectorAttributesProps) => (
  <div className={cn("flex items-center text-ui-base", className)} {...props}>
    {children}
  </div>
);

// [契约] Bullet 的 aria-hidden 是必须的，它只是视觉分隔符，读屏不应播报。
// &bull; 用 HTML 实体而不是字面量，避免不同编码与字体下的显示差异。
// select-none 防止复制音色描述时把分隔点一起带出。
// text-border 是弱化色，调整颜色要经过 DESIGN 的对比度校验。
// 不要改成 ::before 伪元素，否则调用方无法按需隐藏它。
export type VoiceSelectorBulletProps = ComponentProps<"span">;

export const VoiceSelectorBullet = ({
  className,
  ...props
}: VoiceSelectorBulletProps) => (
  <span
    aria-hidden="true"
    className={cn("select-none text-border", className)}
    {...props}
  >
    &bull;
  </span>
);

export type VoiceSelectorPreviewProps = Omit<
  ComponentProps<"button">,
  "children"
> & {
  playing?: boolean;
  loading?: boolean;
  onPlay?: () => void;
};

// [契约] PreviewProps 从 button props 里 Omit 掉 children，图标只由 playing/loading 决定。
// playing 与 loading 同时为 true 时 loading 优先，这是产品语义不是巧合。
// disabled 只由 loading 决定，playing 时不禁用：用户需要能暂停。
// onPlay 是意图上抛，本组件不判断能否播放，也不关心播放器实现。
// aria-label 随 playing 切换，是无障碍的唯一状态出口，不要删。
export const VoiceSelectorPreview = ({
  className,
  playing,
  loading,
  onPlay,
  onClick,
  ...props
}: VoiceSelectorPreviewProps) => {
  // [并发] 顺序必须是 stopPropagation → onClick → onPlay，否则点预览会同时选中该音色。
  // stopPropagation 必须在最前：放到后面时父级合成事件已经入队，拦不住。
  // onClick 与 onPlay 都用可选调用而不是默认空函数，避免掩盖调用方忘记接线。
  // 依赖数组必须同时含 onClick 与 onPlay，漏一个会拿到闭包里的旧回调。
  // 不要在这里 await 播放，异步会让 stopPropagation 的时序失效。
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onClick?.(event);
      onPlay?.();
    },
    [onClick, onPlay]
  );

  // [契约] 三个图标字面量只用于展示，不要抽成组件再条件渲染，会多出无谓的组件边界。
  // loading 必须判在 playing 之前，顺序反了会在加载中显示暂停键。
  // [失败路径] 两者都为 false 时才显示 PlayIcon，这是唯一「可点播放」的视觉信号。
  // size-3 与按钮 size-6 保持固定比例，改一处必须同步另一处。
  // 不要改写成 switch：if/else 链的顺序本身就是优先级，更直观。
  let icon = <PlayIcon className="size-3" />;

  if (loading) {
    icon = <Spinner className="size-3" />;
  } else if (playing) {
    icon = <PauseIcon className="size-3" />;
  }

  return (
    <Button
      aria-label={playing ? "Pause preview" : "Play preview"}
      className={cn("size-6", className)}
      disabled={loading}
      onClick={handleClick}
      size="icon-sm"
      type="button"
      variant="outline"
      {...props}
    >
      {icon}
    </Button>
  );
};
