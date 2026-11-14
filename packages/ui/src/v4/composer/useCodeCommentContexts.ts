// INV-01 上下文键必须由工作区键与评论标识拼接：守住位置 contextKey；改错故障 不同工作区的同号评论互相覆盖。
// INV-02 工作区键统一走共享函数，不自行拼路径：守住位置 键函数首个入参；改错故障 身份与路径两种口径并存。
// INV-03 状态与引用必须成对更新且在同一个提交函数内完成：守住位置 commitContexts；改错故障 引用先变状态后变，回调读到旧列表。
// INV-04 移除必须按提交函数统一收口，保证移除回调只触发一次：守住位置 提交函数内的差集；改错故障 被移除的附件没有通知上游。
// INV-05 目标不存在时不移除也不通知：守住位置 移除函数的长度比较；改错故障 空操作触发一次全量重渲染。
// INV-06 清空只在实际非空时提交：守住位置 清空函数；改错故障 已空列表也触发上游移除回调。
// INV-07 作用域变化必须清空上下文：守住位置 第一个副作用；改错故障 切换会话后残留上一个会话的评论。
// INV-08 第一个副作用必须用引用比较作用域，避免初次挂载即清空：守住位置 相等则返回；改错故障 首帧把已恢复的上下文清掉。
// INV-09 事件监听可按需关闭：守住位置 监听开关判断；改错故障 只读场景重复消费同一事件。
// INV-10 服务端渲染时不得访问窗口对象：守住位置 监听副作用的环境判断；改错故障 预渲染阶段直接抛错。
// INV-11 添加事件必须校验类型、载荷、默认阻止与可取消性：守住位置 添加处理首个判断；改错故障 重复认领或消费不可取消事件。
// INV-12 认领后要再次确认默认行为已被阻止：守住位置 添加处理第二处判断；改错故障 其它监听者抢先处理后仍重复添加。
// INV-13 同一上下文重复添加时原位替换，不追加：守住位置 已存在索引分支；改错故障 列表出现两份相同评论。
// INV-14 添加后必须请求聚焦：守住位置 添加处理末尾；改错故障 粘入评论后光标仍在原处。
// INV-15 移除事件只校验类型与载荷：守住位置 移除处理前置判断；改错故障 合法移除事件被丢弃。
// INV-16 回调与作用域必须放在引用里，避免重建监听：守住位置 两个引用赋值；改错故障 每次渲染重装事件监听。
// INV-17 监听副作用依赖必须最小且稳定：守住位置 依赖数组；改错故障 无关状态变化导致监听反复装卸。
// INV-18 返回对象必须记忆化，字段与接口一致：守住位置 末尾记忆化；改错故障 消费者因新引用重渲染。
//
// 模块职责：管理输入框里的代码评论附件集合，并桥接预览面板发出的添加与移除事件。
// 状态所有权：附件集合由本 hook 持有；评论正文与位置随附件对象只读携带，hook 不修改其内容。
// 阅读顺序：先看标识与键的纯函数，再读提交、移除、清空三个动作，最后看作用域副作用与事件监听。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CODE_COMMENT_ADD_TO_CHAT_EVENT,
  CODE_COMMENT_REMOVE_FROM_CHAT_EVENT,
  getCodeCommentWorkspaceKey,
  isCodeCommentAddToChatEvent,
  isCodeCommentPayload,
  isCodeCommentRemoveFromChatEvent,
  isCodeCommentRemovePayload,
  type CodeCommentComposerAttachment,
} from "@/lib/codeCommentContext.js";

export interface UseCodeCommentContextsOptions {
  listenAddToChatEvents?: boolean;
  onContextRemoved?: (context: CodeCommentComposerAttachment) => void;
  requestFocus?: () => void;
  scopeKey: string;
}

export interface UseCodeCommentContextsResult {
  contexts: readonly CodeCommentComposerAttachment[];
  hasContexts: boolean;
  removeContext: (
    context: Pick<
      CodeCommentComposerAttachment,
      "id" | "workspaceIdentity" | "workspacePath"
    >,
  ) => void;
  clearContexts: () => void;
  getContexts: () => readonly CodeCommentComposerAttachment[];
}

// 优先用平台随机标识，保证同一毫秒内多次添加也不冲突。
// 平台不支持时退化为时间戳加随机串，仅用于本地会话。
// createCodeCommentAttachmentId() 的结果只作展示与去重键的一部分，不参与排序。
// 该函数不读全局状态，便于在事件回调里直接调用。
function createCodeCommentAttachmentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `code-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// contextKey() 的拼接顺序是先工作区键后评论标识，中间用 \0 隔开。
// 用 \0 作分隔符，保证两段内容不会与拼接结果产生歧义。
// 返回值可直接用于 Set 与 Map 的键。
function contextKey(
  context: Pick<
    CodeCommentComposerAttachment,
    "id" | "workspaceIdentity" | "workspacePath"
  >,
) {
  return `${getCodeCommentWorkspaceKey(context.workspacePath, context.workspaceIdentity)}\0${context.id}`;
}

export function useCodeCommentContexts({
  listenAddToChatEvents = true,
  onContextRemoved,
  requestFocus,
  scopeKey,
}: UseCodeCommentContextsOptions): UseCodeCommentContextsResult {
  const [contexts, setContexts] = useState<
    readonly CodeCommentComposerAttachment[]
  >([]);
  const contextsRef = useRef(contexts);
  const callbacksRef = useRef({ onContextRemoved, requestFocus });
  const scopeKeyRef = useRef(scopeKey);
  callbacksRef.current = { onContextRemoved, requestFocus };

  // commitContexts() 一次提交同时更新 contextsRef 与 contexts 状态。
  // 先按 next 算出被移除项，再逐个调 onContextRemoved()。
  // 通知发生在 contextsRef.current = next 之前，回调看到的是旧列表。
  // [事务] 提交函数不依赖任何外部状态，保持引用稳定。
  const commitContexts = useCallback(
    (next: readonly CodeCommentComposerAttachment[]) => {
      const nextKeys = new Set(next.map(contextKey));
      for (const context of contextsRef.current) {
        if (!nextKeys.has(contextKey(context))) {
          callbacksRef.current.onContextRemoved?.(context);
        }
      }
      contextsRef.current = next;
      setContexts(next);
    },
    [],
  );

  // removeContext() 在目标键不存在时集合长度不变，直接跳过提交。
  // 用 filter 而非就地删除，保证引用语义与 useMemo 比较可靠。
  // 移除通知交给 commitContexts()，removeContext() 不重复调用回调。
  // 只依赖 commitContexts，onContextRemoved 变化不影响本函数身份。
  const removeContext = useCallback(
    (
      target: Pick<
        CodeCommentComposerAttachment,
        "id" | "workspaceIdentity" | "workspacePath"
      >,
    ) => {
      const targetKey = contextKey(target);
      const next = contextsRef.current.filter(
        (context) => contextKey(context) !== targetKey,
      );
      if (next.length !== contextsRef.current.length) {
        commitContexts(next);
      }
    },
    [commitContexts],
  );

  const clearContexts = useCallback(() => {
    if (contextsRef.current.length > 0) {
      commitContexts([]);
    }
  }, [commitContexts]);

  const getContexts = useCallback(() => contextsRef.current, []);

  // 作用域相同则直接返回，避免初次挂载清空已恢复的数据。
  // 作用域变化时同步引用后清空，保证后续回调读到新作用域。
  // clearContexts() 在列表已空时短路，不产生多余通知。
  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return;
    scopeKeyRef.current = scopeKey;
    clearContexts();
  }, [clearContexts, scopeKey]);

  // 关闭监听或服务端渲染时直接返回，不注册任何处理器。
  // 两个事件处理器共享同一份提交与移除逻辑。
  // 清理函数必须成对移除两个监听，避免泄漏。
  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") return;

    // 四类校验任一不通过都放弃：type / payload / 已阻止 / 不可取消。
    // 只有可取消的事件才允许被认领，否则交给其它监听者。
    // 认领后再次确认 event.defaultPrevented 为真，防止竞争。
    // 已存在的同一上下文原位替换，保留其在列表中的位置。
    const handleAdd = (event: Event) => {
      if (
        !isCodeCommentAddToChatEvent(event) ||
        !isCodeCommentPayload(event.detail) ||
        event.defaultPrevented ||
        !event.cancelable
      ) {
        return;
      }
      // V4 迁移只保留了 PreviewPane 的事件发送端，没有任何 composer
      // 消费端；claim 后由唯一 primary pane 接管，避免分屏时重复写入多个输入区。
      event.preventDefault();
      if (!event.defaultPrevented) return;
      const attachment: CodeCommentComposerAttachment = {
        ...event.detail,
        id: event.detail.id ?? createCodeCommentAttachmentId(),
      };
      const key = contextKey(attachment);
      const existingIndex = contextsRef.current.findIndex(
        (context) => contextKey(context) === key,
      );
      const next =
        existingIndex < 0
          ? [...contextsRef.current, attachment]
          : contextsRef.current.map((context, index) =>
              index === existingIndex ? attachment : context,
            );
      commitContexts(next);
      callbacksRef.current.requestFocus?.();
    };

    const handleRemove = (event: Event) => {
      if (
        !isCodeCommentRemoveFromChatEvent(event) ||
        !isCodeCommentRemovePayload(event.detail)
      ) {
        return;
      }
      removeContext(event.detail);
    };

    window.addEventListener(CODE_COMMENT_ADD_TO_CHAT_EVENT, handleAdd);
    window.addEventListener(CODE_COMMENT_REMOVE_FROM_CHAT_EVENT, handleRemove);
    return () => {
      window.removeEventListener(CODE_COMMENT_ADD_TO_CHAT_EVENT, handleAdd);
      window.removeEventListener(
        CODE_COMMENT_REMOVE_FROM_CHAT_EVENT,
        handleRemove,
      );
    };
  }, [commitContexts, listenAddToChatEvents, removeContext]);

  return useMemo(
    () => ({
      contexts,
      hasContexts: contexts.length > 0,
      removeContext,
      clearContexts,
      getContexts,
    }),
    [clearContexts, contexts, getContexts, removeContext],
  );
}
