// INV-01 初始值即读取当前作用域：守住位置 useState 惰性初始化；改错故障 切换会话后闪现旧引用。
// INV-02 作用域由会话与工作区共同决定：守住位置 组合键；改错故障 跨会话串引用。
// INV-03 草稿作用域单独参与：守住位置 draftScopeKey；改错故障 两个草稿互相覆盖。
// INV-04 作用域变化立即重读：守住位置 useEffect 依赖；改错故障 切换后仍显示旧数据。
// INV-05 写入同时更新外部作用域：守住位置 setConversationSelectionReferenceScope；改错故障 刷新后引用丢失。
// INV-06 支持函数式更新：守住位置 typeof update；改错故障 并发更新互相覆盖。
// INV-07 只订阅本作用域事件：守住位置 三个字段比对；改错故障 其它会话的添加触发重渲染。
// INV-08 草稿会话用空值判定：守住位置 sessionId === null；改错故障 草稿事件串到正式会话。
// INV-09 事件监听在卸载时移除：守住位置 清理函数；改错故障 重复注册导致泄漏。
// INV-10 移除引用只按 id：守住位置 filter；改错故障 误删同名引用。
// INV-11 移除后清空上限提示：守住位置 setLimitReason(null)；改错故障 提示残留。
// INV-12 清空引用同时清提示：守住位置 clearReferences；改错故障 列表空但提示仍在。
// INV-13 关闭提示要写回存储：守住位置 clearConversationSelectionReferenceLimitReason；改错故障 刷新后提示复现。
// INV-14 上限原因单独存放：守住位置 limitReason 状态；改错故障 与引用混在一起。
// INV-15 回调依赖保持稳定：守住位置 useCallback 依赖；改错故障 每渲染重建引用。
// INV-16 返回值面收敛：守住位置 末尾对象；改错故障 外部依赖内部实现细节。
// INV-17 读取与订阅共用选择器：守住位置 getConversationSelectionReferenceScope；改错故障 两个入口数据不一致。
// INV-18 清空只影响当前作用域：守住位置 键参数；改错故障 清空其它会话的引用。
//
// 模块职责：把会话选择引用与上限提示接到 React 状态，并同步回作用域存储。
// 状态所有权：引用与上限原因以外部作用域存储为准，本地状态只是镜像。
// 阅读顺序：先看初始化，再看两个 effect，最后看三个动作。
import { useCallback, useEffect, useState } from "react";
import {
  clearConversationSelectionReferenceLimitReason,
  getConversationSelectionReferenceScope,
  getConversationSelectionReferenceLimitReason,
  getConversationSelectionAddEventName,
  isConversationSelectionAddEvent,
  setConversationSelectionReferenceScope,
  type ConversationSelectionLimitReason,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

// useState 的惰性初值直接读 getConversationSelectionReferenceScope，避免首帧空列表。
// 作用域键由 sessionId、workspaceKey、draftScopeKey 三段拼成。
// draftScopeKey 单独参与，草稿与正式会话的引用互不覆盖。
// 三个键变化时 effect 立即重读，切换会话不残留旧引用。
export function useConversationSelectionReferences(options: {
  sessionId: string | null;
  workspaceKey: string;
  draftScopeKey?: string;
}) {
  const [references, setReferencesState] = useState<readonly ConversationSelectionReference[]>(() =>
    getConversationSelectionReferenceScope(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    ),
  );
  const [limitReason, setLimitReason] = useState<ConversationSelectionLimitReason | null>(() =>
    getConversationSelectionReferenceLimitReason(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    ),
  );

  // 作用域变化时同时重读 references 与 limitReason。
  // getConversationSelectionReferenceLimitReason 与引用读同一作用域。
  // 依赖数组只列 sessionId/workspaceKey/draftScopeKey 三个键。
  useEffect(() => {
    setReferencesState(
      getConversationSelectionReferenceScope(
        options.sessionId,
        options.workspaceKey,
        options.draftScopeKey,
      ),
    );
    setLimitReason(
      getConversationSelectionReferenceLimitReason(
        options.sessionId,
        options.workspaceKey,
        options.draftScopeKey,
      ),
    );
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  // setReferences 支持函数式更新，typeof update === "function" 时先取 current。
  // 新值写入后立即调 setConversationSelectionReferenceScope 同步外部存储。
  // useCallback 依赖三个作用域键，键不变时回调引用稳定。
  const setReferences = useCallback(
    (
      update:
        | readonly ConversationSelectionReference[]
        | ((
            current: readonly ConversationSelectionReference[],
          ) => readonly ConversationSelectionReference[]),
    ) => {
      setReferencesState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        setConversationSelectionReferenceScope(
          options.sessionId,
          options.workspaceKey,
          next,
          options.draftScopeKey,
        );
        return next;
      });
    },
    [options.sessionId, options.workspaceKey, options.draftScopeKey],
  );

  // handleAdd 先用 isConversationSelectionAddEvent 校验事件形状。
  // sessionId 为 null 时按 draftScopeKey 判定草稿作用域。
  // 卸载时 removeEventListener 移除同一 handleAdd，避免重复注册。
  useEffect(() => {
    const handleAdd = (event: Event) => {
      if (!isConversationSelectionAddEvent(event)) return;
      if (
        event.detail.targetSessionId !== options.sessionId ||
        event.detail.workspaceKey !== options.workspaceKey ||
        (options.sessionId === null && event.detail.draftScopeKey !== options.draftScopeKey)
      ) {
        return;
      }
      setReferencesState(
        getConversationSelectionReferenceScope(
          options.sessionId,
          options.workspaceKey,
          options.draftScopeKey,
        ),
      );
      setLimitReason(
        getConversationSelectionReferenceLimitReason(
          options.sessionId,
          options.workspaceKey,
          options.draftScopeKey,
        ),
      );
    };
    window.addEventListener(getConversationSelectionAddEventName(), handleAdd);
    return () => window.removeEventListener(getConversationSelectionAddEventName(), handleAdd);
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  // removeReference 用 reference.id !== id 过滤，不按名称匹配。
  // 删除后 setLimitReason(null)，上限提示不残留。
  // setReferences 内部按当前作用域写入，清空不影响其它会话。
  const removeReference = useCallback(
    (id: string) => {
      setReferences((current) => current.filter((reference) => reference.id !== id));
      setLimitReason(null);
    },
    [setReferences],
  );
  const clearReferences = useCallback(() => {
    setReferences([]);
    setLimitReason(null);
  }, [setReferences]);
  const dismissLimitReason = useCallback(() => {
    clearConversationSelectionReferenceLimitReason(
      options.sessionId,
      options.workspaceKey,
      options.draftScopeKey,
    );
    setLimitReason(null);
  }, [options.sessionId, options.workspaceKey, options.draftScopeKey]);

  return {
    references,
    limitReason,
    dismissLimitReason,
    removeReference,
    clearReferences,
  };
}
