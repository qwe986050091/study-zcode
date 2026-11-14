// ============================================================
// ListModels Tool - 列出本宿主已配置的模型
// ============================================================
//
// 只读、无副作用的发现面，服务于一件事：主代理要给一次 workflow run 挑子代理模型
// （`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`）。它不是选模开关——本工具改不了
// 会话自己的模型，主代理恒留在用户选的那一个上。
//
// 与解析器是**两条互补的路**：先按用户说的名字直接传，解不出来时工具会连同候选一起退回；
// 本工具是主动那一条（"我们有哪些模型可用？"）。两条路读的是同一份活目录
// （{@link import("../interfaces/model-catalog.port.js").ModelCatalogPort}）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

// 工具注册名。它同时是权限规则、事件与 UI 投影的判别键，改名等于换一个工具；模型侧只在
// tool schema 的 name 字段看到它，因此必须与 core handler 注册项里的 metadata.name 一致。
export const LIST_MODELS_TOOL_NAME = "ListModels";

// 运行时输入 schema：空对象且 strict。没有任何过滤/分页旋钮，模型多传一个字段就会在
// 校验层失败，而不是被静默忽略。生产者是模型 tool_call，消费者是 core handler。
export const ListModelsInputSchema = z
  .object({})
  // 与 ListSavedWorkflows 同一条约束：没有任何入参。过滤、分页、模糊查询都不给——目录是
  // 一张几十行的表，多一个旋钮就多一处让模型以为"没列全"的地方。
  .strict();

// 运行时推导的输入类型；由于入参恒为空对象，它只用于让 handler 的签名与契约一致，
// 不承载任何业务字段。
export type ListModelsInput = z.infer<typeof ListModelsInputSchema>;

// provider 可见的输入 schema。空对象仍会投影出 type:"object" 与空 properties，保证远端
// 校验器把"不接受任何参数"当成明确约束，而不是缺失 schema。
export const ListModelsInputJsonSchema = toToolJsonSchema(ListModelsInputSchema);

/** 目录里的一行。`id` 是可以**逐字**填进 `subagent_model` 的规范形。 */
// 目录一行的运行时 schema，strict 拒绝未声明字段。id 是规范形 `providerId/modelId`，
// 可逐字粘贴进 subagent_model；providerId/modelId 拆开保留，是为了让消费方既能原样透传，
// 也能按 provider 分组而不必解析字符串。readonly 投影只读，不参与任何选模开关。
export const ListModelsEntrySchema = z
  .object({
    /** 规范形 `providerId/modelId`（不含推理档位；要档位就自己接 `$level`）。 */
    id: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    /** provider 的人类可读名；注册表没给就缺席。 */
    providerLabel: z.string().optional(),
    /** 合法的 `$level` 取值。没有档位的模型是空数组——读侧据此知道"接 `$` 是错的"。 */
    reasoningLevels: z.array(z.string()),
    /** 不接 `$level` 时会用上的档位；`reasoningLevels` 为空时缺席。 */
    defaultReasoningLevel: z.string().optional(),
    contextWindow: z.number().optional(),
    /** 不可选用的理由；可选用即缺席（而不是空字符串）。 */
    disabledReason: z.string().optional(),
  })
  .strict();

// 目录行的内部类型，供 core handler 组装输出；跨进程回放一律以 schema 为准。
export type ListModelsEntry = z.infer<typeof ListModelsEntrySchema>;

// 输出快照：current 可选（目录里没有标 current 的条目时缺席），models 是完整目录。
// 它是"一次调用现读"的快照，不是分页游标——目录规模小，且会话模型可能随时被用户切换，
// 给游标只会让模型把过期快照当成当前事实。
export const ListModelsOutputSchema = z
  .object({
    /**
     * 会话此刻用的模型（规范形）。**只是坐标，不是推荐**：子代理省略 `subagent_model` 时跑的
     * 就是它，所以"把子代理设成这一个"等于什么都不做。目录里一条都对不上时缺席。
     */
    current: z.string().optional(),
    models: z.array(ListModelsEntrySchema),
  })
  .strict();

// 输出快照的内部类型；handler 以 satisfies 构造它，保证与 schema 同形。
export type ListModelsOutput = z.infer<typeof ListModelsOutputSchema>;

// provider 可见的输出 schema。工具结果回放时按它校验；新增字段必须同时改 schema，
// 否则旧版本数据会在投影层被判为无效结果。
export const ListModelsOutputJsonSchema = toToolJsonSchema(ListModelsOutputSchema);
