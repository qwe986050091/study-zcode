// host（services 层）侧的 v4 命令信封构造与 ACK 收口共用件（send/交互回执收敛）。
//
// 与 renderer 的 packages/ui/src/v4/commandFactory.ts 平行：renderer 走浏览器
// localStorage 持久化 clientId；host 进程用进程内稳定 clientId（host 重启 = 新提交端，
// 幂等表以 commandId 为键不受影响）。不合并成一个实现的原因：ui 包不能被 services 反向依赖。
import { randomBytes } from "node:crypto";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  type CommandAck,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";

// 预生成字节到十六进制的查表：uuidv7 高频调用时避免逐字节重复做字符串补齐。
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** uuid v7（RFC 9562）：48-bit Unix ms 时间戳 + 74-bit 随机；与 renderer 工厂同构。 */
export function uuidv7(now: number = Date.now()): string {
  // 先填满 16 字节随机数，再把前 6 字节改写成时间戳；随机位保留，避免同一毫秒内生成相同 uuid。
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  // 从高到低逐字节写入 48-bit 毫秒时间戳，右移量必须对齐网络字节序，否则 uuid 的时间前缀会乱序。
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // 把 version nibble 强制成 7，同时清掉原随机值高 4 位；漏掉掩码会让版本号不是 7，解析方拒绝识别。
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  // variant 位固定为 10xx，与 RFC 9562 一致；不置位会让 uuid 被识别成旧版 variant。
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  let hex = "";
  for (const byte of bytes) hex += HEX[byte];
  // 按 8-4-4-4-12 切开 hex，切点写错会让 commandId 无法被服务端按 uuid 校验。
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** host services 进程稳定 clientId；pendingCommands 展示与幂等表以它区分提交端。 */
// 模块加载时求值一次，进程生命周期内恒定；每次调用重新生成会让 pendingCommands 把同一提交端显示成多台设备。
const hostV4ClientId = `host-services-${uuidv7()}`;

export function getHostV4ClientId(): string {
  return hostV4ClientId;
}

export interface CreateHostCommandEnvelopeInput<T extends CommandType> {
  type: T;
  payload: CommandPayloadMap[T];
  /** createSession 时为 null。 */
  sessionId: string | null;
  /**
   * 幂等键。手机 replayable 的 send_prompt 用 inputId（=traceId）作 commandId：
   * CLI 侧 sendText 以 commandId 为 inputId 起 turn，终态事件的 inputId 才能与
   * host command queue 的 traceId 对账收口（inputId→commandId 对齐）。
   * 缺省生成 uuid v7（stop/resolveInteraction 等一次性命令）。
   */
  commandId?: string;
  /** 手机 replayable 保留原提交端 clientId；缺省用 host 进程稳定 id。 */
  clientId?: string;
  baseRevision?: number;
  baseLogEpoch?: string;
}

/** 构造 host 侧命令信封；CAS 命令缺 baseRevision 就地抛出。 */
export function createHostCommandEnvelope<T extends CommandType>(
  input: CreateHostCommandEnvelopeInput<T>,
): CommandEnvelope {
  // 在构造处就拦住缺少 CAS 基线的命令；若放行到服务端，只会换来一个不可诊断的 rejected ACK。
  if (COMMANDS_REQUIRING_BASE_REVISION.has(input.type) && input.baseRevision === undefined) {
    throw new Error(
      `command ${input.type} 是 CAS 命令，必须携带 baseRevision（10-protocol-spec §6.4）`,
    );
  }
  // row target 命令必须带日志纪元，否则服务端无法判断该行是否已在别的 epoch 被重写。
  if (ROW_TARGETING_COMMANDS.has(input.type) && !input.baseLogEpoch) {
    throw new Error(
      `command ${input.type} 是 row target 命令，必须携带 baseLogEpoch`,
    );
  }
  // 显式构造对象而不展开 input：input 里的 commandId/clientId 可能是 undefined，直接展开会让幂等键变成 undefined。
  return {
    // 缺省才生成新 id；调用方传入 inputId 时必须原样保留，否则终态事件的 inputId 与 traceId 对不上。
    commandId: input.commandId ?? uuidv7(),
    clientId: input.clientId ?? hostV4ClientId,
    sessionId: input.sessionId,
    // 用 !== undefined 而不是真值判断：baseRevision=0 是合法的首轮探测值，真值判断会把它吞掉。
    ...(input.baseRevision !== undefined
      ? { baseRevision: input.baseRevision }
      : {}),
    ...(input.baseLogEpoch ? { baseLogEpoch: input.baseLogEpoch } : {}),
    type: input.type,
    payload: input.payload,
    // issuedAt 取本机墙钟，只用于展示与 ACK 关联；命令先后顺序由 commandId 内的 uuid 时间戳表达。
    issuedAt: Date.now(),
  };
}

/** v4 命令被服务端否决（rejected/stale/failed）。code 供调用方结构化分流，不匹配错误文案。 */
export class ZCodeV4CommandRejectedError extends Error {
  readonly code = "ZCODE_V4_COMMAND_REJECTED";

  constructor(
    readonly commandType: CommandType,
    readonly ack: CommandAck,
    contextMessage: string,
  ) {
    // 消息正文拼成 "类型 状态 (原因码): 消息 — 上下文"，四个片段都可能缺失，因此每一段都必须条件拼接。
    super(
      `v4 command ${commandType} ${ack.status}` +
        `${ack.reasonCode ? ` (${ack.reasonCode})` : ""}` +
        `${ack.message ? `: ${ack.message}` : ""} — ${contextMessage}`,
    );
    // 显式设置 name：经编译或跨 realm 传递后 instanceof 可能失真，调用方还能靠 name 与 code 分流。
    this.name = "ZCodeV4CommandRejectedError";
  }
}

/**
 * ACK 错误映射（旧 op 抛错语义 → v4 六态）：
 * - accepted：正常收口；duplicate：同 commandId 重试回放，幂等成功；
 * - noop：晚到应答/已收口，幂等成功（resolveInteraction 先到先得语义）；
 * - rejected/stale/failed：抛结构化错误，reasonCode 原样携带给调用方。
 */
export function assertV4CommandAckOk(
  commandType: CommandType,
  ack: CommandAck,
  contextMessage: string,
): CommandAck {
  // accepted/duplicate/noop 三种状态都算成功，只有 rejected/stale/failed 才抛错。
  // duplicate 是同 commandId 的重试已落账，noop 是交互已被另一路收口；
  // 两者都不能再触发一次状态推进或重发，否则幂等成功会被放大成重复副作用。
  if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
    return ack;
  }
  throw new ZCodeV4CommandRejectedError(commandType, ack, contextMessage);
}

/**
 * CAS 命令的 host 侧提交（配置写下沉）：host services 没有本地 v4 投影，
 * 拿不到当前 conversation revision——「stale ACK 必带 revisionAtDecision」
 * 用服务端回报的最新 revision 收敛重试，与 renderer 的 dispatchConfigCas 同构
 * （packages/ui/src/v4/SessionPane.tsx）。首发 baseRevision=0 作探测，典型路径一次
 * stale 即命中；每次尝试新 commandId（stale 裁决不进幂等表，语义等价且避免歧义）。
 * 旧 facade 从不带 expectedRevision（无 CAS），这里 stale 仅意味着并发推进而非冲突，
 * 重试即为「无 CAS 提交」语义的保真；连续用尽仅在病态并发下出现，按拒绝抛出。
 */
export async function sendHostCasCommandV4<T extends CommandType>(input: {
  send: (envelope: CommandEnvelope) => Promise<CommandAck>;
  type: T;
  payload: CommandPayloadMap[T];
  sessionId: string;
  contextMessage: string;
  maxAttempts?: number;
}): Promise<CommandAck> {
// 默认最多 4 次：正常情况下一次即可命中，连续 stale 则说明存在病态并发，
// 必须有界退出而不是无限重试。
  // 调用方可覆盖上限；调大到无界会让病态并发下一直重试，把一次配置写变成持续 CAS 风暴。
  const maxAttempts = input.maxAttempts ?? 4;
  // 首发 baseRevision=0 作探测：旧 facade 不带 expectedRevision，必然 stale 一次并换回服务端当前 revision。
  let baseRevision = 0;
  // ACK 是唯一的状态推进依据：本函数返回前不写任何本地投影，
  // 否则 stale/failed 之后本地会领先服务端，下一轮重试的基线也随之失真。
  let lastAck: CommandAck | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ack = await input.send(
      // 每次尝试都新建信封，commandId 随之变化；复用同一个 id 会让 stale 之后的提交落进幂等表被判 duplicate。
      createHostCommandEnvelope({
        type: input.type,
        payload: input.payload,
        sessionId: input.sessionId,
        baseRevision,
      }),
    );
// [事务] stale 裁决必然携带 revisionAtDecision，用它作为下一轮 CAS 基线；
// 这不是冲突信号，只是说明提交期间有并发推进。
    // 只有 stale 继续循环：它是“有并发推进”而非失败，accepted/duplicate/noop 已在下一行直接返回。
    if (ack.status === "stale") {
      lastAck = ack;
// 采用服务端回报的最新 revision，而不是本地自增，避免基线漂移。
      // 直接采用服务端回报的 revision，本地自增会在并发提交下持续落后，永远追不平。
      baseRevision = ack.revisionAtDecision;
      continue;
    }
    return assertV4CommandAckOk(input.type, ack, input.contextMessage);
  }
  throw new ZCodeV4CommandRejectedError(
    input.type,
    // 循环次数耗尽时 lastAck 必然非空（最后一次必为 stale），兜底字面值只为满足类型而存在。
    lastAck ?? {
      commandId: "",
      status: "stale",
      revisionAtDecision: baseRevision,
    },
    // 在上下文后追加放弃原因，调用方日志里能区分“服务端拒绝”与“本地重试耗尽”两种失败。
    `${input.contextMessage}（连续 stale，放弃重试）`,
  );
}
