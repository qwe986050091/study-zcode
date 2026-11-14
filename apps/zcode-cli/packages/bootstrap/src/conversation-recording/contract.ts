import type { ConversationRecorder } from "@zcode/adapters";
import type { ConversationRecordingConfig, Logger, SessionEventSink } from "@zcode/contracts";

/**
 * 完整对话记录在 App 装配层的契约：只解析开关与输出目录，不做文件 I/O。
 * 具体落盘与原始请求捕获在 @zcode/adapters 的 conversation-recording 模块。
 */
/**
 * 解析 recorder 的输入：CLI 参数、配置文件与存储根三路合并，本身不做任何磁盘 I/O。
 * 优先级固定为「CLI 显式值 > 配置值 > 存储根缺省」，装配层只做选择不做写入。
 */
export interface ResolveConversationRecorderInput {
  /** CLI 显式开关；undefined 表示未指定，此时由 config.enabled 决定。 */
  cliEnabled?: boolean;
  /** CLI 显式输出目录；优先于 config.dir，避免配置文件覆盖一次性的 --dir。 */
  cliDir?: string;
  /** 配置文件里的对话记录开关与目录；仅在 CLI 未显式给出时生效。 */
  config: ConversationRecordingConfig;
  /** CLI 存储根，只用于拼缺省输出目录（conversation 子目录），不参与启用判定。 */
  cliStorageRoot: string;
  /** 透传给 adapters 的记录器日志；缺席时由 adapters 走默认日志。 */
  logger?: Logger;
}

/**
 * 装配层唯一暴露的两个动作：解析 recorder 与组合事件 sink。
 * 记录失败在 adapters 内部消化，这里只保证宿主 sink 的既有语义不被记录链路改变。
 */
export interface ConversationRecordingWiringContract {
  /** 未启用时返回 undefined；CLI 开关优先于配置。 */
  resolveRecorder(input: ResolveConversationRecorderInput): ConversationRecorder | undefined;
  /** 记录 sink 与宿主 sink 同时生效；任一失败不连带另一个。 */
  composeEventSink(
    hostSink: SessionEventSink | undefined,
    recorder: ConversationRecorder | undefined,
  ): SessionEventSink | undefined;
}
