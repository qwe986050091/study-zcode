// INV-01 控件类型由判别联合收窄：守住位置 genUiAnnotationControlSchema；改错故障 未知类型进入下游。
// INV-02 四种控件共享三项基础字段：守住位置 base 常量；改错故障 各类型字段不一致。
// INV-03 回调名长度受限且必填：守住位置 callback 约束；改错故障 超长回调进入消息。
// INV-04 颜色值只接受十六进制：守住位置 正则；改错故障 任意字符串被当颜色。
// INV-05 选择项数量限制在 1 到 12：守住位置 options 约束；改错故障 浮层被无限撑开。
// INV-06 每个控件都拒绝未知字段：守住位置 strict；改错故障 字段污染被静默接受。
// INV-07 值校验与类型分支一一对应：守住位置 isGenUiAnnotationValue；改错故障 越界值被提交。
// INV-08 回调名在控件间必须唯一：守住位置 superRefine；改错故障 两个控件共用回调。
// INV-09 控件当前值必须自洽：守住位置 同一 refine；改错故障 初始值越界。
// INV-10 序列化长度上限 16384：守住位置 refine 最后一项；改错故障 大载荷进入 IPC。
// INV-11 目标只允许单个：守住位置 targets 长度约束；改错故障 多目标请求被接受。
// INV-12 目标矩形宽高非负：守住位置 rect 约束；改错故障 负尺寸进入布局。
// INV-13 注册与更新共用同一结构：守住位置 registration 常量；改错故障 两种消息字段漂移。
// INV-14 销毁与选择只带定位字段：守住位置 后三类消息；改错故障 变更被顺带提交。
// INV-15 转义消息不带任何数据：守住位置 escape 分支；改错故障 取消仍触发更新。
// INV-16 结果只包含可选控件块：守住位置 genUiTweakResultSchema；改错故障 多余字段外泄。
// INV-17 批注变更数量上限 64：守住位置 changes 约束；改错故障 单次提交过大。
// INV-18 类型均由 schema 推导：守住位置 infer；改错故障 手写类型与校验分叉。
//
// 模块职责：GenUI tweak 消息、控件、结果与批注的协议定义。
// 状态所有权：无状态；只有 schema 与由其推导的类型。
// 阅读顺序：先看控件联合，再读注册结构与消息联合，最后看结果与批注。
import { z } from "zod";

// 本文件只有 schema 与纯校验。
// 不依赖 React 或运行时环境。
// 所有长度上限都是硬约束。
// 导出类型全部由 schema 推导。
// 消息与结果分两组导出。
const value = z.union([z.string(), z.number().finite(), z.boolean()]);
const base = {
  callback: z.string().min(1).max(128),
  label: z.string().min(1).max(120),
  reference: z.string().max(160).optional(),
};
export const genUiAnnotationControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("range"),
      currentValue: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().positive(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("color"),
      currentValue: z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i),
    })
    .strict(),
  z.object({ ...base, type: z.literal("toggle"), currentValue: z.boolean() }).strict(),
  z
    .object({
      ...base,
      type: z.literal("select"),
      currentValue: z.string().max(120),
      options: z
        .array(z.object({ label: z.string().min(1).max(120), value: z.string().max(120) }).strict())
        .min(1)
        .max(12),
    })
    .strict(),
]);
export type GenUiAnnotationControl = z.infer<typeof genUiAnnotationControlSchema>;
// range 控件只接受有限数字且落在 min/max 内。
// color 控件复用同一正则校验。
// toggle 控件只接受布尔值。
// select 控件要求 candidate 命中 options 某一项。
// switch 穷尽后返回 false，不抛错。
export function isGenUiAnnotationValue(
  control: GenUiAnnotationControl,
  candidate: unknown,
): candidate is string | number | boolean {
  switch (control.type) {
    case "range":
      return (
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate >= control.min &&
        candidate <= control.max
      );
    case "color":
      return (
        typeof candidate === "string" &&
        /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(candidate)
      );
    case "toggle":
      return typeof candidate === "boolean";
    case "select":
      return (
        typeof candidate === "string" &&
        control.options.some((option) => option.value === candidate)
      );
  }
}
// 控件数量同样限制在 1 到 12。
// 回调集合大小必须等于 controls.length。
// 每个控件的当前值都要通过 isGenUiAnnotationValue。
// 整体 JSON.stringify 长度设上限，防止超大消息。
// 任一条件不满足即整体拒绝，不做部分接受。
const annotationControls = z
  .object({
    controlsMode: z.literal("replace"),
    controls: z.array(genUiAnnotationControlSchema).min(1).max(12),
  })
  .strict()
  .superRefine((input, ctx) => {
    const callbacks = new Set(input.controls.map((control) => control.callback));
    if (
      callbacks.size !== input.controls.length ||
      input.controls.some((control) => !isGenUiAnnotationValue(control, control.currentValue)) ||
      JSON.stringify(input).length > 16384
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid annotation controls" });
    }
  });
const target = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(80),
    selector: z.string().max(1024),
    tagName: z.string().min(1).max(120),
    rect: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
const registration = {
  registrationId: z.string().min(1).max(128),
  annotationControls,
  targets: z.array(target).length(1),
};
// register 与 update 复用同一 registration 结构。
// dispose 只带 registrationId。
// select 额外带 target 标识。
// escape 消息不携带负载。
export const genUiTweakMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("register"), ...registration }).strict(),
  z.object({ type: z.literal("update"), ...registration }).strict(),
  z.object({ type: z.literal("dispose"), registrationId: registration.registrationId }).strict(),
  z
    .object({
      type: z.literal("select"),
      registrationId: registration.registrationId,
      targetId: target.shape.id,
    })
    .strict(),
  z.object({ type: z.literal("escape") }).strict(),
]);
export type GenUiTweakMessage = z.infer<typeof genUiTweakMessageSchema>;
export const genUiTweakResultSchema = z
  .object({ annotationControls: annotationControls.optional() })
  .strict();
export type GenUiTweakResult = z.infer<typeof genUiTweakResultSchema>;
// genUiTweakAnnotationSchema 的 active 为布尔值。
// changes 可为空，变更数组上限 64。
// 变更数组上限 64。
// 每条变更的控件变更上限 12。
export const genUiTweakAnnotationSchema = z
  .object({
    active: z.boolean(),
    selection: z
      .object({ registrationId: registration.registrationId, targetId: target.shape.id })
      .nullable(),
    changes: z
      .array(
        z
          .object({
            registrationId: registration.registrationId,
            targetId: target.shape.id,
            annotationControlChanges: z
              .array(z.object({ callback: base.callback, previousValue: value, value }).strict())
              .max(12),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type GenUiTweakAnnotation = z.infer<typeof genUiTweakAnnotationSchema>;
