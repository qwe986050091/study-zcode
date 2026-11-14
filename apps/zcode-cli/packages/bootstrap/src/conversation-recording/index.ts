import { join } from "node:path";
import { createConversationRecorder } from "@zcode/adapters";
import { resolvePath } from "@zcode/adapters/config";
import type { ConversationRecorder } from "@zcode/adapters";
import type { SessionEventSink } from "@zcode/contracts";
import type {
  ConversationRecordingWiringContract,
  ResolveConversationRecorderInput,
} from "./contract.js";

/**
 * 完整对话记录的装配边界：只负责解析开关/目录并创建 recorder。
 * 写盘布局与失败语义在 adapters 的 createConversationRecorder，行为规格见
 * docs/design/v2/conversation-recording.md。
 *
 * 输入输出口径：
 * - enabled = cliEnabled ?? config.enabled（CLI 显式值优先，未指定才看配置）；
 * - 目录 = cliDir ?? config.dir ?? <cliStorageRoot>/conversation，再经 resolvePath 展开 ~；
 * - 关闭时返回 undefined，调用方据此完全跳过记录链路，不产生空目录。
 */
export function resolveConversationRecorder(
  input: ResolveConversationRecorderInput,
): ConversationRecorder | undefined {
  const enabled = input.cliEnabled ?? input.config.enabled;
  if (!enabled) return undefined;

  const configuredDir =
    input.cliDir ?? input.config.dir ?? join(input.cliStorageRoot, "conversation");
  return createConversationRecorder({
    rootDir: resolvePath(configuredDir),
    ...(input.logger ? { logger: input.logger } : {}),
  });
}

/**
 * 记录 sink 与宿主注入的 sink 必须同时生效，且任一失败不连带另一个。
 * 记录失败已经在 recorder 内部吞掉，这里的隔离只保护宿主 sink 的既有语义。
 *
 * 注意这里是并发（Promise.allSettled）而不是串行：宿主 sink 不应因为写记录而变慢；
 * 只把第一个 rejected 的原因抛回，成功侧的副作用各自已生效。
 */
export function composeConversationEventSink(
  hostSink: SessionEventSink | undefined,
  recorder: ConversationRecorder | undefined,
): SessionEventSink | undefined {
  if (!recorder) return hostSink;
  const recordingSink: SessionEventSink = {
    onSessionEvent: (event) => {
      recorder.recordSessionEvent(event);
    },
  };
  if (!hostSink) return recordingSink;

  return {
    onSessionEvent: async (event) => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => hostSink.onSessionEvent(event)),
        Promise.resolve().then(() => recordingSink.onSessionEvent(event)),
      ]);
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    },
  };
}

/** 对外暴露的装配对象：create-app 只依赖本对象，不直接触达 adapters 的 recorder 实现。 */
export const conversationRecordingWiring: ConversationRecordingWiringContract = {
  composeEventSink: composeConversationEventSink,
  resolveRecorder: resolveConversationRecorder,
};
