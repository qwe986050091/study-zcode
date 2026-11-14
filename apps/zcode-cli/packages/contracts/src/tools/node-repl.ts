// ============================================================
// js（Node REPL）工具契约 - 执行边界与安全声明
// ============================================================
// 本文件只声明 js 工具的输入/输出 shape，不执行任何代码。真正执行在 core 的
// handlers/node-repl.ts 与 repl/node-repl-session.ts：每个 session 一个持久 REPL，跨调用
// 保留 globalThis 与顶层声明。
// 安全口径：REPL 有完整 Node 权限（require/process），风险等同 Bash——注册声明为
// readOnly=false、sideEffectScope=system、riskLevel=high、needsApproval=true，工具本身不做
// 沙箱，沙箱由 ExecutionPort/宿主承担。
// 双 schema：JsInputSchema 是新调用的严格面（title 必填），JsRuntimeInputSchema 兼容旧会话与
// 第三方 provider 的历史调用（title 可省）；两者共享同一 base，避免字段漂移。
// 超时口径：默认 30s，可覆盖但硬顶 120s；超出 30s 的长任务模型必须显式传 timeout_ms。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const JsInputBaseShape = {
  // 同一模型 schema 同时服务 persistent core REPL 与 fresh-kernel Browser Use MCP；
  // 字段文案不能替任一执行边界承诺跨调用状态，生命周期由各自 tool description 说明。
  code: z.string().describe("JavaScript code to execute in the Node REPL session"),
  // 只写 optional 无法让模型判断何时覆盖默认值，长等待容易在副作用完成后超时。
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe(
      "Per-call timeout in milliseconds. You MUST provide this when the code is expected to run longer than 30000 ms, including all awaited operations. Set it to at least the estimated total runtime plus 15000 ms. If that exceeds the 120000 ms maximum, split the work into multiple calls.",
    ),
};
const JsUserTitleSchema = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Required short user-facing title in the user's language that describes the intended action without implementation terms such as js, JavaScript, or node_repl",
  );

// js 的严格输入面：code + 必填 title（+ 可选 timeout_ms）。title 用于向用户解释这段代码
// 在做什么，缺失时进度展示无从命名，因此模型侧必填；strict 同时拒绝把 Bash 的 command 等
// 多余字段混进来，避免被静默忽略后模型误以为已经改了执行方式。
/** js：在持久 REPL 里执行一段 JS 代码。 */
export const JsInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema,
  })
  .strict();
// 严格输入面推导出的类型，handler 侧按它取值；运行时仍用 JsRuntimeInputSchema 解析，
// 以兼容历史调用。
export type JsInput = z.infer<typeof JsInputSchema>;

// 运行时输入面：与严格面同形，但 title 可缺省。差别只在这里——旧会话回放与第三方 provider
// 的历史 tool_call 可能没有 title，用严格面解析会让它们整条请求失败；而执行本身并不依赖
// title（它只是展示元数据）。
// 新调用必须提供用户可读标题，但旧会话和第三方 provider 的历史调用可能没有该字段。
export const JsRuntimeInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema.optional(),
  })
  .strict();
// 运行时输入类型；title 因此是可选字段，handler 传给 REPL 的 requestMeta 时允许为 undefined。
export type JsRuntimeInput = z.infer<typeof JsRuntimeInputSchema>;

// js 的输出面。它按"这次调用产出了什么"分类，而不是按执行阶段：result 是最后一个表达式的
// 值（可能缺席），logs 是 nodeRepl.write 收集的日志（恒在，可为空串），error 是捕获到的
// 异常，images/browserScreenshotPaths 是浏览器截图的两条通道，responseMeta 是浏览器命令
// 产生的结构化元数据。
// 关键边界：模型可见内容由 formatModelContent 组装（会把 images 转成 image 内容块），
// 而本 schema 只负责跨进程回放时的形状校验。
export const JsOutputSchema = z
  .object({
    // 最后一个表达式的值；代码没有返回值或返回 undefined 时缺席，而不是写成空串。
    result: z.string().optional(),
    // nodeRepl.write 收集的日志文本；恒在场，空串表示这次调用没有写日志。
    logs: z.string(),
    // 代码抛出的异常（若有）。只保留可展示的三段：类型名、消息、可选栈；栈对定位错误最有用，
    // 但某些宿主不提供，因此可选。异常不是工具失败——js 正常返回，失败由 error 字段表达。
    error: z
      .object({
        // 异常类型名（如 TypeError），用于模型判断错误性质。
        name: z.string(),
        // 异常消息原文。
        message: z.string(),
        // 可选栈文本；缺失表示宿主未提供，不能据此推断"没有栈"。
        stack: z.string().optional(),
      })
      .optional(),
    // nodeRepl.emitImage 收集的图片（如 tab.screenshot 的截图）；formatModelContent 会转成 image 内容块给模型。
    images: z.array(z.object({ base64: z.string(), mimeType: z.string() }).strict()).optional(),
    // 模型显式 tab.screenshot() 原始 PNG 的 session artifact 绝对路径。
    browserScreenshotPaths: z.array(z.string()).optional(),
    // 浏览器命令返回的结构化元数据（如 zcode/toolSurface、zcode/browserTurnScreenshot），
    // 键由浏览器运行时约定、值形状随命令而变，因此是开放的 record；缺席表示本次调用没碰浏览器。
    responseMeta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
// 输出类型，handler 用 satisfies 构造；images 与 browserScreenshotPaths 都是可选，只有真产出时
// 才带键——空数组不写进去，避免模型把"没有截图"误读成"截图失败"。
export type JsOutput = z.infer<typeof JsOutputSchema>;

// provider 可见的输入 schema；投影会带上 title 必填与 timeout_ms 的 120s 上限，模型据此知道
// 硬顶。它只用于协议侧声明，运行时仍以 JsRuntimeInputSchema 为准（title 在旧调用中可省）。
export const JsInputJsonSchema = toToolJsonSchema(JsInputSchema);
// provider 可见的输出 schema，用于跨进程工具结果回放校验；images 的元素形状也在此固化，
// 防止 adapters 之间对图片字段命名产生分歧。
export const JsOutputJsonSchema = toToolJsonSchema(JsOutputSchema);
