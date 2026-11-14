// 提交结果合并进 TUI 状态。
// 职责：把 TuiSubmitPromptResult 投影到消息、模式、用量、选区与排队输入。
// 边界：只消费结果，不发起请求；不新建 store，全部 setter 由调用方注入。
// 副作用：批量 setState；resetSessionProjection 时清空旧会话投影。
// 兜底：mode/model/locale/loginRequired 缺失回落 fallback；preserveTurnState 早退不清 turn 状态。

import type { CollaborationMode, ModelUsageSummary, TodoItem, TurnId } from "@zcode/contracts";
import { getZCodeCopy } from "@zcode/i18n";
import React from "react";
import { validContextUsage } from "./app-event-data.js";
import type {
  CacheStats,
  ContextUsage,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
  SelectionState,
} from "./app-model.js";
import { appendAgentResult } from "./app-submit.js";
import { createSelectionState } from "./app-selection-state.js";
import type { TuiOptions, TuiSubmitPromptResult } from "./types.js";

// applyResult 所需的全部 setter 与兜底上下文；所有状态由调用方持有，本模块不新建 store。
// fallback 用于结果缺省字段（locale/mode/model/loginRequired）时的回落值，保证界面状态不倒退。
// modifiedFileToolCallIds 为已计入统计的工具调用 id 集合，供 app-submit 去重，重置会话时清空。
type TuiApplyResultInput = {
  fallback: {
    // 界面语言兜底；结果未带 locale 时继续沿用。
    locale: NonNullable<TuiOptions["locale"]>;
    // 登录态兜底；结果未显式返回时沿用上一次状态。
    loginRequired: boolean;
    // 协作模式兜底，避免结果缺字段时界面模式被清空。
    mode: CollaborationMode;
    // 模型标识兜底，避免结果缺字段时状态栏模型变为空。
    model: string;
  };
  modifiedFileToolCallIds: Set<string>;
  setActiveTurnId: (turnId: TurnId | undefined) => void;
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>;
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>;
  setEffortOptions: React.Dispatch<React.SetStateAction<NonNullable<TuiOptions["effortOptions"]>>>;
  setLastEvent: (event: string) => void;
  setLiveModelText: (value: string) => void;
  setLocale: (locale: NonNullable<TuiOptions["locale"]>) => void;
  setLoginRequired: (loginRequired: boolean) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setMode: React.Dispatch<React.SetStateAction<CollaborationMode>>;
  setModel: (model: string) => void;
  setModelOptions: React.Dispatch<React.SetStateAction<NonNullable<TuiOptions["modelOptions"]>>>;
  setModifiedFiles: React.Dispatch<React.SetStateAction<ModifiedFileStat[]>>;
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>;
  setQueuedInputs: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
  setStatus: (status: string) => void;
  setThoughtLevel: (thoughtLevel: string) => void;
  setTodos: React.Dispatch<React.SetStateAction<TodoItem[]>>;
  setTraceId: (traceId: string | undefined) => void;
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>;
  // 工作区目录，仅用于把工具结果中的绝对路径转成展示路径；undefined 时保留原路径。
  workspaceDirectory?: string;
};

// 生成“应用一次提交结果”的回调，把 TuiSubmitPromptResult 合并进 TUI 状态。
// 用法：submitValue 拿到结果后调用；preserveTurnState=true 表示只合并消息、不改 turn 级状态
// （例如 busy 期间追加输出），其余情况执行完整的状态推进。
// 副作用：批量 setState；resetSessionProjection 时清空用量/上下文/缓存/待办/网络/修改文件
// 并清空工具调用去重集合；不发起 IO、不写日志。
// 兜底口径：mode/model/locale/loginRequired 缺失时回落到 fallback，绝不被结果覆盖成空值。
// 不变量：preserveTurnState 分支早退，不会清 liveModelText/traceId/turnId，避免打断进行中的 turn。
export function useTuiApplyResult(input: TuiApplyResultInput) {
  return React.useCallback(
    (result: TuiSubmitPromptResult, preserveTurnState = false) => {
      const resultCopy = getZCodeCopy(result.locale ?? input.fallback.locale).tui;
      input.setMode(result.mode ?? input.fallback.mode);
      input.setModel(result.model ?? input.fallback.model);
      if (result.locale) input.setLocale(result.locale);
      if (result.loginRequired !== undefined) input.setLoginRequired(result.loginRequired);
      if (result.effortOptions) input.setEffortOptions(result.effortOptions);
      if (result.modelOptions) input.setModelOptions(result.modelOptions);
      if ("thoughtLevel" in result) input.setThoughtLevel(result.thoughtLevel ?? "");
      input.setMessages((current) =>
        appendAgentResult(current, result, { workspaceDirectory: input.workspaceDirectory }),
      );
      if (preserveTurnState) {
        // 只补充消息内容，立即返回：turn 尚未结束，不能清 live 文本或改写 trace/usage。
        input.setStatus("Agent is still responding.");
        return;
      }
      input.setTraceId(result.traceId);
      input.setLiveModelText("");

      if (result.turnId) input.setActiveTurnId(result.turnId as TurnId);
      if (result.usage) input.setUsage(result.usage);
      if (result.projection) {
        input.setContextUsage((current) => ({
          ...current,
          ...validContextUsage(result.projection ?? {}),
        }));
      }
      if (result.resetSessionProjection) {
        // 会话被重置/分叉后旧投影已失效，必须整体清空，避免旧用量与旧文件统计串到新会话。
        input.setUsage(undefined);
        input.setContextUsage({});
        input.setCacheStats(undefined);
        input.setTodos([]);
        input.setNetworkRequests([]);
        input.setModifiedFiles([]);
        input.modifiedFileToolCallIds.clear();
      }

      input.setSelection(createSelectionState(result.selection));
      // 结果已送达即代表队列已消费；清空排队输入，避免同一输入被重复提交。
      input.setQueuedInputs([]);
      const activeLoginRequired = result.loginRequired ?? input.fallback.loginRequired;
      input.setStatus(
        result.selection
          ? result.selection.prompt
          : activeLoginRequired
            ? resultCopy.loginRequired.status
            : resultCopy.status.ready,
      );
      input.setLastEvent(result.turnId ? `turn ${result.turnId}` : "complete");
    },
    [input],
  );
}
