import {
  Event,
  type CancellationToken,
  type IChannelServer,
  type IServerChannel,
} from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import {
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  type TopicWireAssemblyFault,
  type TopicWireFrameCandidate,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "../logger/serviceLogger.js";

// [INV] 远端 Core 的唯一 workspace identity 映射 seam：内部 wire/存储用 canonical identity，
// 对外（控制端）用 stable identity；两侧只在此处转换，业务代码不得各自拼接。
// INV-01：register 同时写 stable→canonical 与 canonical→stable；只写单向会让回流事件
//         带着旧身份，控制端会新建一条幽灵 workspace。
// INV-02：复合 topic 只按已登记 grammar 解析后重编码，禁止 substring replace，
//         否则用户文本/路径中的同名片段会被误改（守住位置：mapIdentityString）。
// INV-03：非 plain record（Uint8Array/ArrayBuffer/Date）原样透传，不得展开为普通对象。
// INV-04：分片帧必须先有界重组→映射→按对外 envelope 重新分片，顺序颠倒会透出 canonical。
const log = createServiceLogger("source-server-workspace-identity");

export interface SourceServerWorkspaceIdentityMapping {
  stableIdentity: string;
  canonicalIdentity: string;
}

// [边界] 只认原型为 Object.prototype 或 null 的对象：class 实例/Map 各有内部槽，
// 按 record 递归会丢方法与非枚举状态，回程时无法还原成同一语义的值。
function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

// [失败路径] 未命中映射返回原值而非抛错：未登记的身份仍需透传，
// 抛错会让一条未知 workspace 拖垮整条 topic 通道。
function mapIdentityString(value: string, mappings: ReadonlyMap<string, string>): string {
  const exact = mappings.get(value);
  if (exact) return exact;

  // Bug 原因：V4 workspace topic 把 identity 编码进复合字符串，旧的整串查表无法命中，
  // 导致 stable 订阅收到 canonical topic 后在 ACK barrier 被静默丢弃。这里只解析已登记的
  // 协议 grammar，禁止通用 substring replace 误改用户文本、路径或日志。
  const sessionsWorkspaceIdentity = parseSessionsIndexTopic(value);
  if (sessionsWorkspaceIdentity) {
    const mapped = mappings.get(sessionsWorkspaceIdentity);
    if (mapped) return sessionsIndexTopic(mapped);
  }
  const configWorkspaceIdentity = parseWorkspaceConfigTopic(value);
  if (configWorkspaceIdentity) {
    const mapped = mappings.get(configWorkspaceIdentity);
    if (mapped) return workspaceConfigTopic(mapped);
  }
  return value;
}

// [递归] 深度遍历覆盖数组与 plain record，但不进入内建对象；
// 返回新结构而非就地改写，避免上游复用的参数对象被本层改掉。
function mapValue(value: unknown, mappings: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return mapIdentityString(value, mappings);
  if (Array.isArray(value)) return value.map((item) => mapValue(item, mappings));
  if (!value || typeof value !== "object") return value;
  // Bug 原因：Host 旧 mapper 对任意 object 执行 Object.entries，顶层 Uint8Array 会退化成
  // 数字键对象，普通 Date/ArrayBuffer 也会丢失运行时语义。Core seam 只遍历 plain record。
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    !isPlainRecord(value)
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mapValue(item, mappings)]),
  );
}

// [校验] 仅做结构判别（kind/topic/subscriptionId/logicalFrameId/ordinal），不解析 payload：
// 目的是区分分片 envelope 与普通业务事件，真正的 schema 校验交给 assembler。
function isTopicWireCandidate(value: unknown): value is TopicWireFrameCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === "complete" || candidate.kind === "fragment") &&
    typeof candidate.topic === "string" &&
    typeof candidate.subscriptionId === "string" &&
    typeof candidate.logicalFrameId === "string" &&
    typeof candidate.logicalFrameOrdinal === "number"
  );
}

/**
 * Source Server 内部 CLI wire 使用 canonical storage identity；对外 wire 使用 stable identity。
 * logical frame 一旦已分片，必须先有界重组、映射 logical value，再按对外 envelope 重新分片。
 */
// [时序] 每个订阅新建一个 assembler：分片状态属于单条事件流，跨订阅复用会让
// 不同 topic 的片段互相串帧，重组出错误的 logical frame。
function mapTopicWireEvent(
  event: Event<unknown>,
  mapper: SourceServerWorkspaceIdentityMapper,
  createAssembler: () => TopicWireFrameAssembler<unknown>,
): Event<unknown> {
  return (listener) => {
    const assembler = createAssembler();
// [失败路径] fault 以 complete envelope 下发而不是丢弃：控制端据 reasonCode 启动既有 resync，
// 缺这一帧会让订阅端停在旧快照且无法自愈。
    const emitFault = (fault: TopicWireAssemblyFault): void => {
      // Bug 原因：旧实现把 fault 对应的原始 fragment 直接透传，base64 内仍包含 canonical
      // identity；跨 route expire 还会把同批已完成帧一起丢掉。candidate boundary 允许缺失
      // inner frame，由控制端 owned assembler 产生 typed fault 并启动既有 resync。
      listener(
        mapper.mapOutgoing({
          wireVersion: V4_WIRE_PROTOCOL_VERSION,
          kind: "complete",
          ...(fault.deliveryKind ? { deliveryKind: fault.deliveryKind } : {}),
          logicalFrameId: fault.logicalFrameId,
          logicalFrameOrdinal: fault.logicalFrameOrdinal,
          topic: fault.topic,
          subscriptionId: fault.subscriptionId,
        }),
      );
    };
// [资源] assembler 与本次 listen 返回的 Event 同生命周期，断开订阅后随闭包回收，
// 不跨调用共享，因此无需显式清理。
    return event((value) => {
      if (!isTopicWireCandidate(value)) {
        listener(mapper.mapOutgoing(value));
        return;
      }
// [并发] accept 是同步的，且必须在本条 listener 调用内完成；之后不得 await，
// 否则同一事件流的帧序会被其他回调穿插，重组出错误顺序。
      const assembled = assembler.accept(value);
      for (const item of assembled) {
// [失败路径] fault 与 complete 可能同批返回：先发 fault 再处理后续 complete，
// 保证控制端先得知需要 resync，不会把过期帧当成有效数据。
        if (item.kind === "fault") {
          emitFault(item.fault);
          continue;
        }
        if (item.kind !== "complete") continue;
        const frame = mapper.mapOutgoing(item.frame) as {
          topic: string;
          subscriptionId: string;
        };
        try {
// [权衡] 映射后必须重新分片：canonical 与 stable identity 长度不同，沿用原始分片边界
// 可能超出单帧通知上限；logicalFrameId/ordinal 仍沿用输入，保证控制端可对齐原帧。
          const wires = encodeTopicWireFrames(frame, {
            deliveryKind: item.deliveryKind,
            topic: frame.topic,
            subscriptionId: frame.subscriptionId,
            logicalFrameId: value.logicalFrameId,
            logicalFrameOrdinal: value.logicalFrameOrdinal,
            measurePhysicalFrameBytes: (wire) =>
              measureTopicNotificationEnvelopeBytes(wire).maxBytes,
          });
// [时序] 逐帧按序下发，顺序与 encode 输出一致；listener 抛错会中断剩余帧，
// 由外层捕获并归为映射失败，不会静默丢帧。
          for (const wire of wires) listener(wire);
        } catch (error) {
          // Bug 原因：encode 异常从 Emitter listener 冒泡后会被 stdio transport 当成
          // protocol_parse_error，连带撕掉整个 CLI runtime。映射 seam 只让当前 topic resync。
// [失败路径] 只记录长度与 id，不打印 topic 原文：topic 含 workspace identity，
// 落盘会绕过身份隔离；此处降级为 warn，避免异常冒泡撕掉整个 CLI runtime。
          log.warn("failed to encode mapped topic frame", {
            topicLength: frame.topic.length,
            subscriptionId: frame.subscriptionId,
            error: error instanceof Error ? error.message : String(error),
          });
// [失败路径] 编码失败只让当前 topic resync：单条 topic 的映射异常不应升级为
// protocol_parse_error，否则整条 stdio 连接会被上层重建。
          emitFault({
            deliveryKind: item.deliveryKind,
            reasonCode: "proto.frameMappingEncodingFailed",
            logicalFrameId: value.logicalFrameId,
            logicalFrameOrdinal: value.logicalFrameOrdinal,
            topic: frame.topic,
            subscriptionId: frame.subscriptionId,
          });
        }
      }
    });
  };
}

// [状态] 两张表是同一事实的两个方向，register 必须成对写入；workspace 生命周期内
// identity 不变，只增不删，因此不需要锁或失效逻辑。
export class SourceServerWorkspaceIdentityMapper {
  private readonly stableToCanonical = new Map<string, string>();
  private readonly canonicalToStable = new Map<string, string>();

  public register(mapping: SourceServerWorkspaceIdentityMapping): void {
// [并发] Map.set 单次调用原子，但两次写之间存在半映射窗口；调用方保证 register
// 在订阅建立前完成，读者不会在窗口内读到缺失的反向映射。
    this.stableToCanonical.set(mapping.stableIdentity, mapping.canonicalIdentity);
    this.canonicalToStable.set(mapping.canonicalIdentity, mapping.stableIdentity);
  }

// [泛型] 返回值按输入断言为 T：映射只改字符串内容、不改结构，T 的形状不变；
// 该断言是本 seam 的核心契约，将来若引入删键/改名必须收紧类型。
  public mapIncoming<T>(value: T): T {
    return mapValue(value, this.stableToCanonical) as T;
  }

  public mapOutgoing<T>(value: T): T {
    return mapValue(value, this.canonicalToStable) as T;
  }
}

// [装饰] 每个业务 channel 包一层：入参走 stable→canonical，返回值走 canonical→stable，
// 保证远端实现只观察 canonical storage key。
class SourceServerWorkspaceIdentityServerChannel<TContext> implements IServerChannel<TContext> {
  public constructor(
    private readonly inner: IServerChannel<TContext>,
    private readonly mapper: SourceServerWorkspaceIdentityMapper,
  ) {}

  public async call<T>(
    context: TContext,
    command: string,
    args?: unknown,
    cancellationToken?: CancellationToken,
  ): Promise<T> {
// [时序] 参数映射必须在 await 之前完成，结果映射必须在 await 之后：
// 顺序颠倒会把 canonical 参数发给远端实现，或把 stable 结果回给控制端。
    const result = await this.inner.call<T>(
      context,
      command,
      this.mapper.mapIncoming(args),
      cancellationToken,
    );
    return this.mapper.mapOutgoing(result);
  }

// [分支] listen 的映射取决于事件形态：三个 dynamic topic 需要重组/重分片，
// 其余事件只做一次值映射，避免为普通事件承担 assembler 开销。
  public listen<T>(context: TContext, event: string, arg?: unknown): Event<T> {
    const innerEvent = this.inner.listen<unknown>(context, event, this.mapper.mapIncoming(arg));
// [字段映射] 三个 topic 各自绑定 schema（conversation/sessionsIndex/workspaceConfig），
// 用错 schema 会在 accept 阶段产生 fault，表现为持续 resync 而不是显式报错。
    if (event === "onDynamicConversationFrame") {
      return mapTopicWireEvent(
        innerEvent,
        this.mapper,
        () => new TopicWireFrameAssembler(conversationTopicFrameSchema),
      ) as Event<T>;
    }
    if (event === "onDynamicSessionsIndexFrame") {
      return mapTopicWireEvent(
        innerEvent,
        this.mapper,
        () => new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema),
      ) as Event<T>;
    }
    if (event === "onDynamicWorkspaceConfigFrame") {
      return mapTopicWireEvent(
        innerEvent,
        this.mapper,
        () => new TopicWireFrameAssembler(workspaceConfigTopicFrameSchema),
      ) as Event<T>;
    }
    return Event.map(innerEvent, (value) => this.mapper.mapOutgoing(value)) as Event<T>;
  }
}

/**
 * 远端 Core 唯一 workspace identity 映射 seam。
 *
 * source-server-workspace channel 返回真实 canonical key 供迁移诊断；其它业务 channel
 * 只观察控制端 stable identity，远端实现只观察 canonical storage key。
 */
export class SourceServerWorkspaceIdentityChannelServer<
  TContext = string,
> implements IChannelServer<TContext> {
  public constructor(
    private readonly inner: IChannelServer<TContext>,
    private readonly mapper: SourceServerWorkspaceIdentityMapper,
  ) {}

// [不变量] SourceServerWorkspace 自身不包映射：它对外暴露 canonical key 供迁移诊断，
// 包上映射会让诊断看到 stable identity，失去真实存储 key 这一信息。
  public registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.inner.registerChannel(
      channelName,
      channelName === ServiceChannels.SourceServerWorkspace
        ? channel
        : new SourceServerWorkspaceIdentityServerChannel(channel, this.mapper),
    );
  }

  public ready(): void {
    this.inner.ready?.();
  }
}
