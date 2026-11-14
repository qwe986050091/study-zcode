// INV-01 每个导出组件都必须保持纯透传，守住位置是各自的函数签名与展开属性的先后；改错故障是组件内偷偷持有开关状态，与外部受控值互相打架。
// INV-02 无障碍描述必须显式置空且写在展开属性之前，守住位置是 aria-describedby 与 {...props} 的行序；改错故障是调用方再也无法补回描述。
// INV-03 弹层标题节点必须无条件渲染，守住位置是内容组件里的标题那一行；改错故障是读屏打开弹层时只能听到「对话框」而读不出名称。
// INV-04 标题必须带视觉隐藏类，守住位置是标题元素的 className；改错故障是标题文字挤进命令面板，把首行输入框往下顶。
// INV-05 标题默认值必须保留，守住位置是解构参数里的默认值；改错故障是调用方不传标题时渲染空节点，无障碍名称退化为空串。
// INV-06 搜索状态根只能有一个，守住位置是内容组件内唯一的命令根节点；改错故障是出现两个过滤源，高亮索引与结果列表各走一套。
// INV-07 外部样式必须排在拼接参数的后位，守住位置是每个组件的 cn 调用参数顺序；改错故障是内置类覆盖掉调用方传入的定制样式。
// INV-08 品牌图地址必须由供应商名推导，守住位置是图标组件的 src 表达式；改错故障是外部可传入任意地址，图片与替代文本所述品牌不符。
// INV-09 替代文本必须包含供应商名，守住位置是图标组件的 alt 表达式；改错故障是读屏用户听到一串相同描述，无法区分不同模型来源。
// INV-10 图标必须固定宽高，守住位置是图片元素的 width 与 height 属性；改错故障是加载前后行高抖动，整个列表在图片到达瞬间跳动。
// INV-11 图标容器必须禁止收缩，守住位置是 LogoGroup 的收缩禁用类；改错故障是窄侧栏下轮播图标被压扁成椭圆。
// INV-12 图标叠放必须用负间距，守住位置是组容器上的负向间距类；改错故障是图标之间露出背景缝隙，叠压层次错乱。
// INV-13 供应商联合必须保留宽松兜底分支，守住位置是类型末尾的宽字符串分支；改错故障是新供应商必须改库才能用，或旧代码被类型错误挡住。
// INV-14 图标属性类型必须排除地址与替代文本，守住位置是 Logo 的 Omit 声明；改错故障是调用方可传任意图片，造成图文错配。
// INV-15 任何组件都不得缓存过滤结果，守住位置是所有组件体内均无状态声明；改错故障是列表里残留上一次搜索命中的过期项。
// INV-16 空态插槽不得承载加载中内容，守住位置是空态组件的使用约定；改错故障是请求尚未返回就闪现「无匹配」，用户误以为搜索失败。
// INV-17 分隔符必须复用底座实现，守住位置是分隔符组件的透传写法；改错故障是自绘线条不参与键盘项计数，方向键在两段之间跳空。
// INV-18 名称必须单行截断且左对齐，守住位置是名称组件的伸缩与截断类；改错故障是超长模型名撑破行宽，把右侧图标挤出可视区。
//
// 模块职责：把对话弹层、命令面板、品牌图标与名称拼成一组无状态的选择器外壳，供上层自由装配模型列表。
// 状态所有权：开关、搜索词与高亮索引分别由对话底座与命令根持有，本文件不声明任何本地状态，也不派发副作用。
// 阅读顺序：先看属性与外壳组件理解契约，再看内容组合与命令根，最后看图标、名称等纯展示件与样式约定。
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
import { cn } from "../lib/utils.js";
import type { ComponentProps, ReactNode } from "react";

// 受控归属：开关与关闭事件全部来自调用方，本组件不复制一份内部开关状态。
// ModelSelectorProps 由 ConversationProps 派生，底座新增属性会自动透出，无需维护白名单。
// [权衡] 若在此层加内部开关以便自管理，会出现外部受控值与内部值短暂不一致，动画与重置时机错位。
// [失败路径] 若改成手写最小属性集，调用方传入的关闭回调被静默丢弃，弹层只能开不能按预期关。
// 所以 ModelSelectorProps 属于对话层契约，而不是展示层契约——改展示不应改它。
export type ModelSelectorProps = ComponentProps<typeof Dialog>;

// 纯透传外壳：不持状态、不注册副作用，输出完全由调用方传入的属性决定。
// [并发] 因为没有内部状态，父级重渲染必然穿透到这一层，成本仅一次元素创建，无需额外缓存包装。
// 对话层消失时整棵子树卸载，search 与 highlightedIndex 随组件销毁而不会残留。
// [权衡] 若为记住上次搜索词而在外层缓存，会让打开即全新的直觉失效，高亮还可能停在已不存在的行上。
// 不额外包一层 DOM 节点，避免破坏底座自带的焦点陷阱与背景滚动锁定。
export const ModelSelector = (props: ModelSelectorProps) => (
  <Dialog {...props} />
);

export type ModelSelectorTriggerProps = ComponentProps<typeof DialogTrigger>;

export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
  <DialogTrigger {...props} />
);

export type ModelSelectorContentProps = ComponentProps<typeof DialogContent> & {
  title?: ReactNode;
};

// ModelSelectorContent 是组合根，把 Conversation、Command 与 DialogTitle 拼成固定骨架，条目由调用方传入。
// [事务] 标题与命令根必须同生共死，任一被条件渲染掉都会让焦点顺序与命名同时失效。
// 标题有默认值，说明调用方可以完全不关心它，但组件仍必须渲染那个不可见标题节点。
// [权衡] 默认英文标题牺牲了本地化，换取调用零配置；需要中文时由调用方显式传入。
// 此层不解构子节点，因此空态、加载态与错误态由内部命令组件各自决定，不在装配处判断。
export const ModelSelectorContent = ({
  className,
  children,
  title = "Model Selector",
  ...props
}: ModelSelectorContentProps) => (
  <DialogContent
    // aria-describedby={undefined} 由这里显式置空，向 Dialog 声明本弹层没有描述，开发期不再告警。
    // 该属性写在展开属性之前，保证调用方仍能覆盖；若挪到之后，外部永远无法补回描述。
    // [权衡] 读屏用户因此听不到额外说明，换来的是干净的控制台与更少的噪声告警。
    // [失败路径] 直接删掉这行会让每个弹层实例都打印告警，久而久之告警被忽略，真正的无障碍缺陷被淹没。
    aria-describedby={undefined}
    className={cn(
      "outline! border-none! p-0 outline-border! outline-solid!",
      className
    )}
    {...props}
  >
    <DialogTitle className="sr-only">{title}</DialogTitle>
    <Command className="**:data-[slot=command-input-wrapper]:h-auto">
      {children}
    </Command>
  </DialogContent>
);

export type ModelSelectorDialogProps = ComponentProps<typeof CommandDialog>;

export const ModelSelectorDialog = (props: ModelSelectorDialogProps) => (
  <CommandDialog {...props} />
);

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export const ModelSelectorInput = ({
  className,
  ...props
}: ModelSelectorInputProps) => (
  <CommandInput className={cn("h-auto py-3.5", className)} {...props} />
);

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export const ModelSelectorList = (props: ModelSelectorListProps) => (
  <CommandList {...props} />
);

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

// 空态完全由命令根过滤后的结果数量决定，这一层只是把文案与插图挂到既定插槽。
// [失败路径] 把加载中的骨架塞进空态插槽，会在每次输入后的短暂窗口闪出无匹配，让人误以为搜索失败。
// 错误与重试不属于本组件职责，必须在列表外层处理，否则用户看到的是没有结果而不是请求失败。
// 因此三态边界是：过滤为空走空态，数据未到走加载，请求失败走上层错误展示。
export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => (
  <CommandEmpty {...props} />
);

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>;

export const ModelSelectorGroup = (props: ModelSelectorGroupProps) => (
  <CommandGroup {...props} />
);

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>;

export const ModelSelectorItem = (props: ModelSelectorItemProps) => (
  <CommandItem {...props} />
);

export type ModelSelectorShortcutProps = ComponentProps<typeof CommandShortcut>;

export const ModelSelectorShortcut = (props: ModelSelectorShortcutProps) => (
  <CommandShortcut {...props} />
);

export type ModelSelectorSeparatorProps = ComponentProps<
  typeof CommandSeparator
>;

export const ModelSelectorSeparator = (props: ModelSelectorSeparatorProps) => (
  <CommandSeparator {...props} />
);

export type ModelSelectorLogoProps = Omit<
  ComponentProps<"img">,
  "src" | "alt"
> & {
  provider:
    | "moonshotai-cn"
    | "lucidquery"
    | "moonshotai"
    | "zai-coding-plan"
    | "alibaba"
    | "xai"
    | "vultr"
    | "nvidia"
    | "upstage"
    | "groq"
    | "github-copilot"
    | "mistral"
    | "vercel"
    | "nebius"
    | "deepseek"
    | "alibaba-cn"
    | "google-vertex-anthropic"
    | "venice"
    | "chutes"
    | "cortecs"
    | "github-models"
    | "togetherai"
    | "azure"
    | "baseten"
    | "huggingface"
    | "opencode"
    | "fastrouter"
    | "google"
    | "google-vertex"
    | "cloudflare-workers-ai"
    | "inception"
    | "wandb"
    | "openai"
    | "zhipuai-coding-plan"
    | "perplexity"
    | "openrouter"
    | "zenmux"
    | "v0"
    | "iflowcn"
    | "synthetic"
    | "deepinfra"
    | "zhipuai"
    | "submodel"
    | "zai"
    | "inference"
    | "requesty"
    | "morph"
    | "lmstudio"
    | "anthropic"
    | "aihubmix"
    | "fireworks-ai"
    | "modelscope"
    | "llama"
    | "scaleway"
    | "amazon-bedrock"
    | "cerebras"
    // oxlint-disable-next-line typescript-eslint(ban-types) -- intentional pattern for autocomplete-friendly string union
    | (string & {});
};

export const ModelSelectorLogo = ({
  provider,
  className,
  ...props
}: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn("size-3 dark:invert", className)}
    height={12}
    // [资源] 图标直接取自 models.dev 的静态文件，仓库零体积，代价是把可用性绑在外部域名上。
    // [失败路径] 供应商标识来自宽松的字符串联合，拼错不会被类型拦住，运行时就退化成破图。
    // 固定宽高在图片到达前占位，避免列表项高度在加载完成瞬间抖动。
    // 替代文本由供应商名派生，读屏可念出品牌；改成空串会让图标对辅助技术完全隐身。
    src={`https://models.dev/logos/${provider}.svg`}
    width={12}
  />
);

export type ModelSelectorLogoGroupProps = ComponentProps<"div">;

export const ModelSelectorLogoGroup = ({
  className,
  ...props
}: ModelSelectorLogoGroupProps) => (
  <div
    className={cn(
      "flex shrink-0 items-center -space-x-1 [&>img]:rounded-full [&>img]:bg-background [&>img]:p-px [&>img]:ring-1 dark:[&>img]:bg-foreground",
      className
    )}
    {...props}
  />
);

export type ModelSelectorNameProps = ComponentProps<"span">;

export const ModelSelectorName = ({
  className,
  ...props
}: ModelSelectorNameProps) => (
  <span className={cn("flex-1 truncate text-left", className)} {...props} />
);
