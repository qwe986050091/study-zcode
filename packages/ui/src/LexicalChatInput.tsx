/* eslint-disable max-lines */
/**
 * LexicalChatInput — 基于 Lexical 的聊天输入框
 *
 * 基于 Lexical 的聊天输入框，支持 slash command 和 mention tag。
 * - Enter 发送，Shift+Enter 换行
 * - 支持 IME 输入
 * - 自动高度（默认显示 3 行，超出后滚动）
 * - disabled 状态
 * - 通过 SlashCommandPlugin / MentionPlugin 支持 `/` / `@` 的触发面板
 *
 * 独立输入展示壳，不承载会话编排逻辑，仅做三处适配：
 * 1. useChatViewActiveTaskProvider 来自 @/v4/activeTaskProvider.js（配置面读取）；
 * 2. ChatComposerPasteEvent 收口为本文件导出的结构类型；
 * 3. mention 面板用 enableMentionPanel 控制；slash command 始终读取 CLI workspace catalog。
 */
// ============================================================================
// LexicalChatInput.tsx — 基于 Lexical 的聊天输入框（纯展示壳）
//
// 职责边界：
//   - 只负责编辑、键位、选区、序列化与对外 API；不承载会话编排、不发送请求。
//   - 提交与否由 onSubmit 的返回值决定（false = 业务层拒收，草稿必须保留）。
//   - 所有程序化改写都必须带 PROGRAMMATIC_UPDATE_TAG；历史回填用专用 tag。
//
// 本文件的三层结构：
//   1) 纯函数层：shouldSubmit* / shouldNormalize* / getEditorMarkdown 等，可单测；
//   2) 编辑器操作层：replaceEditor* / appendEditor* / insertEditorMention；
//   3) 插件层：Keyboard / TextContent / History / Alias / Paste / API / E2E。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 IME 组合态内的 Enter 一律不拦截（return false）。
//   守住它的位置：KeyboardPlugin 的 event.isComposing 早退。
//   改错故障：中文/日文输入法选词时按 Enter 直接发送半截句子。
//
// INV-02 disabled 时 Enter 被吞掉（preventDefault + return true），而不是放行换行。
//   守住它的位置：KeyboardPlugin 的 disabled 分支。
//   改错故障：禁用态下换行符被写进不可提交的草稿，恢复后内容带一堆空行。
//
// INV-03 submitDisabled 时不提交，但必须把 Enter 退回 Lexical 做换行。
//   守住它的位置：main chain 的 if (submitDisabled || !enterSubmits) return false;
//   改错故障：请求进行中输入框完全失效；或反过来误触发第二次提交并清空草稿。
//
// INV-04 是否清空编辑器只由 onSubmit 的返回值决定，result === false 时保留草稿。
//   守住它的位置：shouldResetLexicalEditorAfterSubmit 的全部调用点。
//   改错故障：业务层拒收（如附件未就绪）时用户输入被吃掉。
//
// INV-05 用户键位表优先于内置默认：newline 立即放行，send 走等价门禁。
//   守住它的位置：resolveComposerKeyAction 之后的两个分支。
//   改错故障：改绑后按键死绑定，或裸 Enter 同时既发送又换行。
//
// INV-06 生效绑定不含裸 Enter 时，裸 Enter 必须回退为换行。
//   守住它的位置：shouldBareEnterFallThroughToNewline 的前置检查。
//   改错故障：Ctrl+Enter 党改绑后，裸 Enter 仍然发送，与预期相反。
//
// INV-07 反转投递（Ctrl/Meta+Enter）优先于作用域 send，避免语义被键位表覆盖。
//   守住它的位置：modifiedScopedEnter && onModifiedSubmit 的让位判断。
//   改错故障：Ctrl+Enter 被当作普通发送，丢掉了「反向 delivery」这个更具体的交付语义。
//
// INV-08 Backspace 只有在「光标位于补位空格后、且文本恰为一个空格」时才连 token 一起删。
//   守住它的位置：KEY_BACKSPACE_COMMAND 里的 offset/text/previousSibling 三重判断。
//   改错故障：正常删除单个空格失败；或误删正文后的 mention。
//
// INV-09 mention 是原子节点，Option+ArrowRight 不得把光标落进 token 内部。
//   守住它的位置：root keydown capture 里的 preventDefault + selectAfterPromptMentionById。
//   改错故障：下一次输入把 token 当普通文本替换掉，mention 静默丢失。
//
// INV-10 前缀插入 mention 必须保留既有节点，不能用 getMarkdown → setMention 重建。
//   守住它的位置：prependEditorMentionIfMissing 直接在 root 上插入节点。
//   改错故障：已有 Plugin/文件/Skill chip 被序列化成纯文本，全部降级。
//
// INV-11 replaceEditorText 必须按空行分段重建段落。
//   守住它的位置：text.split 之后逐段创建 paragraph 的循环。
//   改错故障：Lexical 的 getTextContent 用双换行分段，不对称处理会让换行翻倍或丢失。
//
// INV-12 历史回填必须用 HISTORY_NAVIGATION_UPDATE_TAG，不能用通用程序化 tag。
//   守住它的位置：applyHistoryEntry 的 editor.update 选项。
//   改错故障：回填含 / 的历史条目时 slash 面板重开，并以 CRITICAL 优先级吞掉方向键。
//
// INV-13 历史导航只在「空输入」或「已在历史浏览态」时接管上下键。
//   守住它的位置：currentIndex === null && text.length > 0 的早退。
//   改错故障：多行输入无法用上下键移动光标，直接跳到上一条历史。
//
// INV-14 用户手动编辑后必须退出历史浏览态。
//   守住它的位置：update listener 里 markdown 与 entries[currentIndex] 的比较。
//   改错故障：编辑后再按上键会从旧索引继续，出现内容跳变。
//
// INV-15 顿号别名只在「全文开头 + insertText + 非组合态」时归一为 /。
//   守住它的位置：shouldNormalizeLeadingChineseSlashAliasInput 的四个条件。
//   改错故障：正文中间输入顿号也被替换成斜杠，中文标点无法输入。
//
// INV-16 粘贴被业务层接管（defaultPrevented 由 false 变 true）后必须阻断后续传播。
//   守住它的位置：PasteCapturePlugin 的 wasDefaultPrevented 比较 + stopImmediatePropagation。
//   改错故障：长文本已转成附件，正文里又插入一份，提交两份内容。
//
// INV-17 程序化输入与 IME 组合态不得计入打字卡顿。
//   守住它的位置：recordInputLag 的 isProgrammatic / isComposing 入参。
//   改错故障：每次预填或历史回填都上报一次高延迟，性能看板全是假告警。
//
// INV-18 compositionend 后置 false 必须延后到微任务，不能在事件内同步置 false。
//   守住它的位置：queueMicrotask 包住 composingRef.current = false。
//   改错故障：中文长文本组合提交那一拍被误判为卡顿。
//
// INV-19 程序化插入 mention 前必须校验旧选区节点仍存在，否则回退到末尾。
//   守住它的位置：insertEditorMention 的 $getNodeByKey 双检查。
//   改错故障：菜单打开期间草稿被替换，恢复旧选区时 Lexical 直接抛错。
//
// INV-20 editorApiRef 注册与注销必须成对，卸载时置 null。
//   守住它的位置：EditorApiPlugin 的 effect 返回函数。
//   改错故障：父组件持有已卸载编辑器的句柄，调用 clear/focus 时抛 null 访问。
//
// INV-21 initialConfig 必须 useMemo 固定引用。
//   守住它的位置：initialConfig 的依赖数组为空。
//   改错故障：每次渲染新建配置，composer 子树被判定 props 变化，输入时整块重渲染。
//
// INV-22 首帧打点必须按 readyLogKey 去重，并在 rAF 里执行。
//   守住它的位置：lastReadyLogKeyRef 比较与 requestAnimationFrame。
//   改错故障：每次 props 变化都打一条「首帧完成」，耗时数据失真。
// ============================================================================
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { PromptClipboardPlugin } from "@/mentions/PromptClipboardPlugin.js";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
} from "@/shortcuts/composerShortcuts.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
// [权衡] 这里只用到四个 React hook；不引入 useState 是刻意的——
// 输入内容全部由 Lexical 持有，React 侧复制一份会造成双写与光标跳动。
import { useCallback, useEffect, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $getNodeByKey,
  $setSelection,
  $getRoot,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import { SlashCommandPlugin } from "./SlashCommandPlugin.js";
import type { AppSlashCommand } from "./slashCommandHelpers.js";
import { MentionPlugin } from "./mentions/MentionPlugin.js";
import { useChatViewActiveTaskProvider } from "@/v4/activeTaskProvider.js";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
  PromptMentionNode,
} from "./mentions/nodes/PromptMentionNode.js";
import { logger } from "./logger.js";
import { recordInputLag } from "./lib/uiPerfArmsTelemetry.js";
import { navigatePromptHistory } from "./lib/promptHistory.js";
import { resolveMobileInputTextSizeClassName } from "@/lib/mobileTextInput.js";
import type { MentionItemData } from "@/mentions/mentionTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

/** 旧 useChatComposer 已删；粘贴事件收口为最小结构类型（ClipboardEvent 结构兼容）。 */
// [权衡] 只声明粘贴所需的三个成员，而不是直接用 ClipboardEvent：
// Web 与桌面壳的 ClipboardEvent 实现不同，最小结构类型让调用方与测试都容易构造。
export interface ChatComposerPasteEvent {
  clipboardData: DataTransfer | null;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

// 对外命令式 API。所有方法都必须同步生效于 Lexical 编辑器，
// 调用方（Composer）只通过 ref 驱动，不直接访问 editor 实例。
export interface LexicalChatInputHandle {
  clear: () => void;
  focus: () => void;
  getEditorState: () => EditorState;
  getMarkdown: () => string;
  getText: () => string;
  appendText: (text: string) => void;
  appendFileMention: (
    label: string,
    value: string,
    markdown: string,
    data?: MentionItemData,
    trailingText?: string,
  ) => void;
  prependMentionIfMissing: (mention: ComposerMentionPrefill) => boolean;
  setMention: (mention: ComposerMentionPrefill, trailingText?: string) => void;
  insertMention: (mention: ComposerMentionPrefill, selectionState?: EditorState) => void;
  setText: (text: string) => void;
  setTextWithPluginMentions: (text: string) => void;
  setEditorStateJson: (editorStateJson: string) => void;
  setSkillMention: (skillName: string, markdown?: string, trailingText?: string) => void;
  setSlashCommandMention: (commandName: string, markdown?: string, trailingText?: string) => void;
}

interface LexicalEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  enterSubmits: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  text: string;
}

interface LexicalModifiedEnterSubmitOptions {
  allowSubmitWhenEmpty?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  modifiedEnterSubmits: boolean;
  shiftKey?: boolean;
  text: string;
}

export type LexicalSubmitResult = boolean | void;

interface LeadingChineseSlashAliasInputOptions {
  data: string | null;
  inputType: string;
  isAtEditorStart: boolean;
  isComposing?: boolean;
}

const CHINESE_SLASH_ALIAS = "、";
const STANDARD_SLASH_TRIGGER = "/";

// [权衡] 这两个 tag 放在 import 之后的独立位置，是为了让它们与上层 import 块区分开；
// tag 的语义是跨插件的契约（见 INV-12），改动需全仓搜索。
import { HISTORY_NAVIGATION_UPDATE_TAG, PROGRAMMATIC_UPDATE_TAG } from "./lib/editorUpdateTags.js";

// 裸 Enter 是否提交的唯一判定。拆成纯函数是为了让键位组合的矩阵可单测，
// KeyboardPlugin 内不得再写第二套等价判断。
export function shouldSubmitLexicalEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  enterSubmits,
  isComposing = false,
  metaKey = false,
  shiftKey = false,
  text,
}: LexicalEnterSubmitOptions): boolean {
  // [失败路径] enterSubmits=false（移动端视口策略）时直接拒绝，
  // 此判断必须最先执行，不能与修饰键判断交换顺序。
  if (!enterSubmits) {
    return false;
  }
  // 任一修饰键或组合态都视为「不提交」；注意这里不看 altKey——
  // Alt 组合由上层快捷方式处理，Enter+Alt 不构成提交语义。
  if (shiftKey || ctrlKey || metaKey || isComposing) {
    return false;
  }
  // [权衡] 用 trim 后的文本判空：只有空格的草稿不发送；
  // allowSubmitWhenEmpty 供「空 Enter 触发引导」这类入口显式放开。
  return Boolean(text.trim() || allowSubmitWhenEmpty);
}

// 修饰 Enter（反转投递）的判定。与裸 Enter 分离，因为二者的门禁不同：
// 修饰组合不受视口 enterSubmits 约束，但仍要排除 Shift 与组合态。
export function shouldSubmitLexicalModifiedEnter({
  allowSubmitWhenEmpty = false,
  ctrlKey = false,
  isComposing = false,
  metaKey = false,
  modifiedEnterSubmits,
  shiftKey = false,
  text,
}: LexicalModifiedEnterSubmitOptions): boolean {
  // modifiedEnterSubmits 的条件全部由 && 连接：保持展开写法，合成一行后很难看出哪个条件被漏掉。
  return (
    modifiedEnterSubmits &&
    (ctrlKey || metaKey) &&
    !shiftKey &&
    !isComposing &&
    Boolean(text.trim() || allowSubmitWhenEmpty)
  );
}

// INV-04 的唯一实现：只有明确的 false 才保留草稿；void / true / undefined 都视为已提交。
export function shouldResetLexicalEditorAfterSubmit(result: LexicalSubmitResult): boolean {
  return result !== false;
}

// 顿号 → 斜杠的判定（INV-15）。四个条件缺一不可：
// 字符是顿号、输入类型是 insertText、光标在全文开头、非 IME 组合态。
export function shouldNormalizeLeadingChineseSlashAliasInput({
  data,
  inputType,
  isAtEditorStart,
  isComposing = false,
}: LeadingChineseSlashAliasInputOptions): boolean {
  return (
    data === CHINESE_SLASH_ALIAS && inputType === "insertText" && isAtEditorStart && !isComposing
  );
}

/** 提取编辑器内容；mention 节点会在这里输出 markdown */
// 序列化入口：必须包在 editorState.read 里，mention 节点在 read 内输出 markdown。
// [资源] 这是输入热路径上的全量序列化，调用频率高，不要在里面做额外遍历。
function getEditorMarkdown(editorState: EditorState): string {
  let text = "";
  editorState.read(() => {
    text = $getPromptMarkdown();
  });
  return text;
}

// 整段替换（INV-11）。这是「程序化写入」而非「用户输入」，
// 因此必须带 PROGRAMMATIC_UPDATE_TAG，让历史插件与卡顿统计都能识别。
function replaceEditorText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();

      // Lexical getTextContent() 用 \n\n 分隔段落，对称处理防止换行翻倍
      // [失败路径] 用空行分段而不是单换行：Lexical 的 getTextContent 以段落为单位、
      // 段间用双换行连接；按单换行切会把段内换行也拆成新段落。
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        if (line) {
          paragraph.append($createTextNode(line));
        }
        root.append(paragraph);
      }

      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// 插件 mention 的内联 markdown 语法：[@name](plugin://author@name)。
// [并发] 用 g 标志的正则只能配合 matchAll 逐个消费，禁止复用同一实例做 test（lastIndex 会串）。
const INLINE_PLUGIN_MENTION_PATTERN =
  /\[@((?:\\.|[^\]])+)\]\(plugin:\/\/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)\)/g;

// 导入带插件 mention 的文本：把可识别的插件 markdown 还原成结构化节点，
// 无法识别的部分保持纯文本，保证「解析失败也不丢内容」。
function replaceEditorTextWithPluginMentions(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const line of text.split("\n\n")) {
        const paragraph = $createParagraphNode();
        let cursor = 0;
        // [失败路径] cursor 记录已消费位置，匹配之间的文本先补成 TextNode；
        // 漏掉这段就会把 mention 之间的普通文字整段吞掉。
        for (const match of line.matchAll(INLINE_PLUGIN_MENTION_PATTERN)) {
          const start = match.index ?? 0;
          if (start > cursor) paragraph.append($createTextNode(line.slice(cursor, start)));
          const markdown = match[0];
          const label = match[1]?.replaceAll("\\]", "]").replaceAll("\\[", "[") ?? "";
          const pluginId = match[2] ?? "";
          paragraph.append(
            $createPromptMentionNode({
              id: `plugin:${pluginId}`,
              category: "plugins",
              label,
              value: pluginId,
              markdown,
              data: { pluginId },
            }),
          );
          cursor = start + markdown.length;
        }
        // 尾部补文本；空段落也要补一个空节点，否则该段落会被 Lexical 视为不存在。
        if (cursor < line.length || paragraph.getChildrenSize() === 0) {
          paragraph.append($createTextNode(line.slice(cursor)));
        }
        root.append(paragraph);
      }
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// 替换型预填：清空后只放一个 mention + 尾随空格。
// [权衡] 尾随空格是「可直接继续输入」的契约，上层不要传空串把光标贴死在 chip 上。
export function replaceEditorWithMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      // 预填后保留空格供用户直接继续输入；选区正确性由 TextNode 文本/DOM 契约保证。
      // 空串同样回退成一个空格，避免创建零宽文本节点导致选区无法定位。
      const trailing = $createTextNode(trailingText || " ");
      paragraph.append($createPromptMentionNode(mention), trailing);
      root.append(paragraph);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

/**
 * 在草稿开头插入结构化 mention，同时保留已有 Lexical 节点和段落。
 *
 * 不能通过 getMarkdown → setMention 重建：setMention 是替换型预填，会把旧 mention
 * 序列化后作为普通 TextNode 放回编辑器，导致已有 Plugin / 文件 / Skill chip 降级。
 */
// INV-10：在前缀插入 mention，同时保留已有节点。返回是否真的插入，
// 调用方据此决定是否需要额外的滚动或提示。
export function prependEditorMentionIfMissing(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
): boolean {
  let inserted = false;
  editor.update(
    () => {
      const root = $getRoot();
      // [事务] 去重维度是 category + value，不是 id：同一个技能可能以不同 id 预填，
      // 但语义上仍是同一个引用，重复插入会产生两个 chip。
      const alreadyPresent = root
        .getAllTextNodes()
        .some(
          (node) =>
            $isPromptMentionNode(node) &&
            node.getMention().category === mention.category &&
            node.getMention().value === mention.value,
        );
      // 已存在时静默返回，不移动光标也不插入分隔符。
      if (alreadyPresent) return;

      const mentionNode = $createPromptMentionNode(mention);
      const separator = $createTextNode(" ");
      const firstBlock = root.getFirstChild();
      // 首块是段落时把 mention 插到第一个内联子节点之前；
      // 首块是其它节点（如列表）时新建一个段落插在它前面，避免破坏原结构。
      if ($isParagraphNode(firstBlock)) {
        const firstInline = firstBlock.getFirstChild();
        if (firstInline) {
          firstInline.insertBefore(mentionNode);
          mentionNode.insertAfter(separator);
        } else {
          firstBlock.append(mentionNode, separator);
        }
      } else {
        const paragraph = $createParagraphNode().append(mentionNode, separator);
        // [失败路径] 空文档没有 firstBlock，走 root.append；有 firstBlock 时 insertBefore。
        // 这两条路径都要把段落挂上，否则 mention 节点不在任何 parent 下，Lexical 会抛错。
        if (firstBlock) firstBlock.insertBefore(paragraph);
        else root.append(paragraph);
      }
      separator.selectEnd();
      inserted = true;
    },
    { discrete: true, tag: PROGRAMMATIC_UPDATE_TAG },
  );
  return inserted;
}

// [失败路径] parseEditorState 对非法 JSON 会抛错，本函数不吞异常：
// 调用方（E2E bridge / 草稿恢复）必须自行保证输入来自 saveEditorState。
function replaceEditorStateJson(editor: LexicalEditor, editorStateJson: string) {
  const editorState = editor.parseEditorState(editorStateJson);
  editor.setEditorState(editorState, { tag: PROGRAMMATIC_UPDATE_TAG });
}

// 清空统一走 replaceEditorText 的空串分支，保证段落结构、tag、选区行为一致。
function resetEditor(editor: LexicalEditor) {
  replaceEditorText(editor, "");
}

// 技能预填。markdown 必须由调用方透传（默认 $slug 只是兜底）：
// 带完整 frontmatter 的入口（如 New Skill）需要保留原始转译内容。
function replaceEditorWithSkillMention(
  editor: LexicalEditor,
  skillName: string,
  markdown = `$${skillName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-skill:${skillName}`,
          category: "skills",
          // 预填入口之前虽然会插入 skill node，但节点里保存的 markdown 仍固定成 `$slug`，
          // 导致像 New Skill 这种入口即使理论上有完整转译内容，进入输入框后也会被悄悄降级。
          // 这里显式透传原始 markdown，并直接显示 frontmatter name，避免 UI 再加工 skill 标题。
          label: skillName,
          value: skillName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// 斜杠命令预填：category 固定 commands，id 使用 prefill-slash 前缀与技能预填区分。
function replaceEditorWithSlashCommandMention(
  editor: LexicalEditor,
  commandName: string,
  markdown = `/${commandName}`,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append(
        $createPromptMentionNode({
          id: `prefill-slash:${commandName}`,
          category: "commands",
          label: commandName,
          value: commandName,
          markdown,
        }),
        $createTextNode(trailingText),
      );
      root.append(paragraph);
      root.getLastChild()?.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// 在末尾追加文件 mention（拖拽/粘贴文件时使用）。
// [权衡] 只追加到最后一个段落，不新建段落：文件 chip 与当前草稿应属于同一段。
function appendEditorFileMention(
  editor: LexicalEditor,
  label: string,
  value: string,
  markdown: string,
  data?: MentionItemData,
  trailingText = " ",
) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append(
        $createPromptMentionNode({
          id: `dropped-file:${value}`,
          category: "files",
          label,
          value,
          markdown,
          data,
        }),
        $createTextNode(trailingText),
      );
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// 追加纯文本。与文件 mention 共用「末尾段落 + 必要空格」策略，
function appendEditorPlainText(editor: LexicalEditor, text: string) {
  editor.update(
    () => {
      const root = $getRoot();
      const lastChild = root.getLastChild();
      const paragraph = $isParagraphNode(lastChild) ? lastChild : $createParagraphNode();
      if (!$isParagraphNode(lastChild)) {
        root.append(paragraph);
      }

      const currentText = paragraph.getTextContent();
      if (currentText.length > 0 && !/\s$/.test(currentText)) {
        paragraph.append($createTextNode(" "));
      }

      paragraph.append($createTextNode(text));
      paragraph.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// [并发] 这是唯一直接读 DOM Selection 的函数：Lexical 选区与浏览器选区在
// 平台快捷键触发时可能不同步，因此这里用 DOM 事实判断「光标是否正好在 mention 右边界」。
function getPromptMentionIdAfterDomSelection(rootElement: HTMLElement): string | null {
  const selection = window.getSelection();
  // 只处理折叠光标：有选区时用户意图是选中文本，不应被 mention 跳转劫持。
  if (!selection?.isCollapsed || !selection.anchorNode) {
    return null;
  }

  const anchorNode = selection.anchorNode;
  // [失败路径] 焦点在面板或外部输入框时直接返回，避免把外部光标误判成编辑器内位置。
  if (!rootElement.contains(anchorNode)) {
    return null;
  }

  // 元素节点光标：锚点偏移指向子节点索引，取该子节点判断是否为 mention。
  if (anchorNode.nodeType === Node.ELEMENT_NODE) {
    const child = anchorNode.childNodes.item(selection.anchorOffset);
    return getPromptMentionIdFromBoundaryNode(child);
  }

  // 其它节点类型（注释等）一律不接管。
  if (anchorNode.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  // [失败路径] 只有光标在该文本节点末尾时才可能是 mention 右边界；
  // 少了这个判断，句子中间的 Option+Right 会被无故拦截。
  if (selection.anchorOffset !== (anchorNode.textContent ?? "").length) {
    return null;
  }

  return getPromptMentionIdFromBoundaryNode(anchorNode.nextSibling);
}

// 只认带 data-mention-id 的 HTMLElement；这是一个显式的 DOM 契约，
// PromptMentionNode 的渲染实现改动时必须保留该属性。
function getPromptMentionIdFromBoundaryNode(node: Node | null): string | null {
  if (!(node instanceof HTMLElement) || !node.matches("[data-mention-id]")) {
    return null;
  }
  return node.dataset.mentionId ?? null;
}

// 按 id 在 Lexical 树里找 mention，并把选区放到它后面（INV-09）。
// 返回 false 表示节点已不存在（例如刚被删除），调用方不应再 preventDefault。
function selectAfterPromptMentionById(mentionId: string): boolean {
  const mentionNode = $getRoot()
    .getAllTextNodes()
    .find(
      (node): node is PromptMentionNode =>
        $isPromptMentionNode(node) && node.getMention().id === mentionId,
    );
  if (!mentionNode) {
    return false;
  }

  // [权衡] 优先落到紧随其后的 TextNode 里：这样继续输入会自然接在补位空格后；
  // 没有 TextNode 时才用 selectNext，直接选中下一个节点边界。
  const nextSibling = mentionNode.getNextSibling();
  if ($isTextNode(nextSibling)) {
    const text = nextSibling.getTextContent();
    const offset = /^\s/.test(text) ? Math.min(1, text.length) : 0;
    nextSibling.select(offset, offset);
    return true;
  }

  // 兜底路径：把光标推到 mention 之后的第一个位置，保持原子性。
  mentionNode.selectNext(0, 0);
  return true;
}

/**
 * 键盘行为插件：Enter 发送，Shift+Enter 换行
 *
 * 用 COMMAND_PRIORITY_HIGH 截获 Enter 按键，
 * 阻止 Lexical 默认的段落插入行为。
 */
// 键盘插件：Enter / Backspace / Option+ArrowRight 三条链路。
// [权衡] 全部注册在 COMMAND_PRIORITY_HIGH，而不是 root 的 keydown：
// Lexical 的 command 能拿到编辑器上下文与正确的选区时机。
function KeyboardPlugin({
  onSubmit,
  onModifiedSubmit,
  disabled,
  submitDisabled,
  allowSubmitWhenEmpty,
  enterSubmits,
}: {
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  // 作用域改绑层：读生效表的 composer 命令切片；ref 透传避免按键监听重挂。
  // [并发] 生效键位表每次渲染都可能变化，但监听器不能重挂：
  // 因此下面用 ref 透传，effect 依赖里不出现 bindings。
  const effectiveShortcutBindings = useEffectiveShortcutBindings();
  // 初始值直接取当前绑定，避免首帧（effect 尚未执行）时读到空对象。
  const composerEffectiveRef = useRef({
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  });
  // [权衡] 在渲染期写 ref：这是 React 允许的「最新值镜像」用法，
  // 比放在 useEffect 里早一拍，保证本次渲染触发的按键读到新表。
  composerEffectiveRef.current = {
    composerSend: effectiveShortcutBindings.composerSend ?? [],
    composerInsertNewline: effectiveShortcutBindings.composerInsertNewline ?? [],
  };

  useEffect(() => {
    // Enter 主链。返回 true 表示事件已被消费（不再插入段落），false 表示放行给 Lexical。
    // [失败路径] 任何分支都必须显式返回，漏写 return 会让 Lexical 收到 undefined 并按 false 处理。
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event) return false;

        // INV-02：禁用态吞掉 Enter（阻止换行写入），而不是放行。
        if (disabled) {
          event.preventDefault();
          return true;
        }

        // IME 正在组合中（如中文输入法），不拦截
        // INV-01：组合态放行，交给输入法自己处理。
        // 这里必须用 event.isComposing 而不是 editor 的全局状态——按键自带的事实更可靠。
        if (event.isComposing) {
          return false;
        }

        const text = getEditorMarkdown(editor.getEditorState());

        // 作用域改绑层：用户键位表优先于内置默认。
        // 命中换行 → 放行 Lexical 插段落；命中发送 → 走与主链等价的门禁分支；
        // 未命中 → 落到下方主链（含反转投递 / 修饰组合换行 / 视口门禁）。
        const composerEffective = composerEffectiveRef.current;
        // INV-05：用户键位表优先。返回 newline / send / null 三态，null 继续走主链。
        const scopedAction = resolveComposerKeyAction(event, composerEffective);
        // 命中换行直接放行，不 preventDefault：让 Lexical 插入段落。
        if (scopedAction === "newline") {
          return false;
        }
        // 命中发送：先判断是否为修饰组合，若是且存在反转投递回调，则让位给主链（INV-07）。
        if (scopedAction === "send") {
          const modifiedScopedEnter = event.shiftKey || event.ctrlKey || event.metaKey;
          // 反转投递开启时带修饰组合让位主链（Ctrl+Enter = 反向 delivery，交付语义比键位更具体）
          if (!(modifiedScopedEnter && onModifiedSubmit)) {
            // 与主链裸 Enter 等价的门禁：无修饰组合受 submitDisabled / 手机视口 enterSubmits；
            // 带修饰组合不受视口门禁（与主链 onModifiedSubmit 路径一致）。
            // [失败路径] 这里与主链门禁等价：裸 Enter 受 submitDisabled 与视口策略双重约束，
            // 修饰组合只受 submitDisabled 约束（与 onModifiedSubmit 路径一致）。
            if (submitDisabled || (!modifiedScopedEnter && !enterSubmits)) {
              return false;
            }
            event.preventDefault();
            if (
              shouldSubmitLexicalEnter({
                allowSubmitWhenEmpty,
                enterSubmits: modifiedScopedEnter ? true : enterSubmits,
                text,
              })
            ) {
              const submitResult = onSubmit(text);
              if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
                resetEditor(editor);
              }
            }
            return true;
          }
        }

        // 主链前置检查：composerSend 已改绑走（生效绑定不含裸 Enter）时，
        // 裸 Enter 不再代表发送，放行 Lexical 换行（"Ctrl+Enter 党"改绑后的预期行为）。
        if (
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          // 主链前置：裸 Enter 且用户把发送改绑到别处时，必须回退换行（INV-06）。
          // 判定完全交给 shortcuts 模块，本文件不重复实现「绑定里是否含裸 Enter」的逻辑。
          shouldBareEnterFallThroughToNewline(composerEffective)
        ) {
          return false;
        }

        if (
          !submitDisabled &&
          onModifiedSubmit &&
          shouldSubmitLexicalModifiedEnter({
            allowSubmitWhenEmpty,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            modifiedEnterSubmits: true,
            shiftKey: event.shiftKey,
            text,
          })
        ) {
          event.preventDefault();
          // 反转投递成功路径：提交后按返回值决定是否清空（INV-04）。
          const submitResult = onModifiedSubmit(text);
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
          return true;
        }

        // Shift+Enter，以及未启用反转投递时的 Ctrl/Meta+Enter 继续换行。
        // 这三个键都返回 false（不提交），由上层 normalizer 决定是否触发投递。
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          return false;
        }

        // 当前请求进行中时，输入框仍允许继续编辑草稿，但此时不能再次提交。
        // 之前把状态直接映射成 disabled，导致输入和联想面板一起失效；如果只去掉 disabled，
        // Enter 又会误触发 submit 并清空草稿。这里在 submitDisabled 时把 Enter 退回给 Lexical 处理换行。
        // INV-03：请求进行中或视口禁止发送时，Enter 退回 Lexical 换行，输入框保持可编辑。
        if (submitDisabled || !enterSubmits) {
          return false;
        }

        event.preventDefault();

        if (
          shouldSubmitLexicalEnter({
            allowSubmitWhenEmpty,
            enterSubmits,
            text,
          })
        ) {
          const submitResult = onSubmit(text);
          // 业务层可能拒绝本次提交并要求草稿留在输入框。
          // Enter 键盘层不能无条件 reset，否则即使业务层未发送，用户输入也会被吃掉。
          if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
            resetEditor(editor);
          }
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    // Backspace 特例（INV-08）：只处理「补位空格」这一种形态，其余全部放行。
    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent | null) => {
        const selection = $getSelection();
        // 非折叠选区交给默认行为（删除选中内容），不在此处连 token 一起删。
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchor = selection.anchor;
        if (anchor.type !== "text") {
          return false;
        }

        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          return false;
        }

        const text = node.getTextContent();
        // [失败路径] 必须同时满足「光标在空格之后」与「节点内容就是一个空格」；
        // 少任一条件都会把用户真实输入的空格误判成补位空格。
        if (anchor.offset !== 1 || text !== " ") {
          return false;
        }

        // 前一个兄弟必须是 mention 节点，否则只是普通退格。
        const previousSibling = node.getPreviousSibling();
        // 类型守卫同时完成运行时判断与类型收窄，后面的 remove 才能通过类型检查。
        if (!$isPromptMentionNode(previousSibling)) {
          return false;
        }

        // mention 插入时会自动补一个空格用于继续输入，
        // 之前 Backspace 会先删这个空格，再删 token，用户体感是“要按两次才删掉标签”。
        // 这里在“光标正好位于补位空格后”时，直接一次性删除空格 + mention token。
        // 一次性删除空格 + token：先删 mention 再删空格，最后把光标放到父段落末尾。
        // [失败路径] 顺序不能反：先删空格会让光标失去锚点，再删 token 时选区已失效。
        event?.preventDefault();
        previousSibling.remove();
        node.remove();
        node.getParent()?.selectEnd();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    // Option+ArrowRight 的 DOM 级拦截（INV-09）。
    // [权衡] 用 capture 而不是 Lexical command：macOS 的词级跳转发生在浏览器默认行为阶段，
    // 只有 capture 阶段能可靠抢在它之前。
    const handleRootKeyDownCapture = (event: KeyboardEvent) => {
      if (
        disabled ||
        event.key !== "ArrowRight" ||
        !event.altKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing
      ) {
        return;
      }

      const rootElement = editor.getRootElement();
      // 编辑器尚未挂载 DOM 时直接放弃，不阻止事件。
      if (!rootElement) {
        return;
      }

      // 只有「光标正好在 mention 右边界」才接管；其余位置保持系统默认的词级跳转。
      const mentionId = getPromptMentionIdAfterDomSelection(rootElement);
      if (!mentionId) {
        return;
      }

      // macOS Option+ArrowRight 会按 DOM 文本做词级跳转，之前会把光标落进
      // mention token 内部的文件名文本；下一次输入时 Lexical 会把 token 当作被替换内容删除。
      // 在 token 左边界显式把 selection 移到 token 后侧，保持 mention 的原子编辑语义。
      event.preventDefault();
      // [并发] 除 preventDefault 外还要立刻终止传播：同一 root 上还有非 Enter 分发监听，
      // 不停止会让两段逻辑对同一次按键各做一次处理。
      event.stopImmediatePropagation();
      editor.update(
        () => {
          selectAfterPromptMentionById(mentionId);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    // 作用域改绑层·非 Enter 分发（统一开放策略）：KEY_ENTER_COMMAND 只对 Enter
    // 派发，用户把发送/换行绑成非 Enter 键（如 F9）时由 root keydown capture 分发，
    // 否则改绑是死绑定，且裸 Enter 回退换行会让键盘发送能力整体丢失。
    // 非 Enter 物理键不存在手机软键盘误发问题，send 不受 enterSubmits 视口门禁；
    // 与反转投递（仅响应 Ctrl/Meta+Enter）无交集，无需让位。
    // 非 Enter 键的作用域分发：用户把发送/换行绑到 F9 等键时由这里处理。
    // [失败路径] 若删掉这段，改绑即死绑定——KEY_ENTER_COMMAND 永远不会派发非 Enter 键。
    const handleNonEnterScopedKeydown = (event: KeyboardEvent) => {
      // [并发] 排除 repeat：长按会连续触发提交；Enter 已由 command 处理，这里必须跳过避免双发。
      if (disabled || event.repeat || event.isComposing || event.key === "Enter") {
        return;
      }
      const scopedAction = resolveComposerKeyAction(event, composerEffectiveRef.current);
      if (!scopedAction) {
        return;
      }
      // 非 Enter 的换行键：在编辑器内手动 insertLineBreak，并阻止浏览器默认行为。
      if (scopedAction === "newline") {
        event.preventDefault();
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertLineBreak();
          }
        });
        return;
      }
      if (submitDisabled) {
        return;
      }
      event.preventDefault();
      const text = getEditorMarkdown(editor.getEditorState());
      if (shouldSubmitLexicalEnter({ allowSubmitWhenEmpty, enterSubmits: true, text })) {
        const submitResult = onSubmit(text);
        if (shouldResetLexicalEditorAfterSubmit(submitResult)) {
          resetEditor(editor);
        }
      }
    };

    // [资源] root 会被 Lexical 重挂（受控卸载/恢复），因此不能只在 effect 里绑一次：
    // registerRootListener 负责在新旧 root 上解绑与重绑，避免监听器泄漏或丢失。
    const unregisterRootListener = editor.registerRootListener(
      (rootElement, previousRootElement) => {
        previousRootElement?.removeEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleRootKeyDownCapture, {
          capture: true,
        });
        previousRootElement?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
        rootElement?.addEventListener("keydown", handleNonEnterScopedKeydown, {
          capture: true,
        });
      },
    );

    return () => {
      unregisterEnter();
      unregisterBackspace();
      unregisterRootListener();
      // [资源] 清理阶段还要手动摘一次：registerRootListener 的注销不会自动移除
      // 直接挂在 DOM 上的监听器。
      editor.getRootElement()?.removeEventListener("keydown", handleRootKeyDownCapture, {
        capture: true,
      });
      editor.getRootElement()?.removeEventListener("keydown", handleNonEnterScopedKeydown, {
        capture: true,
      });
    };
  }, [
    allowSubmitWhenEmpty,
    disabled,
    editor,
    enterSubmits,
    onModifiedSubmit,
    onSubmit,
    submitDisabled,
  ]);

  return null;
}

/**
 * 文本变化插件
 *
 * 直接用 Lexical 自带的 OnChangePlugin 时，第一次从空编辑器输入字符会被内部的
 * `prevEditorState.isEmpty()` 直接跳过，父组件的 input 状态拿不到首字符，发送按钮和输入内容会错位。
 * 这里改成自己监听 update，只在序列化后的 markdown 真正变化时同步，首字符输入也能稳定回传。
 */
// 文本变化插件。自己监听 update 而不用 OnChangePlugin：
// 后者对「空编辑器输入首字符」会短路，父组件拿不到首字符导致发送按钮状态错位。
function TextContentPlugin({
  onChange,
  taskId,
}: {
  onChange?: (text: string) => void;
  taskId?: string | null;
}) {
  const [editor] = useLexicalComposerContext();
  // IME 组合态标记:不直接依赖 editor.isComposing(),因为它在 update listener 同步执行时
  // 是否已反映组合态存在时序不确定性,读不到 true 会把中文/日文长文本组合的高耗时误报成打字卡顿。
  // 改由 compositionstart/compositionend 事件自行维护,稳健可控。
  // [并发] 组合态自维护（INV-18）：editor.isComposing() 在 update listener 内的时序不确定，
  // 依赖它会把中文组合的高耗时报成打字卡顿。
  const composingRef = useRef(false);

  useEffect(() => {
    const handleCompositionStart = () => {
      composingRef.current = true;
    };
    // 组合结束时不能立即置 false：提交那一拍的 update 通常在同一个同步任务里执行。
    const handleCompositionEnd = () => {
      // compositionend 触发时组合刚结束,但「组合提交」这一拍的 update listener 通常在同一轮
      // 任务里同步执行,若立即置 false,这次高耗时会被误判为打字卡顿。用 queueMicrotask 把置 false
      // 延后到当前同步任务之后,确保组合提交那一拍仍按组合态短路,再恢复正常计入。
      // 延后到微任务之后再恢复正常计数（INV-18），保证组合提交这一拍仍走短路。
      queueMicrotask(() => {
        composingRef.current = false;
      });
    };

    // root 会重挂,用 registerRootListener 在新旧 root 上正确解绑/绑定。
    // [资源] composition 事件必须绑在 root 上且随重挂迁移；
    // 绑在 document 会把其它输入框的组合态也算进来。
    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("compositionstart", handleCompositionStart);
      previousRootElement?.removeEventListener("compositionend", handleCompositionEnd);
      rootElement?.addEventListener("compositionstart", handleCompositionStart);
      rootElement?.addEventListener("compositionend", handleCompositionEnd);
    });
  }, [editor]);

  useEffect(() => {
    if (!onChange) {
      return;
    }

    // [资源] 每个 TextContentPlugin 实例注册一个 listener，effect 依赖含 onChange，
    // onChange 变化会重注册——因此上层不要把内联箭头函数直接传进来。
    return editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, editorState, prevEditorState, tags }) => {
        // [权衡] 跳过纯 selection 更新：光标移动也触发 update，但不应触发 onChange 与卡顿统计。
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
          return;
        }

        // 输入卡顿计时:包住「全量序列化 + onChange 同步重渲染」这段处理热点。
        // 计时窗口刻意只包住「序列化 + onChange」，不含 Lexical 自身的 reconcile。
        const startedAt = performance.now();

        // [权衡] 前后两份状态都做全量序列化再比较：比逐节点 diff 简单得多，
        // 代价是每次输入两次序列化，实测仍在预算内。
        const nextText = getEditorMarkdown(editorState);
        const previousText = getEditorMarkdown(prevEditorState);
        // [失败路径] 文本未变就不回调：否则纯格式变化（如加粗）会让父组件误以为内容变了。
        if (nextText === previousText) {
          return;
        }

        onChange(nextText);

        const lagMs = performance.now() - startedAt;
        // 程序化改写与 IME 组合态不算打字卡顿(判定在 recordInputLag 内统一短路)。
        // INV-17：程序化改写与组合态由 recordInputLag 内部统一短路，
        // 调用点只负责如实上报两个布尔，不要在这里提前 return。
        recordInputLag({
          lagMs,
          textLength: nextText.length,
          isProgrammatic: tags.has(PROGRAMMATIC_UPDATE_TAG),
          isComposing: composingRef.current,
          taskId: taskId ?? undefined,
        });
      },
    );
  }, [editor, onChange, taskId]);

  return null;
}

/** 编辑器可编辑状态控制插件 */
// 可编辑状态同步。用 effect 而不是在渲染期调用 setEditable：
// 渲染期修改编辑器状态会触发 Lexical 的嵌套 update 警告。
function EditablePlugin({ editable }: { editable: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // [失败路径] 只切 editable，不清空内容：禁用期间草稿必须保留。
    editor.setEditable(editable);
  }, [editor, editable]);

  return null;
}

// E2E 桥：把真实 editor 的读写能力挂到输入框 DOM 上。
// [权衡] 只在传了 inputTestId 时启用；生产环境不传即整段不执行。
function E2ELexicalInputBridgePlugin({ inputTestId }: { inputTestId?: string }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // SSR 与未配置 testId 的环境直接退出，避免 document 访问错误。
    if (!inputTestId || typeof document === "undefined") {
      return;
    }

    // [权衡] bridge 上的每个方法都必须走 Lexical API：直接改 contenteditable 的 DOM
    // 会绕过 editor update，测试结论与真实产品行为脱节。
    const bridge = {
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) => replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
    };

    let attachedInput: HTMLElement | null = null;
    // [事务] 卸载前先校验属性仍指向当前 bridge 再删除：
    // 热重载或双实例场景下可能已被新 bridge 覆盖，盲删会删掉别人的。
    const detachBridge = (input: HTMLElement | null) => {
      if (
        input &&
        (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E === bridge
      ) {
        delete (input as { __zcodeLexicalInputE2E?: typeof bridge }).__zcodeLexicalInputE2E;
      }
      input?.removeAttribute("data-e2e-lexical-bridge");
    };
    // [资源] 挂新桥前先摘旧桥，保证任意时刻至多一个输入框持有 bridge。
    const attachBridge = (input: HTMLElement | null) => {
      if (attachedInput && attachedInput !== input) {
        detachBridge(attachedInput);
      }
      attachedInput = input;
      if (!input) {
        return;
      }

      // E2E 需要驱动真实 Lexical state；只改 DOM contenteditable 会绕过 editor update，
      // 容易把文本误打到主输入框，导致测试结论和产品行为脱节。
      // configurable 必须为 true，detachBridge 才能删除；value 直接给对象，不设 getter。
      Object.defineProperty(input, "__zcodeLexicalInputE2E", {
        configurable: true,
        value: bridge,
      });
      input.setAttribute("data-e2e-lexical-bridge", "ready");
    };

    // [失败路径] 先看当前 root 的 testid，再退回全局查询：
    // root 可能被 Lexical 重挂成不带 testid 的容器，此时需要从文档里找。
    const resolveInput = (rootElement: HTMLElement | null) => {
      if (rootElement?.getAttribute("data-testid") === inputTestId) {
        return rootElement;
      }
      return document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    };

    // [资源] 轮询句柄用 number（浏览器 timer id），清理时必须判空后 clearInterval。
    let retryTimer: number | null = null;
    // 尝试挂桥；一旦成功立刻停表，不做「成功后再多打几次」的冗余轮询。
    const tryAttachBridge = () => {
      const nextInput = resolveInput(editor.getRootElement());
      attachBridge(nextInput);
      if (nextInput && retryTimer !== null) {
        window.clearInterval(retryTimer);
        retryTimer = null;
      }
    };
    // root 重挂时同步迁移 bridge（INV 之外的资源规则：桥不能跟着旧 DOM 一起消失）。
    const unregisterRoot = editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement !== rootElement) {
        detachBridge(previousRootElement);
      }
      // E2E bridge 之前只在 effect 里查询一次 DOM。
      // 编辑器 root 如果比插件晚挂载或被 Lexical 重挂载，bridge 会永久缺失。
      attachBridge(resolveInput(rootElement));
    });

    tryAttachBridge();
    // edit 场景里 ChatPromptEditor 的 initialValue 回填、Lexical root 注册、
    // React DOM 提交顺序可能跨多个帧。短轮询只负责补挂测试 bridge，不参与产品行为。
    // [权衡] 100ms 短轮询只用于测试桥补挂，不参与产品行为；
    // 挂上后立即 clear，最长生命周期等于编辑器挂载时间。
    retryTimer = window.setInterval(tryAttachBridge, 100);

    return () => {
      unregisterRoot();
      if (retryTimer !== null) {
        window.clearInterval(retryTimer);
      }
      detachBridge(attachedInput);
    };
  }, [editor, inputTestId]);

  return null;
}

// 历史导航：Up/Down 在空输入或历史浏览态下切换条目（INV-13）。
// [事务] 两个 ref 分别表示「当前历史下标」与「这次 update 是否由回填产生」。
function PromptHistoryPlugin({
  entries,
  disabled,
}: {
  entries: readonly string[];
  disabled?: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  // null 表示未进入历史浏览态；-1 不是合法值，不要把 null 与 0 混用。
  const historyIndexRef = useRef<number | null>(null);
  // [并发] 回填会触发一次 update listener，必须用这个标记把它与用户编辑区分开，
  // 否则刚回填就被判定为「用户手动编辑」并退出历史态。
  const applyingHistoryRef = useRef(false);

  useEffect(() => {
    // [失败路径] 历史数组缩短（新会话清空）后下标失效，必须回到 null，
    // 否则下一次 Up 会从越界下标继续。
    if (historyIndexRef.current !== null && entries[historyIndexRef.current] === undefined) {
      historyIndexRef.current = null;
    }
  }, [entries]);

  useEffect(() => {
    // 监听用户编辑以退出历史态（INV-14）；只关心真实内容变化，跳过纯选区更新。
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
        return;
      }

      // 回填产生的那一次 update 直接消费掉标记并返回，不参与「是否被用户编辑」的判断。
      if (applyingHistoryRef.current) {
        applyingHistoryRef.current = false;
        return;
      }

      const currentIndex = historyIndexRef.current;
      if (currentIndex === null) {
        return;
      }

      if (entries[currentIndex] === undefined) {
        historyIndexRef.current = null;
        return;
      }

      // getEditorMarkdown 与 entries[currentIndex] 不一致即视为用户已编辑，必须退出历史态。
      if (getEditorMarkdown(editorState) !== entries[currentIndex]) {
        historyIndexRef.current = null;
      }
    });
  }, [editor, entries]);

  const applyHistoryEntry = useCallback(
    (nextIndex: number | null, nextValue: string) => {
      historyIndexRef.current = nextIndex;
      applyingHistoryRef.current = true;
      // 使用专用 HISTORY_NAVIGATION_UPDATE_TAG 而非通用 PROGRAMMATIC_UPDATE_TAG，
      // 使 SlashCommandPlugin 能区分"历史回填"与"用户正在输入 slash 查询"，
      // 防止回填含 / 的历史条目时面板重新打开并以 COMMAND_PRIORITY_CRITICAL 吞掉后续方向键。
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          for (const line of nextValue.split("\n\n")) {
            const paragraph = $createParagraphNode();
            if (line) {
              paragraph.append($createTextNode(line));
            }
            root.append(paragraph);
          }
          root.getLastChild()?.selectEnd();
        },
        // 回填正文必须带这个专用 tag（INV-12）。
        // [并发] SlashCommandPlugin 依赖它区分「历史回填」与「用户输入斜杠」，
        // 改成通用 tag 会让回填含 / 的条目时面板重新打开并吞掉方向键。
        { tag: HISTORY_NAVIGATION_UPDATE_TAG },
      );
    },
    [editor],
  );

  // 方向键处理器工厂：up/down 共用同一套门禁，只把方向传给 navigatePromptHistory。
  const handleHistoryNavigation = useCallback(
    (direction: "up" | "down") => (event: KeyboardEvent | null) => {
      if (!event) return false;

      if (
        disabled ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      ) {
        return false;
      }

      const text = getEditorMarkdown(editor.getEditorState());
      const currentIndex = historyIndexRef.current;

      // 历史导航只在“空输入”或“已经进入历史浏览态”时接管上下键，
      // 避免抢走多行输入原本的光标移动行为。
      // INV-13：非空且未进入历史态时放行，保留多行输入的光标上下移动。
      if (currentIndex === null && text.length > 0) {
        return false;
      }

      // 边界（已到最早/最新）由该函数返回 shouldHandle=false，本文件不自己算下标。
      const result = navigatePromptHistory(entries, currentIndex, direction);
      // [失败路径] 不处理时不得 preventDefault：到底后继续按 Up 应保持编辑器默认行为。
      if (!result.shouldHandle) {
        return false;
      }

      event.preventDefault();
      applyHistoryEntry(result.nextIndex, result.nextValue);
      return true;
    },
    [applyHistoryEntry, disabled, editor, entries],
  );

  useEffect(() => {
    // 上下键都注册在 HIGH 优先级；slash 面板若以 CRITICAL 打开会先于这里消费按键。
    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      handleHistoryNavigation("up"),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      handleHistoryNavigation("down"),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterUp();
      unregisterDown();
    };
  }, [editor, handleHistoryNavigation]);

  return null;
}

// [失败路径] 「光标在全文开头」的判定：必须同时是折叠选区、offset=0、
// 且该节点是文档第一个叶子节点。只看 offset 会把每个段落的行首都算成开头。
function isCollapsedSelectionAtEditorStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }

  // getStartEndPoints 可能返回 null；解构前先兜底为空数组。
  const [startPoint] = selection.getStartEndPoints() ?? [];
  if (!startPoint || startPoint.offset !== 0) {
    return false;
  }

  const root = $getRoot();
  const startNode = startPoint.getNode();
  if (startPoint.type === "text") {
    const firstTextNode = root.getAllTextNodes()[0] ?? null;
    return firstTextNode?.is(startNode) ?? root.getTextContentSize() === 0;
  }

  // [权衡] 选区落在 root 本身（空文档）时视为开头；
  // 这比继续找 firstDescendant 更直接，也覆盖 root 为空的情形。
  if (startNode.is(root)) {
    return true;
  }

  // 文本节点分支之外（元素节点）用第一个后代节点比较，覆盖空段落占位的情况。
  const firstDescendant = root.getFirstDescendant();
  return firstDescendant?.is(startNode) ?? root.getTextContentSize() === 0;
}

// 顿号别名插件（INV-15）。挂在 beforeinput 而不是 keydown：
// 只有 beforeinput 能拿到 data 与 inputType，且能可靠取消这次输入。
function LeadingChineseSlashAliasPlugin({ disabled }: { disabled?: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (disabled) {
      return;
    }

    // [失败路径] 判定在 editorState.read 内完成：选区信息只能在该上下文里安全读取。
    const handleBeforeInput = (event: InputEvent) => {
      let shouldNormalize = false;
      editor.getEditorState().read(() => {
        shouldNormalize = shouldNormalizeLeadingChineseSlashAliasInput({
          data: event.data,
          inputType: event.inputType,
          isAtEditorStart: isCollapsedSelectionAtEditorStart(),
          isComposing: event.isComposing,
        });
      });

      // 不满足条件就完全不干预，保证正文中的顿号可正常输入。
      if (!shouldNormalize) {
        return;
      }

      // 中文输入法下用户在输入框第一位想打 `/` 唤起命令时，
      // 可能会实际输入顿号 `、`。这里只拦截真实手输且位于全文开头的顿号，
      // 立即归一成标准 `/`，避免把顿号扩散成 slash command 的另一套匹配语法。
      event.preventDefault();
      editor.update(
        () => {
          if (!isCollapsedSelectionAtEditorStart()) {
            return;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.insertText(STANDARD_SLASH_TRIGGER);
        },
        { tag: PROGRAMMATIC_UPDATE_TAG },
      );
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      // [资源] beforeinput 必须显式移除：registerRootListener 的清理不覆盖手动添加的 DOM 监听。
      previousRootElement?.removeEventListener("beforeinput", handleBeforeInput as EventListener);
      rootElement?.addEventListener("beforeinput", handleBeforeInput as EventListener);
    });
  }, [disabled, editor]);

  return null;
}

// 粘贴捕获：业务层可把长文本转成附件并 preventDefault（INV-16）。
// [权衡] 监听放在 capture 阶段：需要在 Lexical 的 paste command 之前拿到事件。
function PasteCapturePlugin({
  disabled,
  onPaste,
}: {
  disabled?: boolean;
  onPaste?: (event: ChatComposerPasteEvent) => void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!onPaste) {
      return;
    }

    // [事务] 记录处理前的 defaultPrevented，用于区分「业务层刚刚接管」与「别处早已取消」。
    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) {
        return;
      }

      // 只有由 false 变 true 才说明是本次 onPaste 主动接管，需要阻断后续插入。
      const wasDefaultPrevented = event.defaultPrevented;
      onPaste(event);
      // [失败路径] 少这个比较就会把「别处已取消的粘贴」再阻断一次，
      // 多这个比较则完全避免「附件 + 正文双份内容」（INV-16）。
      if (event.defaultPrevented && !wasDefaultPrevented) {
        // 长文本已经被转成附件后，必须阻断 Lexical 后续 paste command，
        // 否则会出现“附件有了，正文也被插入”的双份内容。
        event.stopImmediatePropagation();
      }
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener("paste", handlePaste, {
        capture: true,
      });
      rootElement?.addEventListener("paste", handlePaste, { capture: true });
    });
  }, [disabled, editor, onPaste]);

  return null;
}

/** 暴露 focus / clear / getText 给外部 */
// 在光标处插入 mention（可视化菜单选中后调用）。
// [事务] 需要先恢复菜单打开前的选区，否则浮层夺焦后光标已丢，mention 会插到末尾或覆盖全文。
export function insertEditorMention(
  editor: LexicalEditor,
  mention: ComposerMentionPrefill,
  selectionState?: EditorState,
) {
  // [并发] 在旧 editorState 上 read 并 clone：不能直接持有 Selection 对象跨 update 使用。
  const selection = selectionState?.read(() => $getSelection()?.clone() ?? null);
  editor.update(
    () => {
      // 浮层获取焦点后 Lexical 选区会丢失，恢复打开菜单前的光标，避免覆盖整份草稿。
      // 草稿可能在菜单打开期间被替换；旧节点不存在时不能恢复选区，否则 Lexical 会抛错。
      if ($isRangeSelection(selection)) {
        // INV-19：两个端点都必须仍存在才恢复选区；任一节点已被删除就退到文档末尾。
        if ($getNodeByKey(selection.anchor.key) && $getNodeByKey(selection.focus.key)) {
          $setSelection(selection);
        } else {
          // [失败路径] 节点已不存在（草稿被替换）时退到末尾，绝不能恢复失效选区——Lexical 会抛错。
          $getRoot().selectEnd();
        }
      }
      // 兜底：没有任何选区时显式 selectEnd，保证后面的 insertNodes 有落点。
      let target = $getSelection();
      if (!$isRangeSelection(target)) target = $getRoot().selectEnd();
      const trailing = $createTextNode(" ");
      target.insertNodes([$createPromptMentionNode(mention), trailing]);
      trailing.selectEnd();
    },
    { tag: PROGRAMMATIC_UPDATE_TAG },
  );
}

// 把命令式 API 暴露到 ref 上（INV-20）。
function EditorApiPlugin({
  editorApiRef,
}: {
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editorApiRef) {
      return;
    }

    // [失败路径] 每个方法都直接闭包 editor 实例；不要在方法内部再 useLexicalComposerContext，
    // ref 的生命周期比组件渲染更长，必须绑定到稳定的编辑器实例。
    editorApiRef.current = {
      clear: () => resetEditor(editor),
      focus: () => editor.focus(),
      getEditorState: () => editor.getEditorState(),
      getMarkdown: () => getEditorMarkdown(editor.getEditorState()),
      getText: () => getEditorMarkdown(editor.getEditorState()),
      appendText: (text: string) => appendEditorPlainText(editor, text),
      appendFileMention: (
        label: string,
        value: string,
        markdown: string,
        data?: MentionItemData,
        trailingText = " ",
      ) => appendEditorFileMention(editor, label, value, markdown, data, trailingText),
      insertMention: (mention, selectionState) =>
        insertEditorMention(editor, mention, selectionState),
      prependMentionIfMissing: (mention) => prependEditorMentionIfMissing(editor, mention),
      setMention: (mention, trailingText) =>
        replaceEditorWithMention(editor, mention, trailingText),
      setText: (text: string) => replaceEditorText(editor, text),
      setTextWithPluginMentions: (text: string) => replaceEditorTextWithPluginMentions(editor, text),
      setEditorStateJson: (editorStateJson: string) =>
        replaceEditorStateJson(editor, editorStateJson),
      setSkillMention: (skillName: string, markdown = `$${skillName}`, trailingText = " ") =>
        replaceEditorWithSkillMention(editor, skillName, markdown, trailingText),
      setSlashCommandMention: (
        commandName: string,
        markdown = `/${commandName}`,
        trailingText = " ",
      ) => replaceEditorWithSlashCommandMention(editor, commandName, markdown, trailingText),
    };

    return () => {
      editorApiRef.current = null;
    };
  }, [editor, editorApiRef]);

  return null;
}

// props 分四类：提交门禁（disabled/submitDisabled/enterSubmits/allowSubmitWhenEmpty）、
// 数据源（workspace/session/provider）、面板开关（mention/slash）、以及测试与遥测钩子。
interface LexicalChatInputProps {
  placeholder?: string;
  disabled?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  onSubmit: (text: string) => LexicalSubmitResult;
  onModifiedSubmit?: (text: string) => LexicalSubmitResult;
  onChange?: (text: string) => void;
  onFocus?: () => void;
  triggerPanelContainer?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** 仅影响 Skill 引用目录；草稿可使用 prewarm Session runtime。 */
  skillCatalogSessionId?: string | null;
  inputTestId?: string;
  editorApiRef?: React.MutableRefObject<LexicalChatInputHandle | null>;
  promptHistory?: readonly string[];
  avoidIosInputFocusZoom?: boolean;
  compactPlaceholder?: boolean;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  excludedSlashCommandNames?: readonly string[];
  /** App 层本地斜杠命令（如 `/side`），选中即执行 UI 行为，不发送。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** mention（@/#）面板开关。v4 数据面未就绪时显式关闭，入口保留。 */
  enableMentionPanel?: boolean;
}

// [权衡] 主题只保留段落零边距：其余排版由外层容器与 ContentEditable 的 className 控制，
// 主题对象放太多会让输入框样式与设计系统脱节。
const EDITOR_THEME = {
  paragraph: "m-0",
};

// 输入框入口。默认值体现产品语义：可编辑、Enter 发送、允许 mention 面板。
export function LexicalChatInput({
  placeholder,
  disabled = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  onSubmit,
  onModifiedSubmit,
  onChange,
  onFocus,
  triggerPanelContainer,
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  inputTestId,
  editorApiRef,
  promptHistory = [],
  avoidIosInputFocusZoom = false,
  compactPlaceholder = false,
  onWhiteboardMentionSelected,
  onPaste,
  excludedSlashCommandNames,
  appSlashCommands,
  enableMentionPanel = true,
}: LexicalChatInputProps) {
  // [资源] 挂载时刻在首次渲染时取一次，用于计算首帧耗时；不要放进 effect，会偏晚。
  const inputMountedAtRef = useRef(Date.now());
  // INV-22：首帧日志按 key 去重，避免 props 抖动导致重复打点。
  const lastReadyLogKeyRef = useRef<string | null>(null);
  // 当前任务使用的 provider 决定 slash/mention 目录来源；草稿态也会返回默认值。
  const activeTaskProvider = useChatViewActiveTaskProvider(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  useEffect(() => {
    // key 只包含影响「首帧是否真正就绪」的四个因素：身份、任务、provider、portal。
    const readyLogKey = [
      workspaceIdentity ?? workspacePath,
      taskId ?? "draft",
      activeTaskProvider,
      triggerPanelContainer ? "trigger-ready" : "trigger-missing",
    ].join("|");
    if (lastReadyLogKeyRef.current === readyLogKey) {
      return;
    }
    lastReadyLogKeyRef.current = readyLogKey;

    // [资源] rAF 句柄可能为空（无 rAF 环境），清理时必须判空。
    let frameId: number | null = null;
    const logReady = () => {
      logger.info("[LexicalChatInput] 输入编辑器首帧完成", {
        durationMs: Date.now() - inputMountedAtRef.current,
        activeTaskProvider,
        disabled,
        hasPromptHistory: promptHistory.length > 0,
        submitDisabled,
        taskId,
        triggerPanelReady: Boolean(triggerPanelContainer),
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });
    };

    // Lexical 编辑器初始化、slash/mention plugin 和外部 portal 分属不同组件。
    // 这里等浏览器下一帧再打点，才能和 composer shell 首帧、toolbar portal ready 对齐。
    // 等下一帧再打点，才能与 composer shell、toolbar portal 的首帧对齐；
    // 无 rAF 的环境（SSR/测试）同步打点，保证日志不丢。
    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(logReady);
    } else {
      logReady();
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeTaskProvider,
    disabled,
    promptHistory.length,
    submitDisabled,
    taskId,
    triggerPanelContainer,
    workspaceIdentity,
    workspacePath,
  ]);
  // [权衡] 提交后把焦点还给编辑器（rAF 中执行）：
  // 业务层同步卸载弹窗/面板，立即 focus 会被随后的布局变化打断。
  const handleSubmit = useCallback(
    (text: string) => {
      const submitResult = onSubmit(text);
      // 焦点恢复放到下一帧，避开提交引发的同步 DOM 变更。
      requestAnimationFrame(() => {
        editorApiRef?.current?.focus();
      });
      return submitResult;
    },
    [editorApiRef, onSubmit],
  );
  // Lexical 的 ContentEditable props 是一个互斥联合类型，
  // aria-placeholder 一旦出现就要求 placeholder 同时存在。
  // 之前直接写三元 JSX，TypeScript 在合并两条分支时没有正确保留这组联动约束，导致误报缺少 placeholder。
  // [失败路径] aria-placeholder 与 placeholder 是联动约束：
  // 有前者必须有后者，因此这里用完整对象分支而不是内联三元，避免 TS 合并分支时丢约束。
  const contentEditableProps: React.ComponentProps<typeof ContentEditable> = placeholder
    ? {
        "aria-placeholder": placeholder,
        placeholder: (
          <div
            className={`pointer-events-none absolute left-0 top-0 ${compactPlaceholder ? "line-clamp-2" : ""} ${resolveMobileInputTextSizeClassName(
              {
                avoidIosInputFocusZoom,
              },
            )} text-foreground-subtlest`}
          >
            {placeholder}
          </div>
        ),
      }
    : {
        placeholder: null,
      };

  // ContentEditable 的 className 同时承担三件事：高度上限、滚动、移动端字号。
  // 三者必须一起出现，否则 iOS 聚焦时会被自动放大。
  const contentEditable = (
    <ContentEditable
      // Bugfix: mention node 使用固定行高的 inline-flex chip，普通正文如果继承浏览器 normal line-height，
      // 在 token 后继续输入文字时会按不同 line box 计算基线；这里显式收口正文行高，并允许手机远控使用 16px 防止 iOS 聚焦放大。
      // min-h 保证空输入也有点击区域；max-h 之后交给 overflow-y 滚动，不再自动增高。
      className={`min-h-10 max-h-40 overflow-y-auto ${resolveMobileInputTextSizeClassName({
        avoidIosInputFocusZoom,
      })} text-foreground outline-none`}
      data-testid={inputTestId}
      onFocus={onFocus}
      {...contentEditableProps}
    />
  );

  // INV-21：配置引用必须稳定；onError 里只记日志、不向上抛异常，
  // 避免单个节点的渲染错误拖垮整个输入框。
  const initialConfig = useMemo(
    () => ({
      namespace: "ChatInput",
      theme: EDITOR_THEME,
      nodes: [PromptMentionNode],
      // LexicalComposer initialConfig 每次 render 新建会让输入区子树被记录为 props 变化；
      // 配置内容本身是静态的，固定引用能避免无关状态更新触发 composer 子树冒泡。
      onError: (error: Error) => {
        logger.error("[LexicalChatInput] editor error:", error);
      },
    }),
    [],
  );

  return (
    <div className="relative flex-1">
      <LexicalComposer initialConfig={initialConfig}>
        <div className="relative">
          <PlainTextPlugin contentEditable={contentEditable} ErrorBoundary={LexicalErrorBoundary} />
          <HistoryPlugin />
          <PromptClipboardPlugin />
          <TextContentPlugin onChange={onChange} taskId={taskId} />
          <KeyboardPlugin
            onSubmit={handleSubmit}
            onModifiedSubmit={onModifiedSubmit}
            disabled={disabled}
            submitDisabled={submitDisabled}
            allowSubmitWhenEmpty={allowSubmitWhenEmpty}
            enterSubmits={enterSubmits}
          />
          <PromptHistoryPlugin entries={promptHistory} disabled={disabled} />
          <EditablePlugin editable={!disabled} />
          <E2ELexicalInputBridgePlugin inputTestId={inputTestId} />
          <EditorApiPlugin editorApiRef={editorApiRef} />
          <LeadingChineseSlashAliasPlugin disabled={disabled} />
          <PasteCapturePlugin disabled={disabled} onPaste={onPaste} />
        </div>
        <SlashCommandPlugin
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          sessionId={skillCatalogSessionId ?? taskId}
          provider={activeTaskProvider}
          container={triggerPanelContainer}
          disabled={disabled}
          excludedCommandNames={excludedSlashCommandNames}
          appCommands={appSlashCommands}
        />
        {enableMentionPanel ? (
          <MentionPlugin
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={skillCatalogSessionId ?? taskId}
            provider={activeTaskProvider}
            container={triggerPanelContainer}
            disabled={disabled}
            onWhiteboardMentionSelected={onWhiteboardMentionSelected}
          />
        ) : null}
      </LexicalComposer>
    </div>
  );
}

/** 简单的错误边界 */
// [权衡] 空错误边界：Lexical 抛错时保持子树可见而不是整块替换成错误页，
// 保证极端情况下用户仍能复制草稿文本。
function LexicalErrorBoundary({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
