// INV-01 格式分派：守住位置 分派组件的三分支；改错故障：纯文本被当成 HTML 解析。
// INV-02 长度上限：守住位置 两处超长判断；改错故障：超大文本进入解析，主线程卡死。
// INV-03 标签白名单：守住位置 允许标签集合；改错故障：脚本或表单控件被放行。
// INV-04 命名空间：守住位置 命名空间判断；改错故障：外来命名空间元素被当作 HTML 渲染。
// INV-05 深度上限：守住位置 递归的深度判断；改错故障：深嵌套递归爆栈。
// INV-06 子树丢弃：守住位置 白名单外的空返回；改错故障：非法标签的子节点被提升到父级。
// INV-07 属性收敛：守住位置 元素属性只取类名与样式；改错故障：云端事件属性进入宿主。
// INV-08 链接净化：守住位置 链接过滤函数；改错故障：脚本协议被当作可点击链接。
// INV-09 凭据拒绝：守住位置 用户名密码判断；改错故障：带凭据的地址被打开。
// INV-10 降级链接：守住位置 无回调或非法地址分支；改错故障：点击链接无响应且无提示。
// INV-11 行内降级：守住位置 块级标签判断；改错故障：行内模式被块级元素撑破行高。
// INV-12 空元素处理：守住位置 换行与分隔线的子节点；改错故障：空元素被塞入无效子节点。
// INV-13 转义：守住位置 Markdown 的内嵌标签渲染器；改错故障：内嵌标签被当作结构。
// INV-14 同步解析：守住位置 异步开关关闭；改错故障：渲染期拿到异步结果而显示空内容。
// INV-15 键稳定：守住位置 兄弟节点的索引键；改错故障：节点复用时状态错位。
// INV-16 格式透出：守住位置 格式数据属性；改错故障：样式无法按格式区分。
// INV-17 属性透传：守住位置 容器的属性展开；改错故障：调用方的类名与测试属性丢失。
// INV-18 纯渲染：守住位置 组件内无状态；改错故障：描述变化后仍显示旧内容。
//
// 模块职责：把云端描述按格式渲染为 React 元素，含 Markdown 转换与受控 HTML 白名单。
// 状态所有权：无组件状态；Markdown 实例与允许标签集合为模块级常量。
// 阅读顺序：标签与样式表 → Markdown 配置 → 链接净化 → HTML 递归 → 两个导出组件。
import { createElement, type HTMLAttributes, type ReactNode } from "react";
import { Marked } from "marked";
import type { CloudContentDialogPayload } from "@/components/cloud-content-dialog/cloudContentDialogTypes.js";
import { cn } from "@/components/lib/utils.js";
import { parseCloudDescriptionStyle } from "@/components/cloud-content-dialog/cloudDescriptionStyle.js";

// `TAGS` 只收排版类语义标签：`script` / `iframe` / 表单控件一律不进白名单。
// 名单之外的标签整棵子树被丢弃，避免半渲染残片。
// 样式表与白名单都按标签名索引，新增标签要同时检查两处。
//
const TAGS = new Set([
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "code",
  "a",
  "span",
  "time",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "del",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
// 默认样式：按标签名映射到工具类，保证不依赖云端自带类名也有基本排版。
// 云端类名会拼在后面，同名工具类由后者覆盖，保留原始微调意图。
// 链接与时间使用固定的强调色与虚线样式，与宿主设计语言一致。
//
const CLASSES: Record<string, string> = {
  b: "font-semibold text-foreground",
  strong: "font-semibold text-foreground",
  ul: "list-disc pl-5",
  ol: "list-decimal pl-5",
  code: "font-mono text-ui-sm",
  a: "text-icon-blue underline underline-offset-4",
  time: "whitespace-nowrap font-semibold text-foreground underline decoration-foreground-subtle decoration-dashed underline-offset-4",
  h1: "text-ui-xl font-semibold",
  h2: "text-ui-lg font-semibold",
  h3: "text-ui-base font-semibold",
  h4: "text-ui-base font-semibold",
  h5: "text-ui-base font-medium",
  h6: "text-ui-base font-normal",
  blockquote: "border-l border-border pl-3",
  pre: "overflow-x-auto whitespace-pre-wrap font-mono text-ui-sm",
  table: "w-full text-ui-base",
  th: "border border-border p-2 font-semibold",
  td: "border border-border p-2",
};

// `BLOCK_TAGS` 在行内模式下一律降级为行内容器：标题与列表会把行高撑破。
// `BLOCK_TAGS` 与 `TAGS` 刻意分开维护：允许的结构不等于行内可用的结构。
// 行内模式只换容器标签，子节点结构保持不变。
//
const BLOCK_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);
// Markdown 解析器：关闭异步，保证渲染期同步拿到结果。
// 内嵌 HTML 被显式转义成文字，只有明确的 HTML 格式才进入解析路径。
// 解析器实例可复用，配置在模块加载时固定。
//
const markdown = new Marked({
  async: false,
  renderer: {
    // Markdown 内嵌 HTML 作为文字；显式 html format 才进入 HTML 解析路径。
    html: ({ text }) =>
      text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  },
});

// 链接净化：只接受 http 与 https，其余协议（含脚本协议）一律丢弃。
// 解析失败或地址里带用户名密码时视为未通过，链接降级成普通文字。
// 返回值是规范化后的地址，调用方不再二次校验。
//
function safeLink(value: string | null): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password ? undefined : url.href;
  } catch {
    return undefined;
  }
}

// HTML 渲染：先在惰性模板里解析，再递归转换成 React 元素。
// 文本过长或没有 DOM 环境时直接返回原串；递归过深即整体放弃并回退纯文本。
// 属性只保留类名与样式，事件、链接等由各标签分支单独处理。
//
function renderHtml(
  text: string,
  onOpenExternal?: (url: string) => void,
  inline = false,
): ReactNode {
  if (text.length > 20_000 || typeof document === "undefined") return text;
  // 云端 HTML 只在 inert template 内解析，不能把其 DOM 或属性直接带入宿主。
  const template = document.createElement("template");
  template.innerHTML = text;
  let overDepth = false;
  function visit(node: Node, depth: number, key: number): ReactNode {
    if (depth > 32) {
      overDepth = true;
      return null;
    }
    // 元素分支再判命名空间与白名单，两道都过才继续往下遍历子节点。
    // 链接没有安全地址或宿主未提供打开回调时降级成行内容器，保留文字与类名。
    //
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    const tag = element.localName;
    if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || !TAGS.has(tag)) return null;
    const children = Array.from(element.childNodes, (child, index) =>
      visit(child, depth + 1, index),
    );
    const props = {
      key,
      className: cn(
        inline ? (tag === "b" || tag === "strong" ? "font-semibold" : undefined) : CLASSES[tag],
        element.getAttribute("class"),
      ),
      style: parseCloudDescriptionStyle(element.getAttribute("style")),
    };
    if (tag === "a") {
      const href = safeLink(element.getAttribute("href"));
      if (!href || !onOpenExternal)
        return createElement(
          "span",
          { ...props, className: element.getAttribute("class") ?? undefined },
          children,
        );
      return createElement(
        "a",
        {
          ...props,
          href,
          title: element.getAttribute("title") ?? undefined,
          onClick: (event: React.MouseEvent) => {
            event.preventDefault();
            onOpenExternal(href);
          },
        },
        children,
      );
    }
    // 标题/按钮不能嵌套块级或交互节点；保留行内排版且沿用宿主动作。
    return createElement(
      inline && BLOCK_TAGS.has(tag) ? "span" : tag,
      props,
      tag === "br" || tag === "hr" ? undefined : children,
    );
  }
  const result = Array.from(template.content.childNodes, (child, index) => visit(child, 0, index));
  return overDepth ? text : result;
}

// 分派入口：纯文本与超长文本直接输出字符串，Markdown 先转 HTML 再进受控渲染。
// 行内模式不透传外部打开回调，避免行内链接跳出宿主布局。
//
export function CloudFormattedTextContent({
  text,
  inline = false,
  onOpenExternal,
}: {
  text: CloudContentDialogPayload["dialog"]["description"];
  inline?: boolean;
  onOpenExternal?: (url: string) => void;
}) {
  if (text.format === "plain_text" || text.text.length > 20_000) return text.text;
  const html =
    text.format === "markdown" ? markdown.parse(text.text, { async: false }).trimEnd() : text.text;
  return renderHtml(html, inline ? undefined : onOpenExternal, inline);
}

// 容器组件：保留调用方传入的容器属性，并用数据属性暴露原始格式供样式区分。
// 外层只负责定位与格式标记，真正的文本渲染交给分派组件。
//
export function CloudDialogDescription({
  description,
  onOpenExternal,
  ...props
}: {
  description: CloudContentDialogPayload["dialog"]["description"];
  onOpenExternal?: (url: string) => void;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} data-description-format={description.format}>
      <CloudFormattedTextContent text={description} onOpenExternal={onOpenExternal} />
    </div>
  );
}
