// ============================================================
// Skill Tool - load reusable local instructions on demand
// ============================================================
// 生产者：core 的 handlers/skill.ts 用 SkillInputSchema 解析模型入参，经 SkillPort.loadSkill
// 读文件后拼成 `<skill_content>` 文本；消费者：provider 只看到 SkillInputJsonSchema（当前形），
// executor 用 SkillOutputSchema 校验 handler 的产物。
// 两层输入的差异是兼容事实：模型面只暴露 `skill`（现行字段），执行侧仍接受历史的 `name`，
// 由 transform 归一成统一内部形状，避免旧客户端/旧提示词直接失效。
// 输出不是结构化 JSON 而是可直接拼进上下文的字符串；`SkillStructuredOutput` 是同一结果的
// 结构化镜像，仅用于需要保真字段（baseDirectory/truncated）的内部消费方。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

const SkillCurrentInputSchema = z.object({
  skill: z
    .string()
    .describe("The name of a skill from the available-skills list. Do not guess names."),
  args: z.string().optional().describe("Optional arguments for the skill"),
});

const LegacySkillInputSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});

// 执行侧唯一入口：现行形状（skill）与历史形状（name）的并集，再归一成 `{ skill, args }`。
// 顺序有意义——并集会先尝试现行形状；`args` 原样透传，handler 不解释、不改写，由技能正文
// 自行消费。归一化只发生在解析阶段，之后的代码只面对一种字段名。
export const SkillInputSchema = z
  .union([SkillCurrentInputSchema, LegacySkillInputSchema])
  .transform((input) => ({
    args: input.args,
    skill: "skill" in input ? input.skill : input.name,
  }));

// 对外（工具调用结构体、UI、事件）使用的输入类型：固定为现行形状，不含历史 `name`；
// 这样序列化出去的数据不会把兼容字段泄漏给新消费方。
export type SkillInput = z.infer<typeof SkillCurrentInputSchema>;
// handler 内部实际拿到的类型：`skill` 已由上面的 transform 归一，历史 `name` 不再出现。
export type SkillRuntimeInput = z.infer<typeof SkillInputSchema>;

// provider 可见 schema 只取现行形状：模型永远不该看到 `name` 这个兼容分支，
// 否则会诱导它生成已废弃的调用方式。
export const SkillInputJsonSchema = toToolJsonSchema(SkillCurrentInputSchema);

// 结构化结果镜像：`content` 是技能正文（可能已被端口按 maxBytes 截断），`baseDirectory`
// 是相对路径的解析基准（正文里的相对路径全靠它），`truncated` 是端口给出的截断事实，
// handler 据此补 "[Skill content truncated]" 标记而不是自行判断长度。
export interface SkillStructuredOutput {
  name: string;
  content: string;
  baseDirectory: string;
  truncated: boolean;
}

// 两种合法产物：handler 实际返回的是拼好的字符串（含外壳与目录变量展开），结构化对象
// 供需要逐字段读取的调用方/回放使用。联合顺序不影响校验，字符串分支先匹配。
export type SkillOutput = string | SkillStructuredOutput;

// 结构化产物的运行时契约（`.strict()`）：四个字段都是必要事实，缺一个就无法在另一端
// 正确重建外壳或判断截断，因此不允许缺省。
export const SkillStructuredOutputSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    baseDirectory: z.string(),
    truncated: z.boolean(),
  })
  .strict();

// executor 侧的结果校验入口：与 TS 联合类型同构，字符串优先。任何一侧不匹配都会把这次
// 工具调用收成失败，而不是让不合法产物进入会话历史。
export const SkillOutputSchema = z.union([z.string(), SkillStructuredOutputSchema]);

// 输出 JSON schema 由运行时 schema 转换，仅用于契约对齐；模型实际读到的是字符串正文。
export const SkillOutputJsonSchema = toToolJsonSchema(SkillOutputSchema);

// 工具调用结构：`traceId` 是跨 session/turn 的可观测主链，`startedAt` 用于耗时归因；
// `name` 是字面量，防止调用结构被挪用给别的工具。
export interface SkillToolCall {
  id: ToolCallId;
  name: "Skill";
  input: SkillInput;
  traceId: TraceId;
  startedAt: Date;
}

// 结果与调用用 `toolCallId` 配对而不是用 name：同名工具的并发调用只能靠 id 区分；
// `durationMs` 是 handler 侧观测到的墙钟耗时，不含事件持久化开销。
export interface SkillToolResult {
  toolCallId: ToolCallId;
  output: SkillOutput;
  traceId: TraceId;
  durationMs: number;
}
