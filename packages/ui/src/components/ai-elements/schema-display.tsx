// SchemaDisplay —— OpenAPI 风格接口卡片的展示组件族：方法徽章、路径高亮、参数表与请求/响应结构树。
// 做：以 Context 下发 method、path、description、parameters、requestBody、responseBody，并提供
//     Header/Method/Path/Description/Content/Parameter/Parameters/Property/Request/Response/
//     Body/Example 组合件；属性树按 depth 递归渲染折叠层级。
// 不做：不解析 OpenAPI 文档、不发请求、不做 schema 校验、不生成示例数据。
// 依赖：Badge 与 Collapsible 来自同仓 ui，图标来自 lucide-react，类名合并来自 cn。
// 被调用：助手回复里的接口说明卡片、工具结果中的 API 摘要。
// 边界：纯展示无副作用，不读 store、不取服务、不写日志；唯一的 DOM 注入点是路径高亮。
//
// INV-01 断言：Context 默认值是 GET 加空串而不是 null —— 守住它的位置：createContext 的初始对象 —— 改错故障：所有子件都要判空，独立渲染直接崩。
// INV-02 断言：方法类型固定为五种 —— 守住它的位置：HttpMethod 联合类型定义 —— 改错故障：新增方法取不到样式，徽章退化成裸文字。
// INV-03 断言：配色表必须覆盖联合类型的每个成员 —— 守住它的位置：methodStyles 的五个键 —— 改错故障：漏键导致背景缺失，浅色主题下几乎不可读。
// INV-04 断言：路径高亮只允许用于受信任文本 —— 守住它的位置：dangerouslySetInnerHTML 的取值 —— 改错故障：用户可控路径被当作 HTML 执行，形成注入面。
// INV-05 断言：children 优先于 Context 值 —— 守住它的位置：Method/Path/Description 的 children 兜底 —— 改错故障：调用方传入的文案永远不可见。
// INV-06 断言：参数列表的键必须用参数名 —— 守住它的位置：SchemaDisplayParameters 的 key —— 改错故障：同名参数重排时复用错误节点，描述错位。
// INV-07 断言：属性树必须有递归终点 —— 守住它的位置：hasChildren 的真值判断 —— 改错故障：把空数组当有子节点会渲染出点开是空白的折叠项。
// INV-08 断言：递归深度每次加一 —— 守住它的位置：嵌套属性传 depth + 1 —— 改错故障：缩进被压平，层级关系无法辨认。
// INV-09 断言：缩进必须走内联样式 —— 守住它的位置：容器上的 paddingLeft —— 改错故障：改成动态类名后构建期扫描不到，缩进完全失效。
// INV-10 断言：默认只展开两层 —— 守住它的位置：defaultOpen={depth < 2} —— 改错故障：深层结构全部展开，卡片高度失控。
// INV-11 断言：数组元素的展示名拼接方括号但不改原名 —— 守住它的位置：传给递归件的 name —— 改错故障：直接改写原字段会污染上层数据。
// INV-12 断言：折叠状态只在挂载时读取默认值 —— 守住它的位置：defaultOpen 而非受控值 —— 改错故障：改成受控后每次数据刷新都会重置用户的展开状态。
// INV-13 断言：Context 的 memo 必须列全六项依赖 —— 守住它的位置：useMemo 依赖数组 —— 改错故障：漏项会让子件永久显示上一份 schema。
// INV-14 断言：默认骨架只在数据非空时渲染区块 —— 守住它的位置：长度大于零的条件判断 —— 改错故障：空数组仍渲染标题，出现多个空白分组。
// INV-15 断言：只有 required 为真才渲染必填标记 —— 守住它的位置：条件渲染的 required 短路 —— 改错故障：可选参数被标成必填，误导调用方。
// INV-16 断言：描述缺失时不渲染空段落 —— 守住它的位置：description 的条件渲染 —— 改错故障：空段落占用间距，列表出现莫名空行。
// INV-17 断言：请求体与响应体共享属性树实现 —— 守住它的位置：两处对 SchemaDisplayProperty 的复用 —— 改错故障：各写一份后行为分叉，一处修好另一处仍旧。
// INV-18 断言：方法徽章颜色只能来自配色表 —— 守住它的位置：methodStyles 的索引取值 —— 改错故障：组件内写死颜色会让新增方法与主题适配同时失效。
// INV-19 断言：展示组件不得读取服务或 store —— 守住它的位置：全部组件的导入与实现 —— 改错故障：引入数据依赖后无法在文档页与单测中独立复用。
// INV-20 断言：示例区不解析 JSON —— 守住它的位置：SchemaDisplayExample 的纯文本渲染 —— 改错故障：接入解析后大段示例阻塞渲染并带来语法兼容问题。
//
// 阅读顺序：先看 Context 的六项与兜底值，再看 Method 与 Path 的展示差异，最后看 Property 的递归与缩进。
// 常见误改：给 Context 换 null 默认值、把路径高亮改成直接拼接、递归时忘记给 depth 加一。
// 与外部的关系：SchemaDisplayProps 与六个接口形状是对外契约，改字段名属于破坏性变更。
// 测试关注点：缺 Provider 的兜底渲染、空数组不渲染区块、深层嵌套的缩进与默认展开。
// 样式边界：颜色语义沿用 DESIGN，方法配色表是本文件唯一允许写死颜色的地方。
// 安全边界：路径高亮依赖 innerHTML，入参必须是受信任 schema，不接受用户原文。
// 性能边界：Context 值按六项依赖 memo，属性树只在数据变化时重建。
// 可访问性：折叠触发器由 Radix 提供，徽章是纯文本，不承担交互。
// 维护提示：新增 HTTP 方法必须同时改联合类型与配色表，漏一处会得到无背景徽章。
// 国际化边界：Parameters、Request Body、Response 是接口术语，保持英文，不随语言切换。
"use client";

import { Badge } from "../ui/badge.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.js";
import { cn } from "../lib/utils.js";
import { ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useMemo } from "react";

// [契约] 方法类型固定五种，与后端支持的接口方法集合对齐，新增方法必须同步样式表。
// 用联合类型而不是枚举，是为了让调用方直接传字符串字面量，避免额外导入。
// [边界] 这里不校验运行时值，非法方法会在样式表里取到空值，由调用方保证。
// 类型的书写顺序与样式表的键顺序无关，不要试图用顺序做隐式映射。
// 若未来出现 HEAD 或 OPTIONS，必须成对更新类型与样式，否则徽章没有背景色。
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// [契约] 参数只有名称、类型、必填、描述、位置五个字段，不多不少。
// 位置限定路径、查询、请求头三种来源，避免把请求体参数混进参数表。
// required 可选表示未知而不是必填，UI 仅在为真时渲染标记。
// [边界] 该接口只描述展示所需，不承载默认值、示例等扩展字段。
// [权衡] 保持扁平结构，是为了让参数列表可以直接展开成属性而不做二次映射。
interface SchemaParameter {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  location?: "path" | "query" | "header";
}

// [契约] 属性通过 properties 与 items 自引用形成树，深度由渲染层单独维护。
// items 表示数组元素，嵌套时只递归一层，不做多重数组建模。
// required 与 description 都可选，缺省时对应区域不渲染。
// [边界] 这里不表达联合结构，遇到时由调用方降级成类型字符串。
// [权衡] 不引入 schema 引用表，换来组件无状态，代价是深层结构会重复展开。
interface SchemaProperty {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  properties?: SchemaProperty[];
  items?: SchemaProperty;
}

// [契约] Context 只承载方法、路径、描述、参数、请求体、响应体六项。
// 除方法外全部可选，是为了让缺省数据自然降级，而不是要求调用方造空数组。
// [边界] 这里不放 className 或 children，样式与自定义内容必须走 props。
// 字段名与接口文档的术语保持一致，降低调用方的映射成本。
// [权衡] SchemaDisplayContextType 不做嵌套分组，六个字段足够表达展示层需要的全部信息。
interface SchemaDisplayContextType {
  method: HttpMethod;
  path: string;
  description?: string;
  parameters?: SchemaParameter[];
  requestBody?: SchemaProperty[];
  responseBody?: SchemaProperty[];
}

// [契约] 默认值是 GET 加空路径，而不是 null，目的是让子件不必到处判空。
// 空路径配合高亮会产生空片段，视觉上是空串，不会崩溃。
// [失败路径] 脱离 Provider 使用时展示这份兜底值，属于可见的降级而不是静默错误。
// [权衡] 不用 null 默认值，是因为这些子件本质是展示原子，允许独立渲染。
// [边界] 兜底值只保证不崩，不保证语义正确，正式使用仍应包 Provider。
const SchemaDisplayContext = createContext<SchemaDisplayContextType>({
  method: "GET",
  path: "",
});

// [契约] 五种方法必须有对应配色，缺失会让徽章落到无背景的裸文字。
// 颜色使用浅底深字并同时给出暗色变体，保证两套主题都清晰。
// [边界] 这里只定义颜色，不定义尺寸与圆角，那些由徽章组件统一。
// [权衡] 不用动态拼接类名，因为构建期扫描不到拼接结果会丢样式。
// 新增方法时这里与类型必须同时改，漏一处就是线上白底徽章。
const methodStyles: Record<HttpMethod, string> = {
  DELETE: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  GET: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  PATCH:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  POST: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  PUT: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
};

export type SchemaDisplayHeaderProps = HTMLAttributes<HTMLDivElement>;

export const SchemaDisplayHeader = ({
  className,
  children,
  ...props
}: SchemaDisplayHeaderProps) => (
  <div
    className={cn("flex items-center gap-3 border-b px-4 py-3", className)}
    {...props}
  >
    {children}
  </div>
);

export type SchemaDisplayMethodProps = ComponentProps<typeof Badge>;

// [契约] 方法名优先取 children，没有才回落到 Context，便于局部覆盖。
// Badge 的 variant 固定为 secondary，颜色由方法样式覆盖。
// [边界] SchemaDisplayMethod 不校验 HttpMethod 是否合法，只做展示。
// className 经 cn() 与方法样式合并，调用方可据此微调。
// [权衡] 不做大小写归一，传小写会取不到样式，这是刻意的严格。
export const SchemaDisplayMethod = ({
  className,
  children,
  ...props
}: SchemaDisplayMethodProps) => {
  // [契约] 只从 Context 取方法一个字段，避免因其他字段变化而重渲染。
  // 解构发生在渲染期，不缓存，Context 更新后立即生效。
  // [边界] 这里不读路径，因此路径变化不会触发本组件更新。
  // [权衡] method 保持可选，是为了让 SchemaDisplayMethod 无参可用。
  // [失败路径] 缺 Provider 时取到兜底的 GET，展示为绿色徽章。
  const { method } = useContext(SchemaDisplayContext);

  return (
    <Badge
      className={cn("font-mono text-ui-base", methodStyles[method], className)}
      variant="secondary"
      {...props}
    >
      {children ?? method}
    </Badge>
  );
};

export type SchemaDisplayPathProps = HTMLAttributes<HTMLSpanElement>;

export const SchemaDisplayPath = ({
  className,
  children,
  ...props
}: SchemaDisplayPathProps) => {
  const { path } = useContext(SchemaDisplayContext);

  // Highlight path parameters
  // [契约] 路径参数用正则包成高亮片段，保留花括号本身，语义与接口文档一致。
  // 替换只针对花括号片段，其余字符原样保留，包括斜杠与点号。
  // [边界] 结果交给 innerHTML 注入，因此入参必须来自受信任的 schema 文本。
  // [安全] 若路径可能包含用户输入，必须先转义，不能把原串直接拼进 HTML。
  // [权衡] 用字符串替换而不是解析成节点树，代价是要求输入可信，收益是实现极简。
  const highlightedPath = path.replaceAll(
    /\{([^}]+)\}/g,
    '<span class="text-blue-600 dark:text-blue-400">{$1}</span>'
  );

  return (
    <span
      className={cn("font-mono text-ui-base", className)}
      // oxlint-disable-next-line eslint-plugin-react(no-danger)
      dangerouslySetInnerHTML={{ __html: children ?? highlightedPath }}
      {...props}
    />
  );
};

export type SchemaDisplayDescriptionProps =
  HTMLAttributes<HTMLParagraphElement>;

export const SchemaDisplayDescription = ({
  className,
  children,
  ...props
}: SchemaDisplayDescriptionProps) => {
  const { description } = useContext(SchemaDisplayContext);

  return (
    <p
      className={cn(
        "border-b px-4 py-3 text-muted-foreground text-ui-base",
        className
      )}
      {...props}
    >
      {children ?? description}
    </p>
  );
};

export type SchemaDisplayContentProps = HTMLAttributes<HTMLDivElement>;

export const SchemaDisplayContent = ({
  className,
  children,
  ...props
}: SchemaDisplayContentProps) => (
  <div className={cn("divide-y", className)} {...props}>
    {children}
  </div>
);

export type SchemaDisplayParameterProps = HTMLAttributes<HTMLDivElement> &
  SchemaParameter;

// [契约] 单个参数展示名称、类型、位置与必填标记，顺序固定。
// 必填标记使用红色底，仅在必填为真时出现。
// 描述单独成行，不进入标题行，避免长描述挤压徽章。
// [边界] 组件只读自身属性，不消费 Context。
// [权衡] 不折叠单条参数，参数数量通常有限，折叠反而增加操作成本。
export const SchemaDisplayParameter = ({
  name,
  type,
  required,
  description,
  location,
  className,
  ...props
}: SchemaDisplayParameterProps) => (
  <div className={cn("px-4 py-3 pl-10", className)} {...props}>
    <div className="flex items-center gap-2">
      <span className="font-mono text-ui-base">{name}</span>
      <Badge className="text-ui-base" variant="outline">
        {type}
      </Badge>
      {location && (
        <Badge className="text-ui-base" variant="secondary">
          {location}
        </Badge>
      )}
      {required && (
        <Badge
          className="bg-red-100 text-red-700 text-ui-base dark:bg-red-900/30 dark:text-red-400"
          variant="secondary"
        >
          required
        </Badge>
      )}
    </div>
    {description && (
      <p className="mt-1 text-muted-foreground text-ui-base">{description}</p>
    )}
  </div>
);

export type SchemaDisplayParametersProps = ComponentProps<typeof Collapsible>;

export const SchemaDisplayParameters = ({
  className,
  children,
  ...props
}: SchemaDisplayParametersProps) => {
  // [契约] 参数区块的展开状态由折叠组件内部管理，本组件不持有。
  // 默认展开只在挂载时生效，运行期数据变化不会重置开合。
  // 数量徽章取可选链长度，缺省时显示为空而不是零。
  // [边界] 这里不排序也不过滤，顺序完全由调用方给定。
  // [失败路径] 参数为空时仍渲染标题，只是内容区为空，避免整块消失造成布局跳动。
  const { parameters } = useContext(SchemaDisplayContext);

  return (
    <Collapsible className={cn(className)} defaultOpen {...props}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-medium text-ui-base">Parameters</span>
        <Badge className="ml-auto text-ui-base" variant="secondary">
          {parameters?.length}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y border-t">
          {children ??
            parameters?.map((param) => (
              <SchemaDisplayParameter key={param.name} {...param} />
            ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export type SchemaDisplayPropertyProps = HTMLAttributes<HTMLDivElement> &
  SchemaProperty & {
    depth?: number;
  };

export const SchemaDisplayProperty = ({
  name,
  type,
  required,
  description,
  properties,
  items,
  depth = 0,
  className,
  ...props
}: SchemaDisplayPropertyProps) => {
  // [契约] 是否有子节点由属性数组或元素定义的真值决定，空数组也算没有。
  // 用真值判断而不是长度比较，是为了同时兼容缺省与空数组。
  // [边界] 只有存在子节点才渲染折叠容器，叶子节点走平铺分支。
  // [权衡] 不把空对象当有子节点，避免出现点开却是空白的折叠项。
  // 该判断同时影响缩进与触发器渲染，改动时必须两处一起看。
  const hasChildren = properties || items;
  // [契约] 缩进用内联样式计算，因为深度是运行期值，构建期无法生成对应类名。
  // 基础缩进 40 保证与父级触发器图标对齐，每层再加 16。
  // [边界] 深度从零开始，顶层属性不额外增加层级。
  // [权衡] 不用 CSS 变量或嵌套容器，避免深层结构产生大量包裹节点。
  // 数值变化会影响所有层级的对齐，调整时需同时检查描述行的偏移。
  const paddingLeft = 40 + depth * 16;

  if (hasChildren) {
    return (
      <Collapsible defaultOpen={depth < 2}>
        <CollapsibleTrigger
          className={cn(
            "group flex w-full items-center gap-2 py-3 text-left transition-colors hover:bg-muted/50",
            className
          )}
          style={{ paddingLeft }}
        >
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="font-mono text-ui-base">{name}</span>
          <Badge className="text-ui-base" variant="outline">
            {type}
          </Badge>
          {required && (
            <Badge
              className="bg-red-100 text-red-700 text-ui-base dark:bg-red-900/30 dark:text-red-400"
              variant="secondary"
            >
              required
            </Badge>
          )}
        </CollapsibleTrigger>
        {description && (
          <p
            className="pb-2 text-muted-foreground text-ui-base"
            style={{ paddingLeft: paddingLeft + 24 }}
          >
            {description}
          </p>
        )}
        <CollapsibleContent>
          <div className="divide-y border-t">
            {properties?.map((prop) => (
              <SchemaDisplayProperty
                key={prop.name}
                {...prop}
                depth={depth + 1}
              />
            ))}
            {items && (
              <SchemaDisplayProperty
                {...items}
                depth={depth + 1}
                name={`${name}[]`}
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <div
      className={cn("py-3 pr-4", className)}
      style={{ paddingLeft }}
      {...props}
    >
      <div className="flex items-center gap-2">
        {/* Spacer for alignment */}
        <span className="size-4" />
        <span className="font-mono text-ui-base">{name}</span>
        <Badge className="text-ui-base" variant="outline">
          {type}
        </Badge>
        {required && (
          <Badge
            className="bg-red-100 text-red-700 text-ui-base dark:bg-red-900/30 dark:text-red-400"
            variant="secondary"
          >
            required
          </Badge>
        )}
      </div>
      {description && (
        <p className="mt-1 pl-6 text-muted-foreground text-ui-base">{description}</p>
      )}
    </div>
  );
};

export type SchemaDisplayRequestProps = ComponentProps<typeof Collapsible>;

export const SchemaDisplayRequest = ({
  className,
  children,
  ...props
}: SchemaDisplayRequestProps) => {
  // [契约] 请求体区块只在有数据时由外部渲染，本组件不判断空数组。
  // requestBody 逐项交给 SchemaDisplayProperty 渲染，depth 从零重新开始。
  // [边界] 这里不区分整体必填语义，逐条属性自带标记。
  // [权衡] 不与参数区块共享折叠状态，两个区块独立开合更符合阅读习惯。
  // [失败路径] 数据缺失时内容兜底为空，内容区留白而不报错。
  const { requestBody } = useContext(SchemaDisplayContext);

  return (
    <Collapsible className={cn(className)} defaultOpen {...props}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-medium text-ui-base">Request Body</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t">
          {children ??
            requestBody?.map((prop) => (
              <SchemaDisplayProperty key={prop.name} {...prop} depth={0} />
            ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export type SchemaDisplayResponseProps = ComponentProps<typeof Collapsible>;

export const SchemaDisplayResponse = ({
  className,
  children,
  ...props
}: SchemaDisplayResponseProps) => {
  // [契约] responseBody 与 requestBody 结构对称，复用同一套 SchemaDisplayProperty 与 Collapsible 语义。
  // 响应体标题固定，不根据状态码变化，状态码不属于本组件的表达范围。
  // [边界] 不渲染示例值，示例与结构展示分离，避免大段文本撑高卡片。
  // [权衡] 与请求体拆成两个组件而不是参数化标题，保持调用端可读性。
  // responseBody 缺失时同样以空内容降级，不抛错。
  const { responseBody } = useContext(SchemaDisplayContext);

  return (
    <Collapsible className={cn(className)} defaultOpen {...props}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-medium text-ui-base">Response</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t">
          {children ??
            responseBody?.map((prop) => (
              <SchemaDisplayProperty key={prop.name} {...prop} depth={0} />
            ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export type SchemaDisplayProps = HTMLAttributes<HTMLDivElement> & {
  method: HttpMethod;
  path: string;
  description?: string;
  parameters?: SchemaParameter[];
  requestBody?: SchemaProperty[];
  responseBody?: SchemaProperty[];
};

// [契约] 根组件负责组装默认骨架，调用方传 children 时完全接管内容。
// 默认骨架只在对应数据非空时渲染区块，避免空标题堆叠。
// [边界] 根组件不校验方法与路径的匹配关系，那是数据层职责。
// [权衡] 默认骨架覆盖常见场景，复杂布局通过 children 覆盖，不再加配置项。
// [失败路径] 全部数据为空时仍渲染头部，方法徽章使用兜底值。
export const SchemaDisplay = ({
  method,
  path,
  description,
  parameters,
  requestBody,
  responseBody,
  className,
  children,
  ...props
}: SchemaDisplayProps) => {
  // [契约] 六项依赖全部列出，少一项都会让子件读到旧数据。
  // 依赖里包含数组引用，调用方每次新建数组会导致重新 memo，这是预期行为。
  // [并发] memo 只保证引用稳定，不保证内容深比较，调用方应尽量复用数组。
  // [权衡] 不做深比较，schema 数据量小，深比较的成本高于收益。
  // [边界] 该值不包含任何回调，展示层不需要写入能力。
  const contextValue = useMemo(
    () => ({
      description,
      method,
      parameters,
      path,
      requestBody,
      responseBody,
    }),
    [description, method, parameters, path, requestBody, responseBody]
  );

  return (
    <SchemaDisplayContext.Provider value={contextValue}>
      <div
        className={cn(
          "overflow-hidden rounded-lg border bg-background",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <SchemaDisplayHeader>
              <div className="flex items-center gap-3">
                <SchemaDisplayMethod />
                <SchemaDisplayPath />
              </div>
            </SchemaDisplayHeader>
            {description && <SchemaDisplayDescription />}
            <SchemaDisplayContent>
              {parameters && parameters.length > 0 && (
                <SchemaDisplayParameters />
              )}
              {requestBody && requestBody.length > 0 && (
                <SchemaDisplayRequest />
              )}
              {responseBody && responseBody.length > 0 && (
                <SchemaDisplayResponse />
              )}
            </SchemaDisplayContent>
          </>
        )}
      </div>
    </SchemaDisplayContext.Provider>
  );
};

export type SchemaDisplayBodyProps = HTMLAttributes<HTMLDivElement>;

// [契约] SchemaDisplayBody 只做分隔线与内边距，不参与数据渲染。
// 与默认内容区的区别在于它用于自定义布局，后者用于默认区块组合。
// [边界] 组件不读 Context，可独立用于任意内容。
// [权衡] 保留 SchemaDisplayBody 与默认内容区两条路径，是为了让调用方在默认骨架与完全自定义之间平滑过渡。
// 调用方类名会覆盖默认分隔样式，需自行保证边框一致性。
export const SchemaDisplayBody = ({
  className,
  children,
  ...props
}: SchemaDisplayBodyProps) => (
  <div className={cn("divide-y", className)} {...props}>
    {children}
  </div>
);

export type SchemaDisplayExampleProps = HTMLAttributes<HTMLPreElement>;

// [契约] 示例区只做等宽文本容器，不解析 JSON、不做语法高亮。
// [边界] 内容与滚动完全交给调用方，组件不限制高度。
export const SchemaDisplayExample = ({
  className,
  children,
  ...props
}: SchemaDisplayExampleProps) => (
  <pre
    className={cn(
      "mx-4 mb-4 overflow-auto rounded-md bg-muted p-4 font-mono text-ui-base",
      className
    )}
    {...props}
  >
    {children}
  </pre>
);
