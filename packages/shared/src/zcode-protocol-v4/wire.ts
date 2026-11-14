// INV-01 完整帧与分片帧按种类判别：守住位置 判别字段；改错故障 两类帧被混读。
// INV-02 帧序号必须正整数：守住位置 数值约束；改错故障 零或负数帧被接受。
// INV-03 帧序号不超安全整数：守住位置 上限约束；改错故障 大整数精度丢失导致乱序。
// INV-04 分片下标非负：守住位置 数值约束；改错故障 负下标写入分片表越界。
// INV-05 分片数不超过装配上限：守住位置 上限常量；改错故障 构造海量分片拖垮组装。
// INV-06 分片下标小于分片数：守住位置 精化判断；改错故障 尾片永不写入组装完成。
// INV-07 分片数不超过总字节：守住位置 精化判断；改错故障 每片不足一字节的谬误帧通过。
// INV-08 校验和固定八位小写十六进制：守住位置 正则约束；改错故障 大小写混杂校验失败。
// INV-09 校验算法只认一种：守住位置 字面量；改错故障 未实现算法被当成有效。
// INV-10 正文使用专用编码模式：守住位置 复用模式；改错故障 非法字符进入解码器。
// INV-11 完整帧主题与内层一致：守住位置 精化比较；改错故障 帧被路由到错误主题。
// INV-12 完整帧订阅标识与内层一致：守住位置 精化比较；改错故障 结果送到别的订阅者。
// INV-13 候选帧只校验可路由外层：守住位置 未知字段；改错故障 坏载荷在边界被静默丢弃。
// INV-14 候选帧保留未知字段：守住位置 透传模式；改错故障 后续装配阶段拿不到原字段。
// INV-15 投递类别只读声明不推断：守住位置 枚举字段；改错故障 消费端按调用时序猜错来源。
// INV-16 内层载荷延迟到装配校验：守住位置 未知类型；改错故障 早期丢弃让状态永久加载。
// INV-17 协议版本固定字面量：守住位置 版本常量；改错故障 跨版本帧被误判为兼容。
// INV-18 本模块只做形状校验：守住位置 纯函数边界；改错故障 编解码副作用混入模式。
//
// 模块职责：V4 物理帧的模式与跨字段一致性校验。
// 状态所有权：无状态；校验全部在纯函数中完成。
// 阅读顺序：先看帧联合类型，再看候选形状，最后看完整校验器。
// V4 physical wire schema：logical topic frame 保持原子 seq 语义，超大帧只在
// UTF-8 byte 层分片。codec/reassembly 纯函数见 wire-codec.ts。
import { z } from "zod";
import { PROTOCOL_V4_LIMITS, V4_WIRE_PROTOCOL_VERSION } from "./core.js";
import { topicWireBase64Schema } from "./wire-binary.js";

export const topicWireChecksumSchema = z
  .object({
    algorithm: z.literal("crc32"),
    value: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict();
export type TopicWireChecksum = z.infer<typeof topicWireChecksumSchema>;

/** publisher reservation 对物理帧用途的权威标记；consumer 禁止按 RPC 时序猜测。 */
export const topicFrameDeliveryKindSchema = z.enum(["initial", "online", "recovery"]);
export type TopicFrameDeliveryKind = z.infer<typeof topicFrameDeliveryKindSchema>;

// complete 帧在 frame 字段内携带内层载荷。
// fragment 帧额外带 fragmentIndex、fragmentCount 与 logicalBytes。
// 两类帧共享 wireVersion、topic、subscriptionId 等路由字段。
// deliveryKind 只读发布方声明，消费端不得按 RPC 时序推断。
export type TopicWireFrame<F> =
  | {
      wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
      kind: "complete";
      deliveryKind: TopicFrameDeliveryKind;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      frame: F;
    }
  | {
      wireVersion: typeof V4_WIRE_PROTOCOL_VERSION;
      kind: "fragment";
      deliveryKind: TopicFrameDeliveryKind;
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      fragmentIndex: number;
      fragmentCount: number;
      logicalBytes: number;
      checksum: TopicWireChecksum;
      dataBase64: string;
    };

/**
 * service 边界只验证可安全路由/计量的 outer 形状；range/base64/checksum/logical
 * payload 的完整校验必须在 ownership 过滤后的 assembler 中产生 typed fault。
 */
// candidate schema 只校验 wireVersion、kind、topic、subscriptionId 等可路由字段。
// .passthrough() 保留未知字段，装配阶段仍能拿到原始载荷。
// 坏 deliveryKind 不在 service 边界报错，留给 assembler 转 typed fault。
// 边界不 warn/drop，避免 store 永久停在 loading。
export const topicWireFrameCandidateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
      kind: z.literal("complete"),
      // ownership 路由只读 topic/subId；坏 deliveryKind 必须进入 owned assembler
      // 产生 typed fault，不能在 service 边界 warn/drop 后让 store 永久等待。
      deliveryKind: z.unknown().optional(),
      logicalFrameId: z.string().min(1),
      logicalFrameOrdinal: z.number(),
      topic: z.string().min(1),
      subscriptionId: z.string().min(1),
      // inner payload 故意不在 service route boundary 校验；缺失/类型/extra 由
      // ownership 后 assembler 统一转 typed fault，避免早期 warn/drop 永久 loading。
      frame: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
      kind: z.literal("fragment"),
      deliveryKind: z.unknown().optional(),
      logicalFrameId: z.string().min(1),
      logicalFrameOrdinal: z.number(),
      topic: z.string().min(1),
      subscriptionId: z.string().min(1),
      fragmentIndex: z.unknown().optional(),
      fragmentCount: z.unknown().optional(),
      logicalBytes: z.unknown().optional(),
      checksum: z.unknown().optional(),
      dataBase64: z.unknown().optional(),
    })
    .passthrough(),
]);
export type TopicWireFrameCandidate = z.infer<typeof topicWireFrameCandidateSchema>;

// fragmentIndex 必须小于 fragmentCount，否则尾片永远无法完成组装。
// fragmentCount 不得超过 logicalBytes，防止每片不足一字节的谬误帧。
// complete 帧的 topic 必须与内层 frame.topic 一致。
// subscriptionId 同样做一致性精化，避免结果送到别的订阅者。
export function createTopicWireFrameSchema<F extends z.ZodTypeAny>(frameSchema: F) {
  return z
    .discriminatedUnion("kind", [
      z
        .object({
          wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
          kind: z.literal("complete"),
          deliveryKind: topicFrameDeliveryKindSchema,
          logicalFrameId: z.string().min(1),
          logicalFrameOrdinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          topic: z.string().min(1),
          subscriptionId: z.string().min(1),
          frame: frameSchema,
        })
        .strict(),
      z
        .object({
          wireVersion: z.literal(V4_WIRE_PROTOCOL_VERSION),
          kind: z.literal("fragment"),
          deliveryKind: topicFrameDeliveryKindSchema,
          logicalFrameId: z.string().min(1),
          logicalFrameOrdinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          topic: z.string().min(1),
          subscriptionId: z.string().min(1),
          fragmentIndex: z.number().int().nonnegative(),
          fragmentCount: z
            .number()
            .int()
            .positive()
            .max(PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxFragments),
          logicalBytes: z.number().int().positive(),
          checksum: topicWireChecksumSchema,
          dataBase64: topicWireBase64Schema,
        })
        .strict(),
    ])
    .superRefine((wire, context) => {
      const value = wire as unknown as TopicWireFrame<z.output<F>>;
      if (value.kind === "fragment") {
        if (value.fragmentIndex >= value.fragmentCount) {
          context.addIssue({
            code: "custom",
            message: "fragmentIndex must be smaller than fragmentCount",
            path: ["fragmentIndex"],
          });
        }
        if (value.fragmentCount > value.logicalBytes) {
          context.addIssue({
            code: "custom",
            message: "fragmentCount cannot exceed logicalBytes",
            path: ["fragmentCount"],
          });
        }
        return;
      }
      const frame = value.frame as {
        topic?: unknown;
        subscriptionId?: unknown;
      };
      if (frame.topic !== value.topic) {
        context.addIssue({
          code: "custom",
          message: "complete wire topic must match logical frame topic",
          path: ["topic"],
        });
      }
      if (frame.subscriptionId !== value.subscriptionId) {
        context.addIssue({
          code: "custom",
          message: "complete wire subscriptionId must match logical frame subscriptionId",
          path: ["subscriptionId"],
        });
      }
    });
}
