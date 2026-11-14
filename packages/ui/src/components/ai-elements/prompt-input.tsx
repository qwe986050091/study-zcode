/*
 * Derived from vercel/ai-elements (packages/elements/src/prompt-input.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// PromptInput 家族：受控/非受控两套输入状态 + 附件收集 + 表单提交桥。
// 职责边界：只管编辑态与“提交一次”的载荷组装，不持有会话、不排队、不发送；
// 提交后的 accepted 队列与 busy 语义属于 runtime CommandInbox，本组件不承接第二份。
// 状态所有者：存在 PromptInputProvider 时 textInput/attachments 归它，否则归 PromptInput 本地。
// 本地引用文档（referencedSources）始终归 PromptInput 本地，不随 provider 上浮。
// INV 表（每条都是可被改坏的隐性契约）：
// INV-01 断言：提交只由 form submit 触发，输入法组合态的 Enter 不得被当成提交 —— 守住它的位置：handleSubmit 与 Textarea 的组合事件边界 —— 改错故障：中日文选词时误发送半截文本。
// INV-02 断言：受控与非受控模式产出同一 AttachmentsContext 形状 —— 守住它的位置：add/remove/openFileDialog 的三元选择 —— 改错故障：两种模式行为分叉，菜单打不开或删不掉。
// INV-03 断言：有 provider 时附件唯一来源是 provider，本地 items 不得再生效 —— 守住它的位置：files 的 usingProvider 分支 —— 改错故障：出现两份附件真相，UI 与提交载荷不一致。
// INV-04 断言：accept / maxFileSize / maxFiles 校验必须在进入列表前完成 —— 守住它的位置：addLocal 与 addWithProviderValidation —— 改错故障：超限文件入列，后续永久超配额。
// INV-05 断言：同一批文件按 accept→size→capacity 顺序过滤，容量按“已有数量”扣减 —— 守住它的位置：两个 add 实现 —— 改错故障：批量粘贴超额写入，或误杀全部合法文件。
// INV-06 断言：被拒文件必须经 onError 上报且不得静默吞掉 —— 守住它的位置：三个提前 return 分支 —— 改错故障：拖入大文件后用户零反馈。
// INV-07 断言：blob URL 在移除、清空、卸载三处都必须 revoke —— 守住它的位置：remove/clear/卸载 effect —— 改错故障：长会话内存泄漏，预览图不释放。
// INV-08 断言：provider 模式卸载不得 revoke 共享 URL —— 守住它的位置：卸载清理 effect 的 usingProvider 守卫 —— 改错故障：父级仍引用的附件变破图。
// INV-09 断言：提交前把 blob: 转 data:，转换失败保留原 URL 而不是丢文件 —— 守住它的位置：handleSubmit 的 Promise.all —— 改错故障：附件在提交瞬间凭空消失。
// INV-10 断言：文本必须在 await 之前捕获并 reset —— 守住它的位置：handleSubmit 顶部 —— 改错故障：异步转换期间用户追加的内容丢失。
// INV-11 断言：onSubmit reject 或抛错时不清空输入与附件 —— 守住它的位置：两处 catch —— 改错故障：失败重试成本变高，用户被迫重打。
// INV-12 断言：drop 监听在 form 与 document 之间二选一，不得重复绑定 —— 守住它的位置：两个 drop effect 的 globalDrop 守卫 —— 改错故障：一次拖拽添加两遍文件。
// INV-13 断言：file input 每次 change 后清 value，允许重选同一文件 —— 守住它的位置：handleChange 末尾 —— 改错故障：删除后再选同名文件无反应。
// INV-14 断言：上下文缺失或校验不可用时写路径必须 fail-closed —— 守住它的位置：各处 context 取值与 add 包装 —— 改错故障：静默放行未校验附件或整块 UI 抛错。
import { InputGroup, InputGroupAddon } from "../ui/input-group.js";
import { cn } from "../lib/utils.js";
import type { FileUIPart, SourceDocumentUIPart } from "ai";
import { nanoid } from "nanoid";
import type {
  ChangeEventHandler,
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  PropsWithChildren,
  RefObject,
} from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// ============================================================================
// Helpers
// ============================================================================

// [资源] fetch(blob:) 取回 Blob 再交 FileReader 转 data URL，全程不落盘、不缓存。
// [失败路径] fetch 抛错、reader.onerror、result 非字符串三种失败统一归一为 null，调用方据此回退原 URL。
// [权衡] 失败返回 null 而不抛出：单个附件转换失败不应让整次提交失败。
// [资源] 每次调用都重读整个附件，大文件重复提交会重复 IO，属已知成本。
const convertBlobUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    // FileReader uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    return new Promise((resolve) => {
      const reader = new FileReader();
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onloadend = () => resolve(reader.result as string);
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};

// ============================================================================
// Provider Context & Types
// ============================================================================

// [契约] files 是渲染用投影，add/remove/clear 是唯一写入口，openFileDialog 委托隐藏 input。
// [契约] fileInputRef 暴露给外部菜单，用于在组件外触发同一个文件选择器。
// [权衡] 上下文只暴露最小集合，不暴露 setState，避免子组件绕过 accept/size/maxFiles 校验。
export interface AttachmentsContext {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

export interface TextInputContext {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
}

export interface PromptInputControllerProps {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (ref: RefObject<HTMLInputElement | null>, open: () => void) => void;
}

// [契约] 两个 context 分工：controller 承载 textInput 与 attachments，另一个只承载附件。
// [权衡] 拆成两层，让只依赖附件的子组件不被 textInput 每次键入重渲染。
// [契约] null 为缺省值，强制消费方通过 hook 判断存在性，而不是拿到假实现。
const PromptInputController = createContext<PromptInputControllerProps | null>(null);
const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(null);

// [失败路径] 无 Provider 时抛错而非返回空实现，属显式 fail-fast。
// [契约] 报错文案固定提示包一层 PromptInputProvider，是主要排障入口。
// [权衡] 严格版与 optional 版并存，组件内部一律用 optional 版，避免双模式崩溃。
export const usePromptInputController = () => {
  const ctx = useContext(PromptInputController);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use usePromptInputController().",
    );
  }
  return ctx;
};

// [契约] optional 版允许返回 null，调用方必须自行处理降级路径。
// [权衡] 内嵌与 Provider 两种用法共用同一套组件，靠这两个 hook 分流。
// Optional variants (do NOT throw). Useful for dual-mode components.
export const useOptionalPromptInputController = () => useContext(PromptInputController);

export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext);
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use useProviderAttachments().",
    );
  }
  return ctx;
};

const useOptionalProviderAttachments = () => useContext(ProviderAttachmentsContext);

export type PromptInputProviderProps = PropsWithChildren<{
  initialInput?: string;
}>;

/**
 * Optional global provider that lifts PromptInput state outside of PromptInput.
 * If you don't use it, PromptInput stays fully self-managed.
 */
// [契约] Provider 把 textInput 与 attachments 提升为全局，供组件外的侧栏等读写。
// [事务] 附件增删都走函数式 setState，不读旧闭包再写回，避免并发添加互相覆盖。
// [资源] 卸载时按 ref 中最新列表统一 revoke，避免闭包拿到过期数组。
// [契约] initialInput 只作为受控文本初值，后续变更一律经 setInput 单写入口。
export const PromptInputProvider = ({
  initialInput: initialTextInput = "",
  children,
}: PromptInputProviderProps) => {
  // ----- textInput state
  const [textInput, setTextInput] = useState(initialTextInput);
  const clearInput = useCallback(() => setTextInput(""), []);

  // ----- attachments state (global when wrapped)
  const [attachmentFiles, setAttachmentFiles] = useState<(FileUIPart & { id: string })[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // oxlint-disable-next-line eslint(no-empty-function)
  const openRef = useRef<() => void>(() => {});

  // [事务] 先把 FileList 展开为数组再入队；空批次直接返回，不触发无意义 setState。
  // [契约] provider 的 add 不做 accept/大小/数量校验，校验责任在下层 PromptInput 的包装函数。
  // [权衡] 不在 provider 重复校验，避免两处规则漂移；代价是绕过 PromptInput 直接调用时无保护。
  // [资源] 每个文件恰好创建一次 createObjectURL，与后续 revoke 一一对应。
  const add = useCallback((files: File[] | FileList) => {
    const incoming = [...files];
    if (incoming.length === 0) {
      return;
    }

    setAttachmentFiles((prev) => [
      ...prev,
      ...incoming.map((file) => ({
        filename: file.name,
        id: nanoid(),
        mediaType: file.type,
        type: "file" as const,
        url: URL.createObjectURL(file),
      })),
    ]);
  }, []);

  // [资源] 删除前先按 id 找到条目并 revoke，再过滤列表。
  // [事务] revoke 与删除在同一 updater 内完成，避免中间态让 UI 引用已释放 URL。
  // [失败路径] id 不存在时 no-op，不抛错也不额外重渲染。
  const remove = useCallback((id: string) => {
    setAttachmentFiles((prev) => {
      const found = prev.find((f) => f.id === id);
      if (found?.url) {
        URL.revokeObjectURL(found.url);
      }
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachmentFiles((prev) => {
      for (const f of prev) {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
      }
      return [];
    });
  }, []);

  // [资源] attachmentsRef 始终指向最新列表，专供卸载清理读取。
  // [并发] 清理 effect 依赖为空，只能经 ref 取当前值，否则会 revoke 旧快照。
  // [权衡] 多一层 ref 同步 effect 的代价，换取卸载时零泄漏。
  // Keep a ref to attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef(attachmentFiles);

  useEffect(() => {
    attachmentsRef.current = attachmentFiles;
  }, [attachmentFiles]);

  // Cleanup blob URLs on unmount to prevent memory leaks
  useEffect(
    () => () => {
      for (const f of attachmentsRef.current) {
        if (f.url) {
          URL.revokeObjectURL(f.url);
        }
      }
    },
    [],
  );

  const openFileDialog = useCallback(() => {
    openRef.current?.();
  }, []);

  // [契约] attachments 对象按 files 与各动作引用重建，形状与本地版本一致。
  // [并发] add/remove/clear/openFileDialog 均由 useCallback 固定，避免 context 值无谓抖动。
  // [权衡] files 变化必然重建 context，订阅附件的子树会重渲染，这是可接受成本。
  const attachments = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear,
      fileInputRef,
      files: attachmentFiles,
      openFileDialog,
      remove,
    }),
    [attachmentFiles, add, remove, clear, openFileDialog],
  );

  // [契约] provider 借此拿到隐藏 input 的 ref 与 open 回调，外部菜单才能复用。
  // [并发] 注册在 effect 中执行，input 挂载后才写入，避免拿到 null。
  // [契约] clear 组合附件清空与引用文档清空，是提交成功后的统一收尾。
  const __registerFileInput = useCallback(
    (ref: RefObject<HTMLInputElement | null>, open: () => void) => {
      fileInputRef.current = ref.current;
      openRef.current = open;
    },
    [],
  );

  const controller = useMemo<PromptInputControllerProps>(
    () => ({
      __registerFileInput,
      attachments,
      textInput: {
        clear: clearInput,
        setInput: setTextInput,
        value: textInput,
      },
    }),
    [textInput, clearInput, attachments, __registerFileInput],
  );

  return (
    <PromptInputController.Provider value={controller}>
      <ProviderAttachmentsContext.Provider value={attachments}>
        {children}
      </ProviderAttachmentsContext.Provider>
    </PromptInputController.Provider>
  );
};

// ============================================================================
// Component Context & Hooks
// ============================================================================

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

// [契约] 优先本地 context（带校验），缺失时才回退 provider，保证内嵌用法仍有校验。
// [契约] 两者都缺失时抛错，防止在错误树位置静默拿到空实现。
// [失败路径] 抛错文案同时点名 PromptInput 与 PromptInputProvider，指明修复位置。
// [权衡] 本地优先意味着 Provider 场景下 add 仍是包装后版本，而不是 provider 裸版。
export const usePromptInputAttachments = () => {
  // Prefer local context (inside PromptInput) as it has validation, fall back to provider
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    );
  }
  return context;
};

// ============================================================================
// Referenced Sources (Local to PromptInput)
// ============================================================================

export interface ReferencedSourcesContext {
  sources: (SourceDocumentUIPart & { id: string })[];
  add: (sources: SourceDocumentUIPart[] | SourceDocumentUIPart) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const LocalReferencedSourcesContext = createContext<ReferencedSourcesContext | null>(null);

// [契约] 引用文档上下文仅本地存在，provider 模式也不上浮。
// [失败路径] 缺 Provider 时抛错，避免返回 undefined 让调用方在渲染期崩溃。
export const usePromptInputReferencedSources = () => {
  const ctx = useContext(LocalReferencedSourcesContext);
  if (!ctx) {
    throw new Error(
      "usePromptInputReferencedSources must be used within a LocalReferencedSourcesContext.Provider",
    );
  }
  return ctx;
};

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
}

// [契约] 在 form 原生属性上剔除 onSubmit/onError，换成携带 text+files 的提交签名。
// [契约] accept 为空串或 undefined 视为全接受；multiple 决定选择器是否多选。
// [契约] maxFiles/maxFileSize 是列表上限而非单次上限，容量按已有数量扣减。
// [契约] globalDrop 默认关闭；开启后 document 级接管拖放，form 级监听让位。
// [失败路径] onError 是唯一拒绝反馈通道，未传则拒绝静默发生。
export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & {
  // e.g., "image/*" or leave undefined for any
  accept?: string;
  multiple?: boolean;
  // When true, accepts drops anywhere on document. Default false (opt-in).
  globalDrop?: boolean;
  // Render a hidden input with given name and keep it in sync for native form posts. Default false.
  syncHiddenInput?: boolean;
  // Minimal constraints
  maxFiles?: number;
  // bytes
  maxFileSize?: number;
  onError?: (err: { code: "max_files" | "max_file_size" | "accept"; message: string }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

// [契约] 用 optional controller 判断是否处于 Provider 模式，据此决定附件状态归属。
// [契约] 组件内部始终提供 LocalAttachmentsContext，子组件拿到的 add 一定是校验过的版本。
// [权衡] 本地 items 与 provider files 两套存储只能生效一套，靠 usingProvider 三元切换。
// [并发] filesRef 随 files 更新，卸载清理只读 ref，避免闭包过期。
export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  // Try to use a provider controller if present
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  // Refs
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // ----- Local attachments (only used when no provider)
  const [items, setItems] = useState<(FileUIPart & { id: string })[]>([]);
  const files = usingProvider ? controller.attachments.files : items;

  // ----- Local referenced sources (always local to PromptInput)
  const [referencedSources, setReferencedSources] = useState<
    (SourceDocumentUIPart & { id: string })[]
  >([]);

  // Keep a ref to files for cleanup on unmount (avoids stale closure)
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // [契约] 本地模式点击自身隐藏 input；provider 模式转发到已注册的 open 回调。
  // [失败路径] ref 未挂载时用可选链，点击无副作用而不抛错。
  // [权衡] 此处不做 focus 管理，焦点策略交给上层菜单。
  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  // [契约] accept 按逗号拆分、去空白、丢空项；通配前缀匹配，其余要求类型全等。
  // [失败路径] 无 accept 时一律放行，语义为“未配置即不限”。
  // [权衡] 只按 MIME 粗判、不解析扩展名，浏览器给出空 type 的文件会被严格模式拒绝。
  // [契约] 结果只依赖 accept，用 useCallback 固定引用以免 add 反复重建。
  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") {
        return true;
      }

      const patterns = accept
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      return patterns.some((pattern) => {
        if (pattern.endsWith("/*")) {
          // e.g: image/* -> image/
          const prefix = pattern.slice(0, -1);
          return f.type.startsWith(prefix);
        }
        return f.type === pattern;
      });
    },
    [accept],
  );

  // [事务] 过滤顺序固定为 accept → size → capacity，前一步全灭则提前 return 并上报。
  // [失败路径] 全被类型拒绝报 accept，全被大小拒绝报 max_file_size，超额部分报 max_files。
  // [契约] capacity 用 maxFiles 减当前列表长度，批量添加不会突破总量上限。
  // [资源] 只有真正入列的文件才 createObjectURL，被截断的不产生泄漏。
  const addLocal = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "No files match the accepted types.",
        });
        return;
      }
      const withinSize = (f: File) => (maxFileSize ? f.size <= maxFileSize : true);
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "All files exceed the maximum size.",
        });
        return;
      }

      setItems((prev) => {
        const capacity =
          typeof maxFiles === "number" ? Math.max(0, maxFiles - prev.length) : undefined;
        const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized;
        if (typeof capacity === "number" && sized.length > capacity) {
          onError?.({
            code: "max_files",
            message: "Too many files. Some were not added.",
          });
        }
        const next: (FileUIPart & { id: string })[] = [];
        for (const file of capped) {
          next.push({
            filename: file.name,
            id: nanoid(),
            mediaType: file.type,
            type: "file",
            url: URL.createObjectURL(file),
          });
        }
        return [...prev, ...next];
      });
    },
    [matchesAccept, maxFiles, maxFileSize, onError],
  );

  // [资源] 先查再 revoke，保证与创建时一一对应。
  // [事务] 删除与 revoke 在同一 updater 内，避免渲染读到已释放 URL。
  // [失败路径] id 不存在时返回过滤后的新数组，不产生额外副作用。
  const removeLocal = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id);
        if (found?.url) {
          URL.revokeObjectURL(found.url);
        }
        return prev.filter((file) => file.id !== id);
      }),
    [],
  );

  // [契约] provider 模式唯一入口：先做与本地完全相同的三道校验，再委托 provider.add。
  // [权衡] 与 addLocal 有意重复而不抽公共函数，换取两条路径各自依赖清晰。
  // [并发] 容量用渲染期 files.length 计算，快速连发添加时可能低估，最终以列表长度为准。
  // [失败路径] capped 为空时完全不调用 provider.add，避免空写触发重渲染。
  // Wrapper that validates files before calling provider's add
  const addWithProviderValidation = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList];
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "No files match the accepted types.",
        });
        return;
      }
      const withinSize = (f: File) => (maxFileSize ? f.size <= maxFileSize : true);
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "All files exceed the maximum size.",
        });
        return;
      }

      const currentCount = files.length;
      const capacity =
        typeof maxFiles === "number" ? Math.max(0, maxFiles - currentCount) : undefined;
      const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized;
      if (typeof capacity === "number" && sized.length > capacity) {
        onError?.({
          code: "max_files",
          message: "Too many files. Some were not added.",
        });
      }

      if (capped.length > 0) {
        controller?.attachments.add(capped);
      }
    },
    [matchesAccept, maxFileSize, maxFiles, onError, files.length, controller],
  );

  // [资源] provider 模式清空交给 provider 统一 revoke，本地模式自行遍历 revoke 后置空。
  // [契约] 只清附件不清文本，文本清空由调用方按模式决定。
  // [事务] 本地分支在同一 updater 内完成 revoke 与置空。
  const clearAttachments = useCallback(
    () =>
      usingProvider
        ? controller?.attachments.clear()
        : setItems((prev) => {
            for (const file of prev) {
              if (file.url) {
                URL.revokeObjectURL(file.url);
              }
            }
            return [];
          }),
    [usingProvider, controller],
  );

  const clearReferencedSources = useCallback(() => setReferencedSources([]), []);

  // [契约] add/remove/openFileDialog 三个动作按 usingProvider 一次性选定，运行期不得混用。
  // [权衡] 三元选择让两条路径共享同一 context 形状，子组件无需感知模式。
  // [契约] 两种模式的 openFileDialog 语义一致：都打开同一个隐藏 input。
  const add = usingProvider ? addWithProviderValidation : addLocal;
  const remove = usingProvider ? controller.attachments.remove : removeLocal;
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  const clear = useCallback(() => {
    clearAttachments();
    clearReferencedSources();
  }, [clearAttachments, clearReferencedSources]);

  // Let provider know about our hidden file input so external menus can call openFileDialog()
  useEffect(() => {
    if (!usingProvider) {
      return;
    }
    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  // [权衡] 受浏览器安全限制无法用代码设置 file input 的文件，syncHiddenInput 只剩清空语义。
  // [失败路径] 仅在列表为空时清空 value，避免误清正在选择的输入。
  // Note: File input cannot be programmatically set for security reasons
  // The syncHiddenInput prop is no longer functional
  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = "";
    }
  }, [files, syncHiddenInput]);

  // [并发] form 级 dragover/drop 监听在 effect 中挂载与移除，依赖 add 与 globalDrop。
  // [契约] 只在 dataTransfer 含 Files 时 preventDefault，避免干扰内部文本拖拽。
  // [契约] globalDrop 为真时 form 级监听直接让位，由 document 级接管，保证只处理一次。
  // [权衡] 监听挂在 form 而非内层容器，拖放区域与提交区域保持一致。
  // Attach drop handlers on nearest form and document (opt-in)
  useEffect(() => {
    const form = formRef.current;
    if (!form) {
      return;
    }
    if (globalDrop) {
      // when global drop is on, let the document-level handler own drops
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    form.addEventListener("dragover", onDragOver);
    form.addEventListener("drop", onDrop);
    return () => {
      form.removeEventListener("dragover", onDragOver);
      form.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(() => {
    // [并发] document 级监听只在 globalDrop 开启时挂载，卸载时对称移除。
    // [契约] 与 form 级逻辑一致：含 Files 才 preventDefault 并交给 add 处理。
    if (!globalDrop) {
      return;
    }

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
      }
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [add, globalDrop]);

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) {
            URL.revokeObjectURL(f.url);
          }
        }
      }
    },
    [usingProvider],
  );

  // [契约] 选择文件后立即交给 add（含全部校验），随后把 input.value 置空。
  // [契约] 置空是必需的：否则再次选择同一文件不会触发 change。
  // [失败路径] files 为空时跳过 add，但仍执行置空。
  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) {
        add(event.currentTarget.files);
      }
      // Reset input value to allow selecting files that were previously removed
      event.currentTarget.value = "";
    },
    [add],
  );

  // [契约] 对外暴露的 files 做浅拷贝并保留 id，防止子组件原地修改内部数组。
  // [并发] context 值随 files 与动作引用重建，动作本身用 useCallback 稳定。
  // [权衡] 每次列表变化都新建对象，换来依赖可读、无隐藏可变引用。
  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear: clearAttachments,
      fileInputRef: inputRef,
      files: files.map((item) => ({ ...item, id: item.id })),
      openFileDialog,
      remove,
    }),
    [files, add, remove, clearAttachments, openFileDialog],
  );

  // [事务] 引用文档添加统一做数组归一化，单个与批量共用一条写路径。
  // [契约] 每次 `add` 生成新的 `nanoid()`，同一文档加入两次视为两条引用。
  // [契约] remove 只按 id 过滤引用列表，不影响附件列表。
  const refsCtx = useMemo<ReferencedSourcesContext>(
    () => ({
      add: (incoming: SourceDocumentUIPart[] | SourceDocumentUIPart) => {
        const array = Array.isArray(incoming) ? incoming : [incoming];
        setReferencedSources((prev) => [...prev, ...array.map((s) => ({ ...s, id: nanoid() }))]);
      },
      clear: clearReferencedSources,
      remove: (id: string) => {
        setReferencedSources((prev) => prev.filter((s) => s.id !== id));
      },
      sources: referencedSources,
    }),
    [referencedSources, clearReferencedSources],
  );

  // [契约] 提交只由 form submit 触发；组合态 Enter 是否冒泡到 form 由 Textarea 侧拦截，此处不重复判断。
  // [契约] 文本来源按模式区分：provider 读受控值，本地读 FormData 并立即 reset。
  // [并发] 文本在 await 之前捕获，防止异步 blob 转换期间的新输入被清掉。
  // [事务] blob: 逐个转 data:，转换失败保留原 URL，保证文件不丢。
  // [失败路径] onSubmit reject 或同步抛错都不清空输入与附件，保留重试可能。
  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault();

      const form = event.currentTarget;
      const text = usingProvider
        ? controller.textInput.value
        : (() => {
            const formData = new FormData(form);
            return (formData.get("message") as string) || "";
          })();

      // Reset form immediately after capturing text to avoid race condition
      // where user input during async blob conversion would be lost
      if (!usingProvider) {
        form.reset();
      }

      try {
        // Convert blob URLs to data URLs asynchronously
        const convertedFiles: FileUIPart[] = await Promise.all(
          files.map(async ({ id: _id, ...item }) => {
            if (item.url?.startsWith("blob:")) {
              const dataUrl = await convertBlobUrlToDataUrl(item.url);
              // If conversion failed, keep the original blob URL
              return {
                ...item,
                url: dataUrl ?? item.url,
              };
            }
            return item;
          }),
        );

        const result = onSubmit({ files: convertedFiles, text }, event);

        // Handle both sync and async onSubmit
        if (result instanceof Promise) {
          try {
            await result;
            clear();
            if (usingProvider) {
              controller.textInput.clear();
            }
          } catch {
            // Don't clear on error - user may want to retry
          }
        } else {
          // Sync function completed without throwing, clear inputs
          clear();
          if (usingProvider) {
            controller.textInput.clear();
          }
        }
      } catch {
        // Don't clear on error - user may want to retry
      }
    },
    [usingProvider, controller, files, onSubmit, clear],
  );

  // [权衡] 隐藏 input 与 form 并列渲染，input 不参与视觉，仅作选择器载体。
  // [契约] form 的 className 由外部透传并与 w-full 合并，其余原生属性整体展开。
  // [契约] 提交按钮不在此处，子组件通过 context 与 form 原生 submit 对接。
  // Render with or without local provider
  const inner = (
    <>
      <input
        accept={accept}
        aria-label="Upload files"
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title="Upload files"
        type="file"
      />
      <form className={cn("w-full", className)} onSubmit={handleSubmit} ref={formRef} {...props}>
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
    </>
  );

  // [契约] 引用文档 Provider 包住表单，附件 Provider 再包住引用，层序固定不可交换。
  // [契约] 无论是否 Provider 模式都固定提供 LocalAttachmentsContext，保证校验入口唯一。
  // [失败路径] 上层 Provider 缺失不会让子树崩溃，因为这里提供的是本地实现。
  const withReferencedSources = (
    <LocalReferencedSourcesContext.Provider value={refsCtx}>
      {inner}
    </LocalReferencedSourcesContext.Provider>
  );

  // Always provide LocalAttachmentsContext so children get validated add function
  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      {withReferencedSources}
    </LocalAttachmentsContext.Provider>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
);

export type PromptInputHeaderProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputHeader = ({ className, ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("order-first flex-wrap gap-1", className)}
    {...props}
  />
);

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 items-center gap-1", className)} {...props} />
);

// 从 prompt-input-buttons 重新导出 Button / Submit 组件
export * from "./prompt-input-buttons.js";

// 从 prompt-input-actions 重新导出 Action 系列组件
export * from "./prompt-input-actions.js";

// 从 prompt-input-textarea 重新导出 Textarea 组件
export * from "./prompt-input-textarea.js";

// 从 prompt-input-primitives 重新导出 Select / HoverCard / Tabs / Command 系列组件
export * from "./prompt-input-primitives.js";
