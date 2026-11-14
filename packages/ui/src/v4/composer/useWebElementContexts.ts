// INV-01 作用域变化即清空：守住位置 首个副作用；改错故障 切会话后残留上一条目。
// INV-02 工作区键参与过滤：守住位置 两个事件处理；改错故障 其他工作区的元素混入。
// INV-03 工作区键含身份：守住位置 键函数；改错故障 同路径不同账号互相串数据。
// INV-04 监听可整体关闭：守住位置 开关判断；改错故障 无窗口环境仍注册监听。
// INV-05 无窗口环境即退出：守住位置 环境判断；改错故障 服务端渲染时报错。
// INV-06 新增事件先验形状：守住位置 类型守卫；改错故障 任意自定义事件被消费。
// INV-07 载荷非法直接丢弃：守住位置 转换函数；改错故障 缺字段附件进入输入框。
// INV-08 缺标识时补发一个：守住位置 转换；改错故障 同一条目无法去重。
// INV-09 按标识就地替换：守住位置 更新分支；改错故障 重复添加产生两条相同条目。
// INV-10 命中即阻止默认行为：守住位置 事件处理；改错故障 同一事件被多处重复处理。
// INV-11 移除事件双校验：守住位置 两个守卫；改错故障 非本模块事件触发删除。
// INV-12 移除按标识过滤：守住位置 回调；改错故障 误删其他条目。
// INV-13 卸载时解绑：守住位置 清理函数；改错故障 监听器随组件泄漏。
// INV-14 监听依赖含键与删除回调：守住位置 依赖数组；改错故障 工作区切换后仍用旧键。
// INV-15 清空后列表为空：守住位置 清空回调；改错故障 旧数组仍被返回。
// INV-16 返回值整体记忆：守住位置 useMemo；改错故障 每次渲染产生新对象触发重渲染。
// INV-17 有无条目由长度推导：守住位置 返回字段；改错故障 布尔值与列表不同步。
// INV-18 对外只暴露只读数组：守住位置 类型声明；改错故障 调用方直接改写内部列表。
//
// 模块职责：维护输入框里的网页元素附件，并响应跨窗口自定义事件。
// 状态所有权：附件列表归本 hook；作用域与工作区信息来自入参。
// 阅读顺序：先看状态与键，再看两个事件处理，最后看返回值装配。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT,
  WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT,
  createWebElementContextId,
  getWebElementContextWorkspaceKey,
  isWebElementContextAddToChatEvent,
  isWebElementContextPayload,
  isWebElementContextRemoveFromChatEvent,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";

interface WebElementContextRemovePayload {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface UseWebElementContextsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  listenAddToChatEvents?: boolean;
  scopeId?: string | null;
}

export interface UseWebElementContextsResult {
  contexts: readonly WebElementContextComposerAttachment[];
  hasContexts: boolean;
  removeContext: (id: string) => void;
  clearContexts: () => void;
}

// id 与 workspacePath 都必须是非空字符串。
// workspaceIdentity 可缺省，给了就必须是 string。
// payload 不是对象或为 null 时 isRemovePayload 返回 false。
// isRemovePayload 只做形状判断，不做字段转换。
function isRemovePayload(payload: unknown): payload is WebElementContextRemovePayload {
  const candidate = payload as WebElementContextRemovePayload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.workspacePath === "string" &&
    candidate.workspacePath.length > 0 &&
    (candidate.workspaceIdentity === undefined || typeof candidate.workspaceIdentity === "string")
  );
}

function toComposerAttachment(
  payload: Parameters<typeof isWebElementContextPayload>[0],
): WebElementContextComposerAttachment | null {
  if (!isWebElementContextPayload(payload)) {
    return null;
  }
  return {
    ...payload,
    id: payload.id ?? createWebElementContextId(),
  };
}

// 附件列表只在本 hook 内可变。
// workspaceKey 由 workspacePath 与 workspaceIdentity 合成，contexts 不对外暴露 setter。
// scopeId 或 workspaceKey 变化时清空 contexts。
// removeContext 与 clearContexts 都是 useCallback 稳定引用。
// listenAddToChatEvents 默认 true。
export function useWebElementContexts({
  workspacePath,
  workspaceIdentity,
  listenAddToChatEvents = true,
  scopeId = null,
}: UseWebElementContextsOptions): UseWebElementContextsResult {
  const [contexts, setContexts] = useState<readonly WebElementContextComposerAttachment[]>([]);
  const workspaceKey = getWebElementContextWorkspaceKey(workspacePath, workspaceIdentity);

  useEffect(() => {
    setContexts([]);
  }, [scopeId, workspaceKey]);

  const removeContext = useCallback((id: string) => {
    setContexts((items) => items.filter((item) => item.id !== id));
  }, []);

  const clearContexts = useCallback(() => {
    setContexts([]);
  }, []);

  useEffect(() => {
    if (!listenAddToChatEvents || typeof window === "undefined") {
      return;
    }

    // handleAdd 先过 isWebElementContextAddToChatEvent 再取 detail。
    // toComposerAttachment 返回 null 时直接退出。
    // eventWorkspaceKey 与 workspaceKey 不符则忽略。
    // 同 id 命中时 map 替换，不追加重复项。
    // event.preventDefault 在写入前调用。
    const handleAdd = (event: Event) => {
      if (!isWebElementContextAddToChatEvent(event)) {
        return;
      }
      const attachment = toComposerAttachment(event.detail);
      if (!attachment) {
        return;
      }
      const eventWorkspaceKey = getWebElementContextWorkspaceKey(
        attachment.workspacePath,
        attachment.workspaceIdentity,
      );
      if (eventWorkspaceKey !== workspaceKey) {
        return;
      }
      event.preventDefault();
      setContexts((items) => {
        const existingIndex = items.findIndex((item) => item.id === attachment.id);
        if (existingIndex < 0) {
          return [...items, attachment];
        }
        return items.map((item) => (item.id === attachment.id ? attachment : item));
      });
    };

    // handleRemove 分别校验事件与 isRemovePayload。
    // workspaceKey 不符直接返回。
    // 命中后按 id 从 contexts 删除。
    // 删除复用 removeContext 稳定回调。
    // setContexts 的 filter 对不存在的 id 无副作用。
    const handleRemove = (event: Event) => {
      if (!isWebElementContextRemoveFromChatEvent(event)) {
        return;
      }
      if (!isRemovePayload(event.detail)) {
        return;
      }
      const eventWorkspaceKey = getWebElementContextWorkspaceKey(
        event.detail.workspacePath,
        event.detail.workspaceIdentity,
      );
      if (eventWorkspaceKey !== workspaceKey) {
        return;
      }
      event.preventDefault();
      removeContext(event.detail.id);
    };

    window.addEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, handleAdd);
    window.addEventListener(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, handleRemove);
    return () => {
      window.removeEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, handleAdd);
      window.removeEventListener(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, handleRemove);
    };
  }, [listenAddToChatEvents, removeContext, workspaceKey]);

  return useMemo(
    () => ({
      contexts,
      hasContexts: contexts.length > 0,
      removeContext,
      clearContexts,
    }),
    [clearContexts, contexts, removeContext],
  );
}
