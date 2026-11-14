// RuntimeInputPresentation：输入「来源 + 实际消费形态」的单一事实标记。
// 生产者是 CLI/runtime 的 admission 与 drain（user steer、协调者、子代理回复、后台通知）；
// 消费者是 user message 持久化 metadata（inputPresentation）、V4 投影与冷恢复渲染。
// 七个取值是一个封闭词表：新增来源必须同时定义落盘语义与旧数据读侧降级，不能靠猜测补值。
// 历史消息缺失该字段时按旧语义处理，恢复阶段不追溯转换、不回填。

import { z } from "zod";

/** 来源和实际消费形态的单一标记；缺失的旧历史不追溯转换。 */
export const RuntimeInputPresentationSchema = z.enum([
  "user_steer",
  "coordinator_steer",
  "coordinator_input",
  "subagent_reply_steer",
  "subagent_reply",
  "task_notification_steer",
  "task_notification",
]);
// 词表成员的两种形态：带 _steer 后缀表示插入进行中轮次（guide 消费），不带后缀表示
// 独立投递（普通输入/通知）。同名主体的两种形态必须成对出现，便于投影按后缀区分消费车道。
// 该类型跨进程传递：pending input 事件、持久 metadata 与恢复路径共用同一字符串值。
export type RuntimeInputPresentation = z.infer<typeof RuntimeInputPresentationSchema>;

// 宽容解析入口：只接受词表内的字符串，其它值（旧版本、损坏数据、非字符串）返回 undefined。
// 调用方必须把 undefined 当作「来源未标注」并按缺省形态处理，不能据此伪造来源。
// 刻意不抛错，因为该函数用于恢复/投影边界，一行坏数据不应让整条历史 hydration 失败。
export function parseRuntimeInputPresentation(
  value: unknown,
): RuntimeInputPresentation | undefined {
  const result = RuntimeInputPresentationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
