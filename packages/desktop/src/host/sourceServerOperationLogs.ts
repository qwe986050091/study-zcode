// Source Server 操作日志的 Host 侧唯一历史账本（连接 / 更新 / 身份换代共用）。
//
// 设计要点：日志按「Source 身份」而非「profile」聚合——一旦握手拿到 sourceServerId，
// 后续同一 source 的所有 profile 都读写同一份历史；未拿到身份前按 profile 暂存，
// 拿到后迁移到 source key，从而避免同一台设备出现多条互不相关的日志。
// 并发口径：每次 run 生成单调 sequence 并占位 operations[key]；只有「仍是当前占位」的
// run 才能继续 emit，被判为过期（被新一次连接覆盖）后静默停止写入。
// 失败语义：任务抛错时把 error 归一成 RemoteConnectionError 并补一条 failed 级别日志，
// 再以「保留 instanceof + 可识别码 + 非空脱敏消息」的形式重新抛出。
// 副作用：emit 会回调 context.onLog，并触发 onDidAppend（仅用于让 Renderer 的查询失效）。
// 脱敏：ssh 的密码/口令/私钥路径作为 secrets 传给 sanitizeRemoteConnectionLog，永不落日志。

import { Emitter } from "@zcode/rpc";
import {
  normalizeRemoteConnectionError,
  remoteConnectionFailureLogLevel,
  sanitizeRemoteConnectionLog,
  sourceServerOperationLogSchema,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerOperationLog,
} from "@zcode/shared";
import type { TransportContext } from "@zcode/server/source-server";

type Operation = { sequence: number; logs: SourceServerOperationLog[] };

/** Host 内唯一日志历史；连接/更新共用，Renderer 的订阅仅作为查询失效通知。 */
// 实例形态：now 注入用于可测时间戳；onDidAppend 只发「有新增」事实，不承载查询语义。
// 不变量：operations 的 key 只会是 `source:<id>` 或 `profile:<id>`；同一 source 至多一条记录。
// 失败语义：本类自身不抛错（除 run 会把任务错误归一后重抛）；read/removeProfile/dispose 幂等。
export class SourceServerOperationLogs {
  private sequence = 0;
  private readonly profileKeys = new Map<string, string>();
  private readonly operations = new Map<string, Operation>();
  private readonly emitter = new Emitter<SourceServerOperationLog>();
  readonly onDidAppend = this.emitter.event;

  constructor(private readonly now: () => number) {}

  // 读取某 profile 的日志：有 sourceServerId 直接查 source 维度，否则走 profile 映射。
  // 输出是浅拷贝数组，调用方修改不会污染账本；无记录返回空数组而不是抛错。
  read(
    profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">,
  ): SourceServerOperationLog[] {
    const key = profile.sourceServerId ? `source:${profile.sourceServerId}` : this.profileKeys.get(profile.profileId);
    const operation = key ? this.operations.get(key) : undefined;
    return operation?.logs.map((entry) => ({ ...entry })) ?? [];
  }

  // 删除一个 profile 的映射；只有当没有任何其它 profile 仍指向同一 key 时才删除记录。
  // 这是避免「同一 source 还有别的 profile 在用」时误删共享历史。
  removeProfile(profileId: string): void {
    const key = this.profileKeys.get(profileId);
    this.profileKeys.delete(profileId);
    if (key && ![...this.profileKeys.values()].includes(key)) this.operations.delete(key);
  }

  // 执行一次带日志的连接/更新任务。
  // 输入：operation 类型、profile/target（用于脱敏与身份键）、可选 TransportContext（透传 onLog）、
  //   task 本体（必须返回带 sourceServerId/profileId 的结果，用于把日志迁移到 source 维度）。
  // 输出：task 的原样结果；日志最多保留最近 100 条，进度类条目按 phase 后写覆盖先写。
  // 失败语义：task 抛错时补一条 failure 日志，并把错误归一为带 code/message 的 Error 后重抛。
  // 不变量：emit 只对「仍是 operations[key] 当前占位」的 run 生效，旧 run 的迟到日志全部丢弃；
  //   finally 置 active=false，保证任务结束后任何异步回调都无法再写账本。
  async run<T extends { sourceServerId: string; profileId: string }>(
    operation: SourceServerOperationLog["operation"],
    profile: ConnectionProfile,
    target: RemoteTarget,
    context: TransportContext | undefined,
    task: (context: TransportContext) => Promise<T>,
  ): Promise<T> {
    const current: Operation = { sequence: ++this.sequence, logs: [] };
    let key = profile.sourceServerId ? `source:${profile.sourceServerId}` : `profile:${profile.profileId}`;
    let ownerProfileId = profile.profileId;
    const previous = this.operations.get(key);
    this.profileKeys.set(ownerProfileId, key);
    this.operations.set(key, current);
    const secrets =
      target.kind === "ssh"
        ? [target.password, target.privateKeyPassphrase, target.privateKeyPath].filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    let phase = "probe";
    let active = true;
    const emit = (
      event: { phase: string; message: string; progress?: number },
      level: SourceServerOperationLog["level"] = "info",
    ) => {
      if (!active || this.operations.get(key) !== current) return;
      phase = event.phase;
      const message = sanitizeRemoteConnectionLog(event.message, secrets);
      if (!message) return;
      const entry = sourceServerOperationLogSchema.parse({
        ...event,
        message,
        level,
        profileId: ownerProfileId,
        operation,
        timestamp: this.now(),
      });
      if (entry.progress !== undefined) {
        current.logs = current.logs.filter(
          (previous) => previous.phase !== entry.phase || previous.progress === undefined,
        );
      }
      current.logs = [...current.logs, entry].slice(-100);
      this.emitter.fire(entry);
      context?.onLog?.({ ...event, message, level });
    };
    emit({ phase, message: "Checking the remote device" });
    try {
      const result = await task({ ...context, onLog: (event) => emit(event) });
      const nextKey = `source:${result.sourceServerId}`;
      if (nextKey !== key && this.operations.get(key) === current) {
        // 身份换代生成新 Source/Profile；旧设备只保留换代前自己的历史。
        if (profile.sourceServerId && previous) this.operations.set(key, previous);
        else this.operations.delete(key);
      }
      key = nextKey;
      ownerProfileId = result.profileId;
      this.profileKeys.set(ownerProfileId, key);
      const latest = this.operations.get(key);
      if (!latest || latest.sequence <= current.sequence) this.operations.set(key, current);
      emit({
        phase: "ready",
        message:
          operation === "update" ? "Source Server update completed" : "Remote connection ready",
        progress: 1,
      });
      return result;
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      emit({ phase, message: failure.message }, remoteConnectionFailureLogLevel(failure.code));
      // 保留现有领域 Error 的 instanceof 语义，同时为 RPC 提供可识别的码与非空消息。
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), {
        ...failure,
        message:
          sanitizeRemoteConnectionLog(failure.message, secrets) || "Remote connection failed",
      });
    } finally {
      active = false;
    }
  }

  // 释放：清空映射与记录并销毁 emitter；重复调用无副作用（Map.clear 幂等）。
  // 调用后 onDidAppend 不再触发，已经拿到的订阅者不会再收到事件。
  dispose(): void {
    this.profileKeys.clear();
    this.operations.clear();
    this.emitter.dispose();
  }
}
