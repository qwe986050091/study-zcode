// INV-01 只有末条且已收尾才建卡：守住位置 canBuildCards；改错故障 流式中的半句被当成预览。
// INV-02 轮次文本去空行后拼接：守住位置 joinAssistantTurnText；改错故障 空行产生空段落卡片。
// INV-03 键含行号与实体号：守住位置 requestKey；改错故障 换行后命中上一条的变更结果。
// INV-04 键含状态：守住位置 requestKey；改错故障 同一行的不同状态复用旧结果。
// INV-05 回包按 key 校验后才用：守住位置 changedFilePaths；改错故障 迟到回包覆盖新一轮。
// INV-06 失效后丢弃回包：守住位置 disposed；改错故障 卸载后仍写状态。
// INV-07 失败按空集处理：守住位置 错误分支；改错故障 读变更失败时整块卡片消失。
// INV-08 失败只记警告：守住位置 日志级别；改错故障 一次读失败刷出成片错误。
// INV-09 回退态不请求：守住位置 reverted 早退；改错故障 回退后又覆盖回变更内容。
// INV-10 无 md/html 不请求：守住位置 needsFileChanges；改错故障 纯文本轮次也打明细接口。
// INV-11 远程精简抑制 html：守住位置 条件；改错故障 远程端渲染重预览。
// INV-12 目标对象按字段记忆：守住位置 useMemo 依赖；改错故障 每次渲染重发请求。
// INV-13 无目标不发请求：守住位置 早退；改错故障 用空目标调用接口。
// INV-14 空集用共享常量：守住位置 回退值；改错故障 每次渲染产生新空数组导致重算。
// INV-15 卡片构建整体记忆：守住位置 末尾 useMemo；改错故障 每帧重建卡片数组。
// INV-16 依赖逐项列出：守住位置 依赖数组；改错故障 遗漏项导致卡片不更新。
// INV-17 缓存策略固定：守住位置 请求参数；改错故障 同一轮次反复回源。
// INV-18 引用提取可传主目录：守住位置 参数；改错故障 家目录相对路径无法解析。
//
// 模块职责：为助手文本行派生预览卡片，并按需读取本轮文件变更。
// 状态所有权：变更路径缓存归本 hook；卡片本身由记忆化派生。
// 阅读顺序：先看前置条件，再看请求键与副作用，最后看卡片构建。
import { useEffect, useMemo, useState } from "react";
import type {
  AssistantTextRow,
  ConversationRowTarget,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantPreviewCardsFromReferences,
  extractAssistantFileReferences,
  type AssistantPreviewCard,
} from "@/lib/assistantPreviewCards.js";
import { logger } from "@/logger.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationFileChangesState,
} from "@/v4/conversationRowContext.js";

interface UseAssistantPreviewCardsForAssistantTextRowParams {
  row?: AssistantTextRow;
  assistantTextRows: readonly AssistantTextRow[];
  latestAssistantTextRow?: AssistantTextRow;
  workspacePath: string;
  workspaceHomePath?: string;
  compactForRemoteControl?: boolean;
  fileChangesTarget: ConversationRowTarget | null;
  fileChangesState?: ConversationFileChangesState;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
}

interface LoadedChangedPaths {
  key: string;
  paths: readonly string[];
}

const EMPTY_CHANGED_FILE_PATHS: readonly string[] = [];

// joinAssistantTurnText 逐行取 row.text。
// text.trim 为空的行不参与拼接。
// join("\n\n") 在段落之间保留双换行。
// 结果供 extractAssistantFileReferences 复用。
// 只 map 出字符串，不修改 assistantTextRows 入参。
function joinAssistantTurnText(rows: readonly AssistantTextRow[]): string {
  return rows
    .map((row) => row.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

export function useAssistantPreviewCardsForAssistantTextRow({
  row,
  assistantTextRows,
  latestAssistantTextRow,
  workspacePath,
  workspaceHomePath,
  compactForRemoteControl,
  fileChangesTarget,
  fileChangesState,
  fetchFileChanges,
// canBuildCards 只有末条且状态已结束才为真。
// turnText 用 useMemo 按 assistantTextRows 记忆。
// fileReferences 的提取依赖 workspacePath 与 workspaceHomePath。
// needsFileChanges 由 kind 为 markdown/html 的引用决定。
// target 只保留 rowId 与 entityId 两个标识。
}: UseAssistantPreviewCardsForAssistantTextRowParams): AssistantPreviewCard[] {
  const turnText = useMemo(() => joinAssistantTurnText(assistantTextRows), [assistantTextRows]);
  const canBuildCards =
    row !== undefined &&
    latestAssistantTextRow?.rowId === row.rowId &&
    (row.state === "complete" || row.state === "interrupted");
  const fileReferences = useMemo(
    () =>
      canBuildCards
        ? extractAssistantFileReferences(turnText, workspacePath, {
            homePath: workspaceHomePath,
          })
        : [],
    [canBuildCards, turnText, workspaceHomePath, workspacePath],
  );
  const needsFileChanges = fileReferences.some(
    (reference) =>
      reference.kind === "markdown" ||
      (reference.kind === "html" && compactForRemoteControl !== true),
  );
  const target = useMemo<ConversationRowTarget | null>(
    () =>
      fileChangesTarget
        ? {
            rowId: fileChangesTarget.rowId,
            entityId: fileChangesTarget.entityId,
          }
        : null,
    [fileChangesTarget?.entityId, fileChangesTarget?.rowId],
  );
  const requestKey = target
    ? `${target.rowId}:${target.entityId}:${fileChangesState ?? "unknown"}`
    : "";
  const [loadedChangedPaths, setLoadedChangedPaths] = useState<LoadedChangedPaths | null>(null);

  // needsFileChanges、fetchFileChanges 或 target 缺一即退出。
  // fileChangesState 为 reverted 时跳过请求。
  // disposed 标志阻止卸载后的 setLoadedChangedPaths。
  // 成功与失败都以 requestKey 写入 loadedChangedPaths。
  useEffect(() => {
    if (!needsFileChanges || !fetchFileChanges || !target) return;
    // rewind 后 header 的 reverted 状态是权威投影；无需等待详情 RPC，立即抑制 md/html。
    if (fileChangesState === "reverted") return;

    let disposed = false;
    // V4 fileChanges 只接受 turnHeader；assistantText 仅用于正文和卡片锚点。
    // 先用空门控同步投影 Office/PDF；只有确实出现 md/html 时才读取本轮明细。
    void fetchFileChanges(target, {
      cachePolicy: "terminal",
      fileChangesState,
    }).then(
      (result) => {
        if (disposed) return;
        setLoadedChangedPaths({
          key: requestKey,
          paths: result.state === "reverted" ? [] : result.items.map((item) => item.path),
        });
      },
      (error: unknown) => {
        if (disposed) return;
        logger.warn("[AssistantPreviewCards] 读取本轮文件变更失败，已抑制 Markdown/HTML 卡片", {
          error: error instanceof Error ? error.message : String(error),
          rowId: target.rowId,
        });
        setLoadedChangedPaths({ key: requestKey, paths: [] });
      },
    );

    return () => {
      disposed = true;
    };
  }, [fetchFileChanges, fileChangesState, needsFileChanges, requestKey, target]);

  // loadedChangedPaths.key 与 requestKey 不符时视为空集。
  // EMPTY_CHANGED_FILE_PATHS 保证引用稳定。
  // changedFilePaths 随后传给卡片构建。
  // compactForRemoteControl 单独透传，不并入 requestKey。
  const changedFilePaths =
    needsFileChanges && loadedChangedPaths?.key === requestKey
      ? loadedChangedPaths.paths
      : EMPTY_CHANGED_FILE_PATHS;

  return useMemo(
    () =>
      canBuildCards
        ? buildAssistantPreviewCardsFromReferences(turnText, workspacePath, fileReferences, {
            changedFilePaths,
            homePath: workspaceHomePath,
            suppressWebRemoteCards: compactForRemoteControl === true,
          })
        : [],
    [
      canBuildCards,
      changedFilePaths,
      compactForRemoteControl,
      fileReferences,
      turnText,
      workspaceHomePath,
      workspacePath,
    ],
  );
}
