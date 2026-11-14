"use client";

// 做：把纯文本代码渲染成带行号、可选语法高亮、行内评论草稿与已提交评论的只读视图。
// 不做：不持久化评论、不决定评论归属、不拥有外部滚动容器；只把回调和最终 DOM 交给调用方。
// 依赖：@pierre/diffs 的 File（Shadow DOM 内渲染行与 gutter）+ shiki 主题 token + 应用 CSS 变量。
// 契约：评论坐标用 CodeCommentRange（1 起、含端点、已归一化），行号偏移只由 firstLineNumber 提供。
// 生命周期：DOM 补丁与滚动定位都走 effect + rAF，卸载时必须撤销帧并断开 observer。
// 不变量（INV）：
// INV-01 断言：所有行号换算以 firstLineNumber 为唯一原点，选区与评论共用同一坐标系 —— 守住它的位置：selectedRangeToCodeCommentRange / codeCommentRangeToSelectedRange —— 改错故障：片段从第 100 行开始时评论会挂到第 1 行，草稿框整体偏移。
// INV-02 断言：CodeCommentRange 使用前必须经过 normalizeRange —— 守住它的位置：lineAnnotations、selectedLines、getTextForLineRange、formatCommentRange —— 改错故障：自下而上拖拽产生 startLine 大于 endLine，评论锚点算成 0 或负数后被静默丢弃。
// INV-03 断言：cacheKey 必须覆盖主题、语言、文件名与内容指纹 —— 守住它的位置：createCodeViewerFile —— 改错故障：同长度不同内容的代码复用旧 token，界面显示上一次的代码。
// INV-04 断言：markedLines 只着色行号、不改变代码 token —— 守住它的位置：codeViewerMarkedLinesCss —— 改错故障：改成给行容器加 class 会与 @pierre/diffs 自带 hover 样式互相覆盖。
// INV-05 断言：行号着色规则必须经 unsafeCSS 注入 Shadow DOM —— 守住它的位置：CODE_VIEWER_UNSAFE_CSS 与 options.unsafeCSS 的拼接 —— 改错故障：外层选择器进不了 shadow root，标记行完全不生效且没有任何报错。
// INV-06 断言：行号标注从 1 开始且必须落在有效区间 —— 守住它的位置：lineAnnotations 里 lineNumber 小于 1 的短路 —— 改错故障：firstLineNumber 大于评论行号时生成 0 或负行号，@pierre/diffs 抛错或错位渲染。
// INV-07 断言：草稿评审只在 canCreateComment 为真时存在 —— 守住它的位置：lineAnnotations 与 handleLineSelectionEnd —— 改错故障：只读场景仍能拖出选区并打开草稿框，提交时回调为空，用户输入被静默丢弃。
// INV-08 断言：空选中文本不得提交 —— 守住它的位置：handleSubmitDraft 里的 selectedText.trim() 判断 —— 改错故障：越界区间生成空引用评论，后端保存一条无法定位的记录。
// INV-09 断言：评论与草稿不能共用同一行的插槽 —— 守住它的位置：lineAnnotations 先推评论、再推草稿 —— 改错故障：同一行出现两个 annotation 插槽，React key 冲突导致卡片重复渲染。
// INV-10 断言：提交成功路径必须同时清空 activeDraftRange 与 draftText —— 守住它的位置：handleSubmitDraft 末尾 —— 改错故障：再次打开草稿会带上上一条评论的正文。
// INV-11 断言：行评论是“追加在区间末行之后”的插槽，而不是覆盖原行 —— 守住它的位置：lineAnnotations 的 endLine 计算 —— 改错故障：挂到起始行时评论插在代码上方，视觉上被读成上一行的注释。
// INV-12 断言：gutter 补丁只写 title 与 aria-label，不接管 pointer 事件 —— 守住它的位置：patchCodeCommentUtilityButtons —— 改错故障：自定义 handler 打断官方 InteractionManager，拖拽多行退化为单行评论。
// INV-13 断言：Shadow DOM 观察按 Root 去重，且每个 observer 都要在清理阶段 disconnect —— 守住它的位置：observedRoots 与 effect cleanup —— 改错故障：嵌套 shadow root 反复挂载 observer，滚动时 CPU 打满；卸载后回调继续访问已销毁节点。
// INV-14 断言：同一帧内多次 DOM 变更只触发一次补丁 —— 守住它的位置：schedulePatch 的 animationFrame 短路 —— 改错故障：高亮重排期间每次 mutation 都全树遍历，滚动明显掉帧。
// INV-15 断言：DOM 补丁只能在 effect 内启动，且必须等到 ref 挂载 —— 守住它的位置：useEffect 依赖 canUseCommentGutterUtility —— 改错故障：首次 render 阶段 viewerRef.current 为空，补丁静默不生效。
// INV-16 断言：聚焦定位先找评论节点、再退回代码行 —— 守住它的位置：scrollToFocusedLine 的分支顺序 —— 改错故障：只滚到代码行时评论落在视口外，用户看不到刚点开的评论内容。
// INV-17 断言：聚焦定位只改 scrollTop，且必须回写原 scrollLeft —— 守住它的位置：两处 horizontalScrollLeft 缓存 —— 改错故障：scrollIntoView 类方案把横向滚动重置为 0，长行代码跳回行首。
// INV-18 断言：定位重试有上限，超限必须放弃而不是继续排队 —— 守住它的位置：attempts 计数与 45 帧阈值 —— 改错故障：目标行不存在时无限 rAF，页面持续掉帧。
// INV-19 断言：滚动定位必须随 file.cacheKey 重新执行 —— 守住它的位置：定位 effect 的依赖列表 —— 改错故障：同 tab 内切换文件后焦点不迁移，点击评论卡片没有任何反馈。
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";
import type { FileContents, LineAnnotation, SupportedLanguages } from "@pierre/diffs";
import { File, type FileOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import { isDarkCodePreviewTheme } from "@/lib/codePreviewPreferences.js";
import { DIFFS_PREFERRED_HIGHLIGHTER } from "@/lib/diffsHighlighterEngine.js";
import {
  formatCommandShortcutLabel,
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";

// [契约] 标签全部由调用方注入而不是内置 i18n：该组件同时被桌面、Web 与手机远控复用，
// 各端文案来源不同，在这里读全局 locale 会把共享 UI 包绑定到某一端的语言状态上。
// 缺省值见 DEFAULT_CODE_COMMENT_LABELS，只在完全未传 labels 时兜底，避免渲染出空按钮。
// [契约] 字段名是外部可见约定（含 {line} / {startLine} / {endLine} 占位符），改名要同步所有调用方文案表。
export interface CodeCommentLabels {
  addComment: string;
  addCommentTooltip: string;
  commentPlaceholder: string;
  submitComment: string;
  cancelComment: string;
  deleteComment: string;
  commentLine: string;
  commentRange: string;
}

// [契约] 透传 HTMLAttributes 是为了让调用方补 data-* 与 aria-*；ref 不在此列，
// 容器引用由 scrollContainerRef 独立接管，传 ref 属性会被外层自行赋值覆盖。
// [权衡] markedLines 只做视觉提醒、不参与评论坐标：诊断行号来自编译器、评论行号来自用户选区，合并两者会让诊断标记污染评论。
// [生命周期] focusRequestId 只用于触发定位 effect，不参与坐标计算，必须是每次希望定位都变化一次的字符串。
export interface CodeViewerProps extends HTMLAttributes<HTMLDivElement> {
  code: string;
  enableSyntaxHighlighting?: boolean;
  language: string;
  showLineNumbers?: boolean;
  theme?: BundledTheme;
  wrapLongLines?: boolean;
  fontSizePx?: number;
  firstLineNumber?: number;
  comments?: readonly CodeCommentPreview[];
  topComment?: CodeCommentPreview | null;
  topCommentShowRange?: boolean;
  topCommentNotice?: string;
  focusedRange?: CodeCommentRange | null;
  focusRequestId?: string;
  /**
   * 需要点名的行号（1 起，与 `firstLineNumber` 同一坐标）：只把这些行的**行号**染成警示色，
   * 代码本身不动。编译反馈卡用它标出被诊断指到的行。
   */
  markedLines?: readonly number[];
  enableLineSelection?: boolean;
  enableGutterUtility?: boolean;
  labels?: Partial<CodeCommentLabels>;
  onSubmitCodeComment?: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment?: (commentId: string) => void;
  scrollContainerRef?: Ref<HTMLDivElement>;
}

// [契约] 只有未传 theme 时才探测 documentElement 上的 dark class，显式主题优先：
// 主题 token 由调用方决定，用系统偏好覆盖会让手机远控的深色卡片渲染出浅色代码。
// [失败路径] document 不存在（SSR 或非浏览器环境）时回落 light，避免直接访问未定义对象抛错。
export function resolveCodeViewerColorScheme(theme?: BundledTheme): "light" | "dark" {
  if (!theme) {
    if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
      return "dark";
    }
    return "light";
  }

  return isDarkCodePreviewTheme(theme) ? "dark" : "light";
}

// [契约] 同时支持函数式 ref 与对象 ref：React 19 的清理回调也走这里，卸载时会传入 null，
// 因此必须先判空再写 current，不能假设 value 一定非空。
// [权衡] 这里不包 try/catch：ref 回调抛错属于调用方 bug，吞掉会让父组件拿不到容器却无人察觉。
function setOptionalRefValue<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }

  if (typeof ref === "function") {
    ref(value);
    return;
  }

  (ref as { current: T | null }).current = value;
}

// [契约] 这是判别联合，renderAnnotation 靠 kind 分流；新增 kind 必须同时补渲染分支，
// 否则运行时会落到评论分支，把 range 当 comment 读并崩溃。
// [权衡] 草稿与已提交评论共用同一通道，是为了复用 @pierre/diffs 的行尾插槽排布，避免两套定位算法漂移。
type CodeViewerAnnotationMetadata =
  | {
      kind: "comment";
      comment: CodeCommentPreview;
    }
  | {
      kind: "draft";
      range: CodeCommentRange;
    };

// [契约] 这是 @pierre/diffs 回调给出的相对行区间（1 起、含端点），
// 与 CodeCommentRange 的绝对行号不同，转换必须显式经过 firstLineNumber。
interface SelectedLineRange {
  start: number;
  end: number;
}

// [契约] 自定义 CSS 变量必须在此声明类型，否则 style 对象退化成索引签名，
// 变量名拼错在编译期发现不了，而 Shadow DOM 里拼错完全不生效。
type CodeViewerStyle = CSSProperties & {
  "--code-comment-add-tooltip"?: string;
  "--diffs-bg"?: string;
  "--diffs-light-bg"?: string;
  "--diffs-dark-bg"?: string;
  "--diffs-font-family"?: string;
  "--diffs-font-size"?: string;
};

// [契约] 缺省英文文案只是兜底；产品内所有可见文案都应由调用方覆盖，
// 直接把这里改成中文会让英文界面出现中英混排。
const DEFAULT_CODE_COMMENT_LABELS: CodeCommentLabels = {
  addComment: "Add comment",
  addCommentTooltip: "Click or drag to comment",
  commentPlaceholder: "Comment",
  submitComment: "Add comment",
  cancelComment: "Cancel",
  deleteComment: "Delete comment",
  commentLine: "Line {line}",
  commentRange: "Lines {startLine}-{endLine}",
};

// [资源] unsafeCSS 注入 @pierre/diffs 的 Shadow DOM，全局生效且无法被普通选择器覆盖；
// 因此这里只写 gutter 工具按钮相关规则，不要加宽泛的 * 或 :root 选择器。
// [权衡] tooltip 用 ::after 加 CSS 变量实现，而不是自建悬浮层：自建层要跟随 Shadow DOM 的滚动与裁剪，行容器 overflow 一变就错位。
// [契约] 数组最后用 join 空串拼接，元素之间不能有分隔符。
const CODE_VIEWER_UNSAFE_CSS = [
  "[data-gutter-utility-slot]{left:auto;right:4px;justify-content:flex-end;align-items:center;}",
  "[data-utility-button]{margin-left:0;margin-right:0;}",
  "@media (hover:hover) and (pointer:fine){",
  "[data-utility-button]::after{content:var(--code-comment-add-tooltip);position:absolute;left:calc(100% + 6px);top:50%;transform:translateY(-50%);max-width:16rem;white-space:nowrap;pointer-events:none;opacity:0;z-index:5;border:1px solid var(--color-border);border-radius:8px;background:var(--color-tooltip);color:var(--color-tooltip-foreground);padding:4px 8px;font-family:var(--diffs-header-font-family,var(--diffs-header-font-fallback));font-size:12px;line-height:16px;box-shadow:0 4px 12px rgb(0 0 0 / 0.14);}",
  "[data-utility-button]:hover::after,[data-utility-button]:focus-visible::after{opacity:1;}",
  "}",
].join("");

/**
 * 被点名行号的着色规则。行号格是 @pierre/diffs 在 Shadow DOM 里画的 `[data-column-number="<行号>"]`，
 * 外层 class 进不去，只能随 unsafeCSS 注入；颜色走应用 token（自定义属性穿透 shadow root），
 * 深浅主题自动跟随。非正整数与重复值丢弃，空集合返回空串。
 */
// [契约] 返回空串表示不加规则，调用方直接拼到 unsafeCSS 尾部即可，无需判空。
// [权衡] 用属性选择器匹配行号单元格而不是 nth-child：折叠区域会跳号，
// nth-child 在折叠后整体错位。
// [资源] 输出只覆盖 color，不改变背景与字体，避免与 hover 高亮抢同一层。
export function codeViewerMarkedLinesCss(lines: readonly number[] | undefined): string {
  // [契约] 去重并过滤非正整数：诊断行号可能重复或为 0，
  // 0 会被拼进选择器变成无效选择器，导致整条规则失效而不只是那一行。
  // [权衡] 这里选择过滤而非抛错：越界诊断属于可恢复的展示问题，不应阻断整段代码渲染。
  const unique = [...new Set(lines ?? [])].filter((line) => Number.isInteger(line) && line > 0);
  if (unique.length === 0) return "";
  const selector = unique.map((line) => `[data-column-number="${line}"]`).join(",");
  return `${selector}{color:var(--color-warning);}`;
}

// [契约] 用 JSON.stringify 生成 CSS 字符串字面量：tooltip 文案可能含引号或换行，
// 手写拼接会破坏 --code-comment-add-tooltip 的值。
function toCssString(value: string) {
  return JSON.stringify(value);
}

// [契约] 这是 djb2 变体，只用于生成缓存键，不承担安全职责，碰撞后果仅限于重新高亮。
// [权衡] 32 位无符号数转 36 进制：cacheKey 会被 @pierre/diffs 当 Map 键，
// 完整哈希在长文件下只增内存不增正确性。
function hashCodeViewerContent(code: string): string {
  let hash = 5381;
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 33) ^ code.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

// [失败路径] navigator 不存在时返回空对象，让 isAppleKeyboardPlatform 走默认分支；
// 这里不能读 window，SSR 与单测环境会直接抛 ReferenceError。
// [契约] 每次调用实时读取、不缓存：测试里会改写平台信息，缓存会让用例互相污染。
function readCodeCommentShortcutPlatformInfo(): KeyboardShortcutPlatformInfo {
  if (typeof navigator === "undefined") {
    return {};
  }

  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}

// [契约] 只有 Enter 参与判定，Apple 平台用 Cmd、其余用 Ctrl：
// 这是两平台用户对“提交”的既有肌肉记忆，互换会导致误提交。
// [权衡] 入参只取需要的三个字段，便于直接把 React KeyboardEvent 传进来而不用构造完整事件。
export function isCodeCommentSubmitShortcut(
  event: Pick<ReactKeyboardEvent<HTMLTextAreaElement>, "ctrlKey" | "key" | "metaKey">,
  platformInfo: KeyboardShortcutPlatformInfo = readCodeCommentShortcutPlatformInfo(),
) {
  if (event.key !== "Enter") {
    return false;
  }

  // [契约] 返回布尔而非三态：非 Enter 或未按修饰键都算“不是提交快捷键”，
  // 调用方据此决定是否 preventDefault，绝不能把普通换行误判成提交。
  return isAppleKeyboardPlatform(platformInfo) ? event.metaKey : event.ctrlKey;
}

// [契约] 取消只认 Escape，且必须与提交判定分开：合并成一个函数会让仅取消的调用点
// 误以为需要修饰键，Esc 被忽略后用户无法退出草稿。
export function isCodeCommentCancelShortcut(
  event: Pick<ReactKeyboardEvent<HTMLTextAreaElement>, "key">,
) {
  return event.key === "Escape";
}

// [契约] 按钮上的快捷键提示必须与判定逻辑同源，否则用户会看到 Cmd 提示却在 Ctrl 下无响应，
// 反之亦然。
export function formatCodeCommentSubmitShortcutLabel(platformInfo?: KeyboardShortcutPlatformInfo) {
  return formatCommandShortcutLabel("↵", platformInfo);
}

export function formatCodeCommentCancelShortcutLabel() {
  return "Esc";
}

// [契约] 只写 title 与 aria-label，不碰 textContent 与事件：按钮内容与 pointer 逻辑由
// @pierre/diffs 内部 InteractionManager 负责，覆盖会破坏拖拽选区。
// [失败路径] 没有匹配节点时静默跳过是预期行为，不同版本的 DOM 结构并不保证存在按钮。
function patchCodeCommentUtilityButtons(root: ParentNode, label: string) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-utility-button]")) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

// [并发] 递归遍历嵌套 shadow root：行容器可能再包一层 shadow，只查顶层会漏掉真正的按钮节点。
// [资源] 每次调用都重新查询、不缓存节点：高亮重排会重建 shadow root，
// 缓存引用会指向已脱离文档的旧树。
function walkShadowRoots(root: ParentNode, callback: (root: ShadowRoot) => void) {
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) {
      continue;
    }

    callback(element.shadowRoot);
    walkShadowRoots(element.shadowRoot, callback);
  }
}

// [契约] 先查当前 root 再递归 shadow root：顶层命中率最高，避免每次都做全树遍历。
// [失败路径] 找不到返回 null 而不是抛错，调用方据此继续重试若干帧。
// [权衡] 用 data-line 而不是行号文本匹配：文本会被省略号或前缀改写，不可靠。
export function findCodeViewerLineElement(
  root: ParentNode,
  lineNumber: number,
): HTMLElement | null {
  const target = root.querySelector<HTMLElement>(`[data-line="${lineNumber}"]`);
  if (target) return target;

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const shadowTarget = findCodeViewerLineElement(element.shadowRoot, lineNumber);
    if (shadowTarget) return shadowTarget;
  }
  return null;
}

// [契约] 评论节点用 data-code-comment-id 而不是 id：同一评论可能同时出现在顶部卡片与行内插槽，
// id 会重复，data-* 允许重复查询。
// [失败路径] 无匹配返回 null，滚动定位退回按行定位，不阻断聚焦流程。
export function findCodeViewerCommentElement(
  root: ParentNode,
  commentId: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-code-comment-id]")) {
    if (element.dataset.codeCommentId === commentId) {
      return element;
    }
  }

  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (!element.shadowRoot) continue;
    const shadowTarget = findCodeViewerCommentElement(element.shadowRoot, commentId);
    if (shadowTarget) return shadowTarget;
  }
  return null;
}

// [契约] FileContents 是 @pierre/diffs 的唯一输入载体，name 同时进入 token 缓存键，
// 因此 name 必须随语言变化，否则不同语言的同内容片段会共享高亮结果。
// [权衡] 关闭高亮时把 lang 降级为 text，而不是改 options：
// 走同一条构造路径才能保证 name 与 cacheKey 规则一致，避免两套分支各自漂移。
function createCodeViewerFile(params: {
  code: string;
  enableSyntaxHighlighting: boolean;
  language: string;
  theme?: BundledTheme;
}): FileContents {
  // [契约] enableSyntaxHighlighting 只影响 lang，不影响内容与行数：
  // 关闭高亮后行号与评论坐标必须完全不变，否则同一段代码在两种模式下评论位置会跳。
  // [失败路径] language 为空时兜底为 text 与 preview.txt，避免生成无扩展名的文件名。
  const lang = params.enableSyntaxHighlighting
    ? (params.language as SupportedLanguages)
    : ("text" as SupportedLanguages);
  const name = params.language ? `preview.${params.language}` : "preview.txt";
  const themeCacheKey = params.theme ?? "auto";

  return {
    name,
    contents: params.code,
    lang,
    // @pierre/diffs 会按 file.cacheKey 复用 token；旧 key 没带主题，导致同一 task 内
    // 切换 app light/dark 时继续命中旧高亮，只有切换 task 触发重建后才恢复。
    cacheKey: `${themeCacheKey}:${name}:${lang}:${params.code.length}:${hashCodeViewerContent(params.code)}`,
  };
}

// [契约] 只交换起止行、不做越界裁剪：越界属于调用方错误，
// 在这里静默夹取会让“评论挂错行”更难排查。
function normalizeRange(range: CodeCommentRange): CodeCommentRange {
  return {
    startLine: Math.min(range.startLine, range.endLine),
    endLine: Math.max(range.startLine, range.endLine),
  };
}

// [契约] 组件内选区是相对行，必须先加 firstLineNumber 再减 1；
// 少减 1 会让非 1 起始片段的所有评论整体上移一行。
function selectedRangeToCodeCommentRange(
  range: SelectedLineRange,
  firstLineNumber: number,
): CodeCommentRange {
  return normalizeRange({
    startLine: firstLineNumber + range.start - 1,
    endLine: firstLineNumber + range.end - 1,
  });
}

// [契约] 与 selectedRangeToCodeCommentRange 互为逆运算，改动一侧必须同步另一侧，
// 否则草稿高亮区间与实际评论行会错位。
function codeCommentRangeToSelectedRange(
  range: CodeCommentRange,
  firstLineNumber: number,
): SelectedLineRange {
  const normalizedRange = normalizeRange(range);
  return {
    start: normalizedRange.startLine - firstLineNumber + 1,
    end: normalizedRange.endLine - firstLineNumber + 1,
  };
}

// [契约] 按行切分而不是按字符偏移取：评论数量少，代价可接受，换来与行号一一对应。
// [失败路径] 越界时把索引夹到有效范围并返回空串，避免反向 slice 取出整段代码当成引用内容。
// [权衡] 结果不做 trim：引用文本要原样保留缩进，缩进本身是代码语义的一部分。
function getTextForLineRange(code: string, firstLineNumber: number, range: CodeCommentRange) {
  const lines = code.split("\n");
  const normalizedRange = normalizeRange(range);
  const startIndex = Math.max(normalizedRange.startLine - firstLineNumber, 0);
  const endIndex = Math.min(normalizedRange.endLine - firstLineNumber, lines.length - 1);
  if (startIndex > endIndex) {
    return "";
  }

  return lines.slice(startIndex, endIndex + 1).join("\n");
}

// [契约] 单行与多行用不同文案键，占位符用 replaceAll 替换：文案由调用方提供，
// 不能假设占位符顺序或位置。
function formatCommentRange(labels: CodeCommentLabels, range: CodeCommentRange) {
  const normalizedRange = normalizeRange(range);
  if (normalizedRange.startLine === normalizedRange.endLine) {
    return labels.commentLine.replaceAll("{line}", String(normalizedRange.startLine));
  }

  return labels.commentRange
    .replaceAll("{startLine}", String(normalizedRange.startLine))
    .replaceAll("{endLine}", String(normalizedRange.endLine));
}

// [契约] 草稿框是受控组件，value 与 onValueChange 都由 CodeViewer 持有：
// 关闭后重新打开必须清空，状态留在这里就无法被外部重置。
// [并发] 聚焦放在 rAF 里等一帧，是因为插槽刚挂载时 textarea 尚未完成布局，直接 focus 可能被滚动打断。
function CommentDraft({
  range,
  labels,
  value,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  range: CodeCommentRange;
  labels: CodeCommentLabels;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  // [契约] 按钮文案把快捷键拼进括号，且与判定逻辑同源：写死字符串会出现提示能按、实际不响应。
  // [权衡] autoFocus 属性与 rAF focus 并存：前者覆盖挂载即聚焦的常见路径，
  // 后者兜住插槽延迟插入的路径，重复聚焦无副作用。
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelShortcutLabel = formatCodeCommentCancelShortcutLabel();
  const cancelLabel = `${labels.cancelComment} (${cancelShortcutLabel})`;
  const submitShortcutLabel = formatCodeCommentSubmitShortcutLabel();
  const submitLabel = `${labels.submitComment} (${submitShortcutLabel})`;

  useEffect(() => {
    // [资源] 卸载时必须 cancelAnimationFrame，否则回调会在组件销毁后执行，
    // 访问已置空的 textareaRef 并抢走其他输入框的焦点。
    // [契约] 空依赖是有意的：只在挂载时聚焦一次，value 变化不应重置光标。
    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <div className="m-2 rounded-lg border border-border bg-background p-3 font-sans shadow-sm">
      <div className="mb-2 text-ui-base text-foreground-subtle">
        {formatCommentRange(labels, range)}
      </div>
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (isCodeCommentSubmitShortcut(event)) {
            event.preventDefault();
            onSubmit();
            return;
          }

          if (!isCodeCommentCancelShortcut(event)) {
            return;
          }

          event.preventDefault();
          onCancel();
        }}
        placeholder={labels.commentPlaceholder}
        className="min-h-16 w-full resize-none rounded-lg border-input-border bg-input text-ui-base text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
        rows={3}
        autoFocus
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          title={cancelLabel}
          aria-label={cancelLabel}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button type="button" title={submitLabel} aria-label={submitLabel} onClick={onSubmit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// [契约] 顶部评论与行内评论共用此组件，showRange 只控制是否显示行号标题：
// 顶部卡片已由外层给出上下文，重复显示行号会让同一信息出现两次。
// [失败路径] 正文为空时整段不渲染，避免留下空白卡片占位。
export function CodeCommentAnnotation({
  comment,
  labels,
  onDelete,
  showRange = true,
}: {
  comment: CodeCommentPreview;
  labels: CodeCommentLabels;
  onDelete?: (commentId: string) => void;
  showRange?: boolean;
}) {
  return (
    <div
      data-code-comment-id={comment.id}
      className="m-2 rounded-lg border border-border bg-background p-3 font-sans shadow-sm"
    >
      {showRange ? (
        <div className="mb-2 text-ui-base text-foreground-subtle">
          {formatCommentRange(labels, comment)}
        </div>
      ) : null}
      {comment.comment.trim() ? (
        <div className="whitespace-pre-wrap text-ui-base leading-relaxed text-foreground">
          {comment.comment}
        </div>
      ) : null}
      {onDelete ? (
        <div className="mt-2 flex items-center justify-end">
          <Button
            type="button"
            variant="ghost"
            className="text-foreground-subtle hover:text-foreground"
            title={labels.deleteComment}
            aria-label={labels.deleteComment}
            onClick={() => onDelete(comment.id)}
          >
            <Trash2Icon className="size-4" />
            {labels.deleteComment}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// [契约] 默认开高亮、开行号、关换行：评论依赖行号稳定，
// 换行只改变行的视觉高度、不改变行号，默认开启会让人误判评论落点。
// [权衡] comments 默认为空数组而不是 undefined，避免每次渲染新建数组参与 memo 依赖比较。
// [契约] labelOverrides 只做浅合并，未覆盖的键回落到 DEFAULT_CODE_COMMENT_LABELS。
export function CodeViewer({
  code,
  enableSyntaxHighlighting = true,
  language,
  showLineNumbers = true,
  theme,
  wrapLongLines = false,
  fontSizePx = 12,
  firstLineNumber = 1,
  comments = [],
  topComment = null,
  topCommentShowRange = true,
  topCommentNotice,
  focusedRange = null,
  focusRequestId,
  markedLines,
  enableLineSelection = false,
  enableGutterUtility = false,
  labels: labelOverrides,
  onSubmitCodeComment,
  onDeleteCodeComment,
  scrollContainerRef,
  className,
  style,
  ...props
}: CodeViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const [activeDraftRange, setActiveDraftRange] = useState<CodeCommentRange | null>(null);
  const [draftText, setDraftText] = useState("");
  // [契约] 能否评论只由回调是否存在决定，不看 enableLineSelection：
  // 前者是能力开关、后者是交互开关，能力缺失时交互必须整体关闭。
  // [失败路径] 只关按钮但保留 hover 会让只读代码看起来仍可评论，因此下面两个派生开关都与该值取与。
  const canCreateComment = Boolean(onSubmitCodeComment);
  /* markdown 代码块也复用 CodeViewer。之前只关闭评论按钮但保留行 hover，
     会让只读代码看起来仍可进入评论交互；这里把官方交互开关收敛到评论能力上。 */
  const canUseCommentLineSelection = canCreateComment && enableLineSelection;
  // [契约] 该值同时决定官方 gutter 交互与本地 DOM 补丁 effect 是否启动，
  // 两条路径必须共用一个真值，否则会出现按钮存在但补丁没跑，或反之。
  // [权衡] 不用 useState 保存：派生值在渲染期计算，避免状态与 props 不一致的一帧。
  const canUseCommentGutterUtility = canCreateComment && enableGutterUtility;
  // [契约] 依赖是 labelOverrides 引用：调用方若在 render 内新建对象，这里会每次重算，
  // 并逐层触发 options 重建，最终导致 File 重排。调用方有责任缓存该对象。
  // [权衡] 不做深比较：浅合成本身很便宜，文案较多时深比较反而更贵。
  const labels = useMemo(
    () => ({ ...DEFAULT_CODE_COMMENT_LABELS, ...labelOverrides }),
    [labelOverrides],
  );
  // [契约] file 只在内容、语言、主题、高亮开关变化时重建，它是 File 组件的重挂载信号。
  // [生命周期] theme 必须进入依赖：@pierre/diffs 按 cacheKey 复用 token，主题不进键就切不了深浅色。
  const file = useMemo(
    () =>
      createCodeViewerFile({
        code,
        enableSyntaxHighlighting,
        language,
        theme,
      }),
    [code, enableSyntaxHighlighting, language, theme],
  );
  // [契约] 标注挂在区间末行之后，lineNumber 取 endLine：
  // 多行评论若挂起始行，视觉上会插到代码上方，被读成上一行的注释。
  // [并发] 评论先入列、草稿后入列：同一行同时存在时草稿排在后面，保证刚点开的输入框在已提交评论下方。
  // [契约] 顺序必须稳定，改成 Set 或按行号排序会打乱同行相对次序。
  const lineAnnotations = useMemo<LineAnnotation<CodeViewerAnnotationMetadata>[]>(() => {
    const annotations: LineAnnotation<CodeViewerAnnotationMetadata>[] = [];

    // [失败路径] 行号小于 1 直接跳过而不是抛错：firstLineNumber 大于评论行号说明数据已过期
    // （例如文件被截断），跳过可以让其余评论继续显示。
    // [契约] 这里不复制 comment，metadata 只持有引用，避免副本与外部状态失联。
    for (const comment of comments) {
      const lineNumber = normalizeRange(comment).endLine - firstLineNumber + 1;
      if (lineNumber < 1) {
        continue;
      }

      annotations.push({
        lineNumber,
        metadata: {
          kind: "comment",
          comment,
        },
      });
    }

    if (canCreateComment && activeDraftRange) {
      annotations.push({
        lineNumber: normalizeRange(activeDraftRange).endLine - firstLineNumber + 1,
        metadata: {
          kind: "draft",
          range: activeDraftRange,
        },
      });
    }

    return annotations;
  }, [activeDraftRange, canCreateComment, comments, firstLineNumber]);
  // [契约] 草稿选区优先于外部聚焦选区：用户正在输入时不能被一次外部焦点请求抢走高亮。
  // [权衡] 两者都是派生值而非状态，因此不需要额外同步 effect。
  // [失败路径] 都为空时返回 null 而不是空区间对象，避免把 0 行当成可渲染选区。
  const selectedLines = useMemo(() => {
    if (canCreateComment && activeDraftRange) {
      return codeCommentRangeToSelectedRange(activeDraftRange, firstLineNumber);
    }
    return focusedRange ? codeCommentRangeToSelectedRange(focusedRange, firstLineNumber) : null;
  }, [activeDraftRange, canCreateComment, firstLineNumber, focusedRange]);
  // [契约] 选区结束立刻清空草稿文本：换一段代码再评论必须从空开始，
  // 否则会把上一条未提交内容带过去。
  // [失败路径] range 为空（只是点击未拖动）直接返回，不打开草稿框。
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!canCreateComment || !range) {
        return;
      }

      setActiveDraftRange(selectedRangeToCodeCommentRange(range, firstLineNumber));
      setDraftText("");
    },
    [canCreateComment, firstLineNumber],
  );
  // [契约] gutter 点击与拖拽走同一套相对行换算，两条入口的 range 语义必须一致，
  // 分别实现很容易出现点击一行、拖拽差一行的偏差。
  const handleGutterUtilitySelection = useCallback(
    (range: SelectedLineRange) => {
      if (!canCreateComment) {
        return;
      }

      setActiveDraftRange(selectedRangeToCodeCommentRange(range, firstLineNumber));
      setDraftText("");
    },
    [canCreateComment, firstLineNumber],
  );
  // [契约] 提交前重新从 code 切片取文本，而不是复用选区时的快照：
  // 代码可能在草稿期间被上层替换，旧快照会让引用文本与当前行号错配。
  // [失败路径] 回调可能为空（能力在草稿期间被收回），用可选调用吞掉，
  // 但仍清空本地草稿，避免卡在无法关闭的输入态。
  // [事务] 无论回调结果如何都清草稿：取消语义由取消按钮负责，这里只保证不残留半成品状态。
  const handleSubmitDraft = useCallback(() => {
    if (!activeDraftRange) {
      return;
    }

    const selectedText = getTextForLineRange(code, firstLineNumber, activeDraftRange);
    // [失败路径] 全空白选区视为无效：保存下来是空引用评论，
    // 行号还可能越界，后端无法定位展示。
    if (!selectedText.trim()) {
      return;
    }

    onSubmitCodeComment?.({
      range: normalizeRange(activeDraftRange),
      selectedText,
      comment: draftText.trim(),
    });
    setActiveDraftRange(null);
    setDraftText("");
  }, [activeDraftRange, code, draftText, firstLineNumber, onSubmitCodeComment]);
  useEffect(() => {
    if (!canUseCommentGutterUtility || !viewerRef.current) {
      return;
    }

    const root = viewerRef.current;
    const observers: MutationObserver[] = [];
    const observedRoots = new WeakSet<Node>();
    let animationFrame = 0;

    // [资源] observedRoots 用 WeakSet 去重：同一 shadow root 会在 patch 与遍历中重复传入，
    // 不去重会成倍新增 observer。
    // [并发] observer 回调不直接改 DOM，而是走合帧补丁，避免在 mutation 回调里再次触发 mutation。
    const observeRoot = (target: ParentNode) => {
      if (observedRoots.has(target)) {
        return;
      }

      observedRoots.add(target);
      const observer = new MutationObserver(schedulePatch);
      observer.observe(target, { childList: true, subtree: true });
      observers.push(observer);
    };

    // [契约] 补丁必须覆盖当前 root 与所有已发现 shadow root：
    // 只补顶层会漏掉行内容区，只补 shadow 会漏掉按钮放在顶层的实现。
    // [失败路径] 节点已卸载时补丁失败不抛错：后续 mutation 会重新触发，属于自愈路径。
    const patch = () => {
      patchCodeCommentUtilityButtons(root, labels.addCommentTooltip);
      walkShadowRoots(root, (shadowRoot) => {
        observeRoot(shadowRoot);
        patchCodeCommentUtilityButtons(shadowRoot, labels.addCommentTooltip);
      });
    };

    // [并发] animationFrame 句柄兼作已排队标志，必须在回调里先清零再执行补丁：
    // 否则补丁内部触发的 mutation 会被判定为已排队而丢失。
    // [权衡] 用 rAF 而不是 setTimeout 0：与绘制同帧，避免补丁结果晚一帧才可见。
    function schedulePatch() {
      if (animationFrame) {
        return;
      }

      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        patch();
      });
    }

    // @pierre/diffs 的内建 gutter button 由内部 InteractionManager 生成。
    // 这里只补充 title/aria-label，不接管渲染或 pointer 事件，避免破坏拖拽选择多行评论。
    observeRoot(root);
    patch();
    schedulePatch();

    return () => {
      if (animationFrame) {
        window.cancelAnimationFrame(animationFrame);
      }
      for (const observer of observers) {
        observer.disconnect();
      }
    };
  }, [canUseCommentGutterUtility, labels.addCommentTooltip]);
  // [契约] 依赖列表用拆出的原始行号而不是 focusedRange 对象：
  // 上层每次渲染新建对象时，用对象做依赖会让定位 effect 反复重跑。
  const focusedStartLine = focusedRange?.startLine;
  const focusedEndLine = focusedRange?.endLine;
  useEffect(() => {
    if (!focusRequestId || focusedStartLine === undefined || !viewerRef.current) {
      return;
    }

    let animationFrame = 0;
    let attempts = 0;
    const targetLine = focusedStartLine - firstLineNumber + 1;
    // [契约] 评论节点优先于代码行：用户点的是评论卡片，评论必须在视口内，
    // 只定位代码行会看不到刚展开的内容。
    // [资源] 每帧重新查询节点、不复用上一帧引用：布局与高亮会重建节点，旧引用已脱离文档。
    const scrollToFocusedLine = () => {
      const container = viewerRef.current;
      const line = viewerRef.current
        ? findCodeViewerLineElement(viewerRef.current, targetLine)
        : null;
      const comment =
        focusRequestId && viewerRef.current
          ? findCodeViewerCommentElement(viewerRef.current, focusRequestId)
          : null;
      if (container && comment) {
        const containerRect = container.getBoundingClientRect();
        const commentRect = comment.getBoundingClientRect();
        const horizontalScrollLeft = container.scrollLeft;
        const commentBottom = container.scrollTop + commentRect.bottom - containerRect.top;
        // 评论跟随代码滚动，但点击卡片时把评论底部放在可视区下沿，
        // 让目标行和其下评论同时出现；只写 scrollTop，避免 scrollIntoView 改变横向位置。
        container.scrollTop = Math.max(0, commentBottom - container.clientHeight + 12);
        container.scrollLeft = horizontalScrollLeft;
        return;
      }
      if (container && line) {
        const containerRect = container.getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        const horizontalScrollLeft = container.scrollLeft;
        const lineCenter =
          container.scrollTop + lineRect.top - containerRect.top + lineRect.height / 2;
        container.scrollTop = Math.max(0, lineCenter - container.clientHeight / 2);
        container.scrollLeft = horizontalScrollLeft;
        return;
      }

      // [失败路径] 45 帧约 0.75 秒，覆盖 Shadow DOM 异步创建与高亮完成；
      // 超限仍未命中说明行号本身无效，继续重试只会持续占用主线程。
      // [契约] 失败后静默放弃：定位是增强能力，不应向上抛错打断代码渲染。
      attempts += 1;
      if (attempts < 45) {
        animationFrame = window.requestAnimationFrame(scrollToFocusedLine);
      }
    };

    // @pierre/diffs 的真实代码行位于异步创建的 Shadow DOM 中；仅传
    // selectedLines 会高亮但不会定位。requestId 变化时短暂重试，确保同 tab 新评论可滚动。
    animationFrame = window.requestAnimationFrame(scrollToFocusedLine);
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [file.cacheKey, firstLineNumber, focusedEndLine, focusedStartLine, focusRequestId]);
  // 依赖是 CSS 字符串（内容）而不是数组引用：调用方每次渲染给一个新数组时，options 不该跟着换（File 会重排）。
  // [契约] 这里直接调用纯函数而不加 useMemo：函数只做去重与拼接，
  // options 的依赖已用字符串内容做键，再包一层 memo 只是多一次依赖比较。
  // [权衡] 返回空串时与基础 CSS 拼接无副作用，因此省掉一个分支。
  const markedLinesCss = codeViewerMarkedLinesCss(markedLines);
  // [契约] options 是 File 的行为契约对象，任何字段变化都应触发重建；依赖必须逐个列出派生值，
  // 漏项会让 File 继续持有旧回调，例如评论能力收回后仍可拖选。
  // [事务] 选区、gutter 与 hover 高亮三者必须同源：只开选区不开 hover 会让用户找不到可拖拽位置。
  // [契约] unsafeCSS 的拼接顺序是基础样式在前、行号着色在后，后者才能覆盖前者。
  const options = useMemo<FileOptions<CodeViewerAnnotationMetadata>>(
    () => ({
      // [契约] 文件头由外层布局决定，这里必须关闭内建文件头，避免同一视图出现两个文件名与操作条；
      // 行号开关则直接映射 props，不额外推导。
      disableFileHeader: true,
      disableLineNumbers: !showLineNumbers,
      overflow: wrapLongLines ? "wrap" : "scroll",
      theme,
      preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
      enableLineSelection: canUseCommentLineSelection,
      enableGutterUtility: canUseCommentGutterUtility,
      lineHoverHighlight:
        canUseCommentLineSelection || canUseCommentGutterUtility ? "both" : "disabled",
      onLineSelectionEnd: handleLineSelectionEnd,
      // 自定义 renderGutterUtility 只能拿 hover 行，拖拽 comment + 时会退化成单行。
      // 使用 @pierre/diffs 的 gutter selection 回调，让点击和拖拽都走同一套 range 计算。
      onGutterUtilityClick: canUseCommentGutterUtility ? handleGutterUtilitySelection : undefined,
      // 内建 comment + 默认贴在行号右侧，用户拖拽时容易和代码起点混在一起。
      // 这里只调整 Shadow DOM 内 gutter utility 的位置，不接管 pointer 事件，避免破坏多行拖拽 range。
      unsafeCSS: CODE_VIEWER_UNSAFE_CSS + markedLinesCss,
    }),
    [
      canUseCommentGutterUtility,
      canUseCommentLineSelection,
      handleGutterUtilitySelection,
      handleLineSelectionEnd,
      markedLinesCss,
      showLineNumbers,
      theme,
      wrapLongLines,
    ],
  );
  // [契约] colorScheme 必须跟代码主题而不是系统偏好：@pierre/diffs 的 token 依赖 light-dark()，
  // 系统浅色配深色卡片会让代码文字变深，看起来像正文丢失。
  // [契约] 浅色、深色、自动三种背景变量要同时覆盖，只改一个会在另一主题下露出宿主底色。
  // [契约] 字体族显式传 --font-mono：Shadow DOM 内的 fallback 不含中文字体，Windows 下会落到宋体。
  const viewerStyle = useMemo<CodeViewerStyle>(
    () => ({
      // 手机远控页面可能是深色主题，但浏览器系统偏好仍是浅色。
      // @pierre/diffs 的 token 颜色依赖 color-scheme/light-dark()，必须跟随代码主题显式指定，
      // 否则 text 代码块会在深色卡片上渲染成浅色主题的深色文字，看起来像正文丢失。
      colorScheme: resolveCodeViewerColorScheme(theme),
      "--diffs-bg": "var(--color-background)",
      "--diffs-light-bg": "var(--color-background)",
      "--diffs-dark-bg": "var(--color-background)",
      // @pierre/diffs 在 Shadow DOM 内使用自己的等宽 fallback，Windows 中文会落到宋体。
      // 显式透传应用 token，让 Markdown code block、文件预览和 inline code 使用同一 CJK fallback。
      "--diffs-font-family": "var(--font-mono)",
      "--diffs-font-size": `${fontSizePx}px`,
      "--code-comment-add-tooltip": toCssString(
        canUseCommentGutterUtility ? labels.addCommentTooltip : "",
      ),
      ...style,
    }),
    [canUseCommentGutterUtility, fontSizePx, labels.addCommentTooltip, style, theme],
  );
  // [契约] 内部 ref 与外部 ref 必须同时写入：内部用于节点查询与滚动定位，外部供调用方监听滚动；
  // 只写一处会让一方静默失效。
  // [生命周期] 这里不需要显式清理：卸载时 React 会以 null 再调用一次，两个目标都会收到 null。
  const assignCodeViewerScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      viewerRef.current = node;
      setOptionalRefValue(scrollContainerRef, node);
    },
    [scrollContainerRef],
  );

  return (
    <div
      ref={assignCodeViewerScrollContainerRef}
      className={cn("h-full w-full overflow-auto", className)}
      data-language={language}
      style={viewerStyle}
      {...props}
    >
      {topCommentNotice ? (
        <div data-code-review-target-warning className="px-3 pt-3 text-ui-sm text-warning">
          {topCommentNotice}
        </div>
      ) : null}
      {topComment ? (
        <CodeCommentAnnotation
          comment={topComment}
          labels={labels}
          showRange={topCommentShowRange}
        />
      ) : null}
      <File
        key={file.cacheKey}
        file={file}
        options={options}
        lineAnnotations={lineAnnotations}
        selectedLines={selectedLines}
        className="min-h-full w-full"
        style={viewerStyle}
        renderAnnotation={(annotation) =>
          annotation.metadata.kind === "draft" ? (
            <CommentDraft
              range={annotation.metadata.range}
              labels={labels}
              value={draftText}
              onValueChange={setDraftText}
              onSubmit={handleSubmitDraft}
              onCancel={() => {
                setActiveDraftRange(null);
                setDraftText("");
              }}
            />
          ) : (
            <CodeCommentAnnotation
              comment={annotation.metadata.comment}
              labels={labels}
              onDelete={onDeleteCodeComment}
            />
          )
        }
      />
    </div>
  );
}
