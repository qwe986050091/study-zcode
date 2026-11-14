// INV-01 每个回调先验代际：守住位置 代际早退；改错故障 过期响应覆盖新选择。
// INV-02 缓存只写会话持有的引用：守住位置 缓存引用；改错故障 出现第二份预检事实。
// INV-03 指纹按请求当时行计算：守住位置 行快照入参；改错故障 指纹与载荷内容不符。
// INV-04 工作区键优先身份：守住位置 空值合并；改错故障 同路径不同身份串缓存。
// INV-05 远端会话缺省为空串：守住位置 空值兜底；改错故障 指纹出现未定义字样。
// INV-06 条目构建交给工具函数：守住位置 降级逻辑收敛；改错故障 老宿主结果直接报错。
// INV-07 元信息随成功响应更新：守住位置 赋值位置；改错故障 下次预检命中旧代际。
// INV-08 元信息保留产物类型：守住位置 字段完整；改错故障 分享面板丢失可选类型。
// INV-09 成功后才通知更新：守住位置 回调顺序；改错故障 界面读到半写缓存。
// INV-10 先写条目再写元信息：守住位置 语句顺序；改错故障 指纹与条目代际错配。
// INV-11 失败分支记录诊断：守住位置 日志调用；改错故障 预检失败无迹可查。
// INV-12 失败后仍验代际：守住位置 记录后早退；改错故障 过期失败覆盖当前状态。
// INV-13 问题缺失兜底为未知：守住位置 空数组判断；改错故障 失败卡片没有可展示原因。
// INV-14 兜底问题作用域为传输：守住位置 固定字面量；改错故障 传输错误被归到单轮。
// INV-15 阻断问题覆盖全部缺轮：守住位置 循环写入；改错故障 部分轮次停在检查中。
// INV-16 失败改用选中指纹：守住位置 映射查找；改错故障 重试判断误判为已是最新。
// INV-17 处理异常同样结束检查：守住位置 统一写入；改错故障 界面永远停在转圈。
// INV-18 异常日志放在更新之后：守住位置 语句顺序；改错故障 记录失败阻断界面复位。
//
// 模块职责：把会话分享预检的三个生命周期回调接到会话缓存。
// 状态所有权：缓存与元信息由调用方持有，处理器只负责写入。
// 阅读顺序：先看工厂签名，再看成功写入，最后看失败与异常两条分支。
import type {
  ConversationSharePreflightResult,
  ConversationShareTurnPreflightResult,
} from "@/conversation-share-interaction/contract.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import {
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
} from "@/lib/conversationShareError.js";
import {
  buildConversationSharePreflightCacheEntries,
  conversationShareTurnFingerprint,
} from "@/v4/conversationSharePreflightCache.js";

type PreflightMeta = Pick<
  ConversationSharePreflightResult,
  "revision" | "logEpoch" | "capabilitiesFingerprint" | "supportedArtifactTypes"
>;

/** 响应只提交到 SessionPane 持有的缓存；请求代际仍由 scheduler 和 isCurrent 共同约束。 */
// createConversationSharePreflightResponseHandlers 绑定单次会话的 sharePreflightCacheRef。
// 三个回调共用同一个 isCurrent 代际判断。
// 返回值固定为 onResolved、onRejected、onError 三个回调。
export function createConversationSharePreflightResponseHandlers({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  missingProductTurnIds,
  requestRows,
  selectedShareTurnFingerprints,
  sharePreflightCacheRef,
  sharePreflightMetaRef,
  sharePreflightCacheKey,
  isCurrent,
  onUpdated,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  missingProductTurnIds: readonly string[];
  requestRows: readonly ConversationRow[];
  selectedShareTurnFingerprints: ReadonlyMap<string, string>;
  sharePreflightCacheRef: {
    current: Map<string, ConversationShareTurnPreflightResult>;
  };
  sharePreflightMetaRef: { current: PreflightMeta };
  sharePreflightCacheKey: (productTurnId: string) => string;
  isCurrent: () => boolean;
  onUpdated: () => void;
}): {
  onResolved: (result: ConversationSharePreflightResult) => void;
  onRejected: (error: unknown) => void;
  onError: (error: unknown) => void;
} {
  // onResolved 进来先调 isCurrent()，过期请求直接 return。
  // onRejected 与 onError 同样先验 isCurrent()。
  // resolved 先写缓存再 onUpdated，回调顺序决定界面状态。
  return {
    // 指纹用 requestRows 与 result.revision 等请求当时的行计算。
    // 条目构建交给 buildConversationSharePreflightCacheEntries 处理。
    // entries 先写入 sharePreflightCacheRef，再更新 sharePreflightMetaRef。
    onResolved: (result) => {
      if (!isCurrent()) return;
      // Bug 根因：dev 下 host 进程不随 services 重建重启，老 host 返回的结果没有
      // turnResults，直接 .map 会抛异常并被下游 catch 报成「服务端预检失败」。
      // 拆条目的降级逻辑收敛在 helper 里，见 conversationSharePreflightCache。
      const resultTurnFingerprints = new Map(
        missingProductTurnIds.map((productTurnId) => [
          productTurnId,
          conversationShareTurnFingerprint(requestRows, productTurnId, workspacePath, {
            workspaceKey: workspaceIdentity?.trim() || workspacePath,
            remoteSessionId: remoteSessionId ?? "",
            sessionId,
            revision: result.revision,
            logEpoch: result.logEpoch,
            capabilitiesFingerprint: result.capabilitiesFingerprint,
          }),
        ]),
      );
      const entries = buildConversationSharePreflightCacheEntries(
        result,
        missingProductTurnIds,
        resultTurnFingerprints,
      );
      // 条目构建失败时保持旧元信息，否则错误终态的 fingerprint 会立即失效。
      sharePreflightMetaRef.current = {
        revision: result.revision,
        logEpoch: result.logEpoch,
        capabilitiesFingerprint: result.capabilitiesFingerprint,
        supportedArtifactTypes: result.supportedArtifactTypes,
      };
      for (const entry of entries) {
        sharePreflightCacheRef.current.set(sharePreflightCacheKey(entry.productTurnId), entry);
      }
      onUpdated();
    },
    // onRejected 记录 logger.warn 诊断后直接返回，不改缓存。
    // issues 缺失时 resolveConversationShareFallbackIssueCode 兜底为 unknown。
    // 阻断问题覆盖全部 missingProductTurnIds，逐条写入 issues。
    onRejected: (error: unknown) => {
      // 只有 RPC / 服务端真实失败才走这里；成功回调里的渲染层异常由末尾 catch 兜住，
      // 分别记录诊断日志。issues 缺失时兜底成 unknown，并允许重新检查。
      const details = getConversationShareErrorDetails(error);
      logger.warn("[v4-share] 会话分享预检失败", {
        sessionId,
        turnCount: missingProductTurnIds.length,
        name: details.name,
        kind: details.kind,
        reasonCode: details.reasonCode,
        issueCount: details.issueCount ?? 0,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!isCurrent()) return;
      const issues =
        details.issues && details.issues.length > 0
          ? details.issues
          : [
              {
                code: resolveConversationShareFallbackIssueCode(details),
                scope: "transport" as const,
              },
            ];
      for (const productTurnId of missingProductTurnIds) {
        sharePreflightCacheRef.current.set(sharePreflightCacheKey(productTurnId), {
          productTurnId,
          turnFingerprint: selectedShareTurnFingerprints.get(productTurnId),
          blockingIssues: issues,
          skippableWarnings: [],
          deferredIssues: [],
        });
      }
      onUpdated();
    },
    onError: (error: unknown) => {
      if (!isCurrent()) return;
      // 处理异常也必须结束 checking；保留当前指纹，让现有问题入口提供重试。
      for (const productTurnId of missingProductTurnIds) {
        sharePreflightCacheRef.current.set(sharePreflightCacheKey(productTurnId), {
          productTurnId,
          turnFingerprint: selectedShareTurnFingerprints.get(productTurnId),
          blockingIssues: [{ code: "unknown", scope: "transport" }],
          skippableWarnings: [],
          deferredIssues: [],
        });
      }
      onUpdated();
      logger.error("[v4-share] 会话分享预检结果处理异常", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
  };
}
