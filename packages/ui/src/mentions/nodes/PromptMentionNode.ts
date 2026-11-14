// INV-01 展示与规范分离：守住位置 __text 与 __markdown 的用途；改错故障：编辑器偏移量按 canonical 文本计算，光标错位。
// INV-02 文本链不断：守住位置 createDOM 保留父类文本节点；改错故障：图标截断 firstChild 链，选区与输入失效。
// INV-03 不可变节点：守住位置 全部实例字段只读使用；改错故障：直接改字段绕过编辑器状态机。
// INV-04 克隆保键：守住位置 clone 传入 node.__key；改错故障：行内移动后节点身份变化，选中态丢失。
// INV-05 序列化闭环：守住位置 exportJSON 与 importJSON 的字段对应；改错故障：复制粘贴后提及信息丢失。
// INV-06 格式回填：守住位置 importJSON 的四个 setter；改错故障：粘贴后粗体与样式被重置。
// INV-07 类别换肤：守住位置 updateDOM 的类别分支；改错故障：切换分类后颜色与数据集不一致。
// INV-08 装饰条件：守住位置 五个数据字段的比较；改错故障：文件图标变化后不重绘。
// INV-09 文件名优先：守住位置 displayLabel 的文件分支；改错故障：文件提及显示完整路径撑开行宽。
// INV-10 标签归一：守住位置 normalizePromptMentionDisplayLabel；改错故障：各分类显示格式不一致。
// INV-11 描述缺省：守住位置 构造函数的空串回退；改错故障：下游对 undefined 做字符串操作报错。
// INV-12 token 模式：守住位置 $createPromptMentionNode 的 setMode；改错故障：光标可插入提及内部产生半截标签。
// INV-13 节点替换：守住位置 $applyNodeReplacement；改错故障：返回未注册实例，编辑器状态被污染。
// INV-14 类型守卫：守住位置 $isPromptMentionNode；改错故障：类型收窄失效导致访问私有字段报错。
// INV-15 文本实体：守住位置 isTextEntity；改错故障：提及被当成普通文本，删除时只删一个字符。
// INV-16 禁止前后插入：守住位置 两个 canInsert 方法；改错故障：可在提及中间插入字符。
// INV-17 数据集契约：守住位置 data-mention-category 与 data-mention-id；改错故障：样式与测试选择器失配。
// INV-18 无副作用：守住位置 静态方法与构造函数；改错故障：构造期间读写全局状态。
//
// 模块职责：定义提示词输入框中的提及行内节点，负责展示、装饰、序列化与编辑器交互约束。
// 状态所有权：节点字段归 Lexical 编辑器；本类只在构造与更新时读写自身字段。
// 阅读顺序：显示标签 → 载荷类型 → 节点字段 → 克隆与反序列化 → DOM 创建与更新 → 导出与工厂。
import {
  $applyNodeReplacement,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  TextNode,
} from "lexical";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  getPromptMentionVariantClassName,
  PROMPT_MENTION_BASE_CLASS_NAME,
} from "@/mentions/mentionChip.js";
import { normalizePromptMentionDisplayLabel } from "@/mentions/promptMentionLabel.js";
import type { MentionCategory, MentionItemData } from "@/mentions/mentionTypes.js";
import { decoratePromptMention } from "@/mentions/nodes/promptMentionDecoration.js";
export * from "@/mentions/nodes/mentionIconDom.js";

// 文件类提及优先显示文件名，路径只作为回退标签。
// 其它分类直接归一显示文本，不再解析路径。
//
function displayLabel(payload: PromptMentionPayload): string {
  const label = normalizePromptMentionDisplayLabel(payload.category, payload.label, payload.value);
  return payload.category === "files"
    ? resolveFileDisplayDescriptor(
        payload.data?.path ?? payload.data?.relativePath ?? payload.value,
      ).fileName || label
    : label;
}

// 载荷是可序列化的纯数据，不含 DOM 或服务引用。
// markdown 是发送与剪贴板使用的规范文本，与展示文字分开。
//
export interface PromptMentionPayload {
  id: string;
  category: MentionCategory;
  label: string;
  value: string;
  markdown: string;
  description?: string;
  data?: MentionItemData;
}

type SerializedPromptMentionNode = SerializedTextNode & {
  category: MentionCategory;
  data?: MentionItemData;
  description?: string;
  mentionId: string;
  markdown: string;
  type: "prompt-mention";
  value: string;
  version: 1;
};

// 节点不可变，所有字段以双下划线私有字段保存。
// 展示文字由父类持有，自有字段只补充提及元数据。
//
export class PromptMentionNode extends TextNode {
  __category: MentionCategory;
  __data?: MentionItemData;
  __description: string;
  __markdown: string;
  __mentionId: string;
  __value: string;

  static getType(): string {
    return "prompt-mention";
  }

  // 克隆复用原键，保证编辑器内部行内移动时身份不变。
  // 数据对象直接引用，溯源信息在本节点生命周期内只读。
  //
  static clone(node: PromptMentionNode): PromptMentionNode {
    return new PromptMentionNode(
      {
        id: node.__mentionId,
        category: node.__category,
        label: node.__text,
        value: node.__value,
        markdown: node.__markdown,
        description: node.__description,
        data: node.__data,
      },
      node.__key,
    );
  }

  // 反序列化先按载荷建节点，再回填文本格式、细节、模式与样式。
  // 四个父类字段必须一起还原，否则粘贴后样式丢失。
  //
  static importJSON(serializedNode: SerializedPromptMentionNode): PromptMentionNode {
    const node = $createPromptMentionNode({
      id: serializedNode.mentionId,
      category: serializedNode.category,
      label: serializedNode.text,
      value: serializedNode.value,
      markdown: serializedNode.markdown,
      description: serializedNode.description,
      data: serializedNode.data,
    });
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }

  // 构造时把显示文本交给父类，剩余字段保存在自有属性。
  // 描述缺省为空串，避免下游出现空值分支。
  //
  constructor(payload: PromptMentionPayload, key?: NodeKey) {
    super(displayLabel(payload), key);
    this.__mentionId = payload.id;
    this.__category = payload.category;
    this.__value = payload.value;
    this.__markdown = payload.markdown;
    this.__description = payload.description ?? "";
    this.__data = payload.data;
  }

  // 保留父类创建的文本节点，图标只作为装饰挂在它外面。
  // 类别与标识写入数据集，样式与测试都依赖这两个属性。
  //
  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    const variantClassName = getPromptMentionVariantClassName(this.__category);
    dom.className = `prompt-mention ${PROMPT_MENTION_BASE_CLASS_NAME} ${variantClassName}`;
    dom.setAttribute("data-mention-category", this.__category);
    dom.setAttribute("data-mention-id", this.__mentionId);
    dom.setAttribute("spellcheck", "false");
    // 根因：TextNode 的 firstChild 链必须通向展示文字，不能被图标截断。
    // 保留 super 创建的文本 DOM，图标只作为不参与选区的 CSS 装饰。
    decoratePromptMention(dom, this.__category, this.__value, this.__data);
    return dom;
  }

  // 类别变化要同时换变体类与数据集属性，不能只改一处。
  // 装饰重绘只在文本、类别、值或可展示的数据字段变化时触发。
  //
  updateDOM(prevNode: PromptMentionNode, dom: HTMLElement, config: EditorConfig): boolean {
    const shouldUpdate = super.updateDOM(prevNode as this, dom, config);
    if (prevNode.__category !== this.__category) {
      const variantClassName = getPromptMentionVariantClassName(this.__category);
      dom.className = `prompt-mention ${PROMPT_MENTION_BASE_CLASS_NAME} ${variantClassName}`;
      dom.setAttribute("data-mention-category", this.__category);
    }

    if (prevNode.__mentionId !== this.__mentionId) {
      dom.setAttribute("data-mention-id", this.__mentionId);
    }

    if (
      prevNode.__text !== this.__text ||
      prevNode.__category !== this.__category ||
      prevNode.__value !== this.__value ||
      prevNode.__data?.path !== this.__data?.path ||
      prevNode.__data?.relativePath !== this.__data?.relativePath ||
      prevNode.__data?.kind !== this.__data?.kind ||
      prevNode.__data?.scope !== this.__data?.scope ||
      prevNode.__data?.icon !== this.__data?.icon
    ) {
      decoratePromptMention(dom, this.__category, this.__value, this.__data);
    }

    return shouldUpdate;
  }

  // 序列化包含全部可还原字段，版本号固定为一。
  // 不写入运行时状态之外的键，保证跨会话可重建。
  //
  exportJSON(): SerializedPromptMentionNode {
    return {
      ...super.exportJSON(),
      type: "prompt-mention",
      version: 1,
      mentionId: this.__mentionId,
      category: this.__category,
      value: this.__value,
      markdown: this.__markdown,
      description: this.__description,
      data: this.__data,
    };
  }

  getMarkdown(): string {
    // 编辑器 offset 必须使用展示文字；canonical 仅供发送和剪贴板序列化。
    return this.getLatest().__markdown;
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  getMention(): PromptMentionPayload {
    return {
      id: this.__mentionId,
      category: this.__category,
      label: this.__text,
      value: this.__value,
      markdown: this.__markdown,
      description: this.__description,
      data: this.__data,
    };
  }
}

// 新建节点固定为 token 模式，避免光标插入点落在提及内部。
// 经节点替换后返回编辑器认可的实例，直接构造会破坏注册表。
//
export function $createPromptMentionNode(payload: PromptMentionPayload): PromptMentionNode {
  const node = new PromptMentionNode(payload);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isPromptMentionNode(
  node: LexicalNode | null | undefined,
): node is PromptMentionNode {
  return node instanceof PromptMentionNode;
}
