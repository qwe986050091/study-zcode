// ============================================================
// Vercel AI SDK tool transforms
// ============================================================
// 定位：模型适配层的工具声明转换，把 ZCode 的 ModelToolContract 翻译为 AI SDK ToolSet。
// 输入：工具契约数组 + AiSdkToolTransformOptions（provider 类型、strict/搜索开关、模型 id）。
// 输出：ToolSet；tools 为空时返回 undefined，调用方据此省略 tools 字段。
// 副作用：无 IO，只构造新的 schema/tool 对象，不修改入参 contract。
// 失败语义：provider-native 工具不受支持、或本地 schema 引用无法解析时抛
//   AiSdkModelAdapterError(InvalidModelRequest)，整个请求在发起前失败。
// 不变量：原 contract.inputSchema 对象不被就地改写；strict 只对首方 Anthropic 模型生效；
//   同一批工具中每个 name 只出现一次（后出现者覆盖前者由 Object.fromEntries 决定）。

import { anthropic } from "@ai-sdk/anthropic";
import { jsonSchema, tool, type ToolSet } from "ai";
import { ModelErrorCode, type JsonSchema, type ModelToolContract } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import { isAnthropicFirstPartyModelId, toStrictToolSchema } from "./strict-tool-schema.js";

export interface AiSdkToolTransformOptions {
  /** 是否启用 tool search 延迟加载；仅配合 contract.deferLoading 生成 Anthropic deferLoading 选项。 */
  toolSearchEnabled?: boolean;
  /** MFJS/J3 端要求把 #/properties/... 引用提升到 #/$defs；为 true 时执行 schema 重写。 */
  requiresMfjsToolSchema?: boolean;
  /** 目标 provider 是否支持原生 WebSearch；为 false 时 provider-native 工具直接报错而非静默降级。 */
  supportsNativeWebSearch?: boolean;
  /** 目标 provider 类型；决定 strict 资格、Anthropic providerOptions 与原生工具编码方式。 */
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";

  /** 本次请求的模型 id，仅用于首方 strict 资格判定；缺席即不启用 strict。 */
  modelId?: string;
}

/**
 * 把工具契约数组批量转换为 AI SDK ToolSet，是适配层唯一对外暴露的工具装配入口。
 * 输入：contracts 可空；providerNative 工具走原生分支，普通工具按 strict/schema 归一化后包装。
 * 输出：无工具或全部被过滤时返回 undefined，而非空对象，避免下游发送空 tools 数组。
 * 副作用：无网络/文件写入；execute 闭包会透传 AbortSignal 与元信息给 contract.execute。
 * 失败语义：原生工具编码失败或 schema 引用不可解析时抛 AiSdkModelAdapterError(InvalidModelRequest)。
 * 不变量：strict 仅在 resolveStrictToolSchema 的全部条件满足时显式传 strict:true，否则不发送该字段。
 */
export function toAiSdkTools(
  tools?: ModelToolContract[],
  options: AiSdkToolTransformOptions = {},
): ToolSet | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const entries = tools.flatMap((contract): [string, ToolSet[string]][] => {
    if (contract.providerNative) {
      // 原生工具由 provider SDK 自己的类型承载，无法编码时返回空数组即“该工具被跳过”还是抛错由 helper 决定。
      const providerTool = toAiSdkProviderNativeTool(contract, options);
      return providerTool ? [[contract.name, providerTool]] : [];
    }

    const strictSchema = resolveStrictToolSchema(contract, options);
    const baseTool = {
      description: contract.description,
      inputSchema: jsonSchema<unknown>(
        normalizeToolInputSchema(
          contract.name,
          strictSchema ?? (contract.inputSchema as JsonSchema),
          options,
        ),
      ),
      // 只有拿到严格 schema 才带 strict 字段，避免对不支持 strict 的 provider 暴露未知键。
      ...(strictSchema === undefined ? {} : { strict: true }),
      needsApproval: contract.needsApproval,
      ...providerOptionsForClientTool(options, contract),
    };

    if (!contract.execute) {
      // 无执行体的工具只是“声明”，由模型侧或宿主侧处理，这里用 never 表达不会被本地执行。
      return [[contract.name, tool<unknown, never>(baseTool)]];
    }

    return [
      [
        contract.name,
        tool<unknown, unknown>({
          ...baseTool,
          execute: async (input, options) =>
            // 显式重建 metadata 而不是整体透传，避免把 AI SDK 内部字段泄漏给工具实现。
            contract.execute?.(input, {
              toolCallId: options.toolCallId,
              abortSignal: options.abortSignal,
              metadata: {
                readOnly: contract.readOnly,
                destructive: contract.destructive,
                concurrentSafe: contract.concurrentSafe,
                requiresUserInteraction: contract.requiresUserInteraction,
                sideEffectScope: contract.sideEffectScope,
                maxOutputBytes: contract.maxOutputBytes,
                timeoutMs: contract.timeoutMs,
                experimentalContext: options.experimental_context,
              },
            }),
        }),
      ],
    ];
  });

  return entries.length > 0 ? (Object.fromEntries(entries) as ToolSet) : undefined;
}

/**
 * contract 声明 strict、provider 能力匹配、模型具备首方资格且 schema 可表达时，返回严格 schema；
 * 任一条件不满足都返回 undefined，调用方继续发送原 schema，避免兼容端收到陌生字段或非法形状。
 */
function resolveStrictToolSchema(
  contract: ModelToolContract,
  options: AiSdkToolTransformOptions,
): JsonSchema | undefined {
  if (contract.strict !== true) return undefined;
  if (options.providerKind !== "anthropic") return undefined;
  if (!isAnthropicFirstPartyModelId(options.modelId)) return undefined;
  return toStrictToolSchema(contract.inputSchema as JsonSchema);
}

/**
 * 选择实际发送的 inputSchema：需要 MFJS/J3 兼容时把非 $defs 本地引用提升为 $defs 引用。
 * 输入 schema 不会被修改，返回的可能是原对象或新副本；失败由 hoist 抛错。
 */
function normalizeToolInputSchema(
  toolName: string,
  schema: JsonSchema,
  options: AiSdkToolTransformOptions,
): JsonSchema {
  if (!options.requiresMfjsToolSchema) {
    return schema;
  }
  return hoistLocalJsonSchemaRefsToDefs(toolName, schema);
}

/**
 * 把 #/properties/... 等本地 $ref 复制到顶层 #/$defs/ 并改写引用，满足只认 $defs 的 provider。
 * 输入：工具名（仅用于报错）与原始 schema。
 * 输出：新的 schema 对象；无待提升引用时原样返回。
 * 失败语义：存在无法解析的本地引用时抛 InvalidModelRequest，避免发出坏 schema 让模型报错。
 * 不变量：已存在的 $defs key 不被覆盖，新 key 通过 zcode_ref_N 递增且跳过冲突名。
 */
function hoistLocalJsonSchemaRefsToDefs(toolName: string, schema: JsonSchema): JsonSchema {
  const refs = new Set<string>();
  collectNonDefsLocalRefs(schema, refs);
  const unresolvedRef = [...refs].find((ref) => resolveLocalJsonPointer(schema, ref) === undefined);
  if (unresolvedRef) {
    throw new AiSdkModelAdapterError(
      ModelErrorCode.InvalidModelRequest,
      `Tool ${toolName} contains an unresolvable local schema reference ${unresolvedRef}`,
      { context: { toolName, ref: unresolvedRef } },
    );
  }
  if (refs.size === 0) {
    return schema;
  }

  const existingDefs = asPlainRecord(schema.$defs) ?? {};
  const usedDefKeys = new Set(Object.keys(existingDefs));
  const defKeyByRef = new Map<string, string>();
  let nextDefIndex = 0;
  for (const ref of refs) {
    let defKey = `zcode_ref_${nextDefIndex}`;
    while (usedDefKeys.has(defKey)) {
      nextDefIndex += 1;
      defKey = `zcode_ref_${nextDefIndex}`;
    }
    nextDefIndex += 1;
    usedDefKeys.add(defKey);
    defKeyByRef.set(ref, defKey);
  }

  const rewrittenRoot = rewriteJsonSchemaRefs(schema, defKeyByRef) as JsonSchema;
  const rewrittenDefs = asPlainRecord(rewrittenRoot.$defs) ?? {};
  const hoistedDefs: Record<string, unknown> = {};
  for (const [ref, defKey] of defKeyByRef) {
    hoistedDefs[defKey] = rewriteJsonSchemaRefs(resolveLocalJsonPointer(schema, ref), defKeyByRef);
  }

  // MCP schema 会复用 #/properties/...，但 K3 只接受 #/$defs/...。
  // 在模型适配边界复制引用目标并改写引用，既不修改原 tool contract，也不影响其他模型。
  return {
    ...rewrittenRoot,
    $defs: {
      ...rewrittenDefs,
      ...hoistedDefs,
    },
  };
}

/**
 * 深度遍历 schema，收集所有指向 schema 内部、但不指向 #/$defs 的本地引用。
 * 输入：任意 JSON 值；输出通过 refs 累积，无返回值。不处理外部 URL 引用。
 */
function collectNonDefsLocalRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNonDefsLocalRefs(item, refs);
    }
    return;
  }
  const record = asPlainRecord(value);
  if (!record) return;
  if (
    typeof record.$ref === "string" &&
    record.$ref.startsWith("#/") &&
    !record.$ref.startsWith("#/$defs/")
  ) {
    refs.add(record.$ref);
  }
  for (const child of Object.values(record)) {
    collectNonDefsLocalRefs(child, refs);
  }
}

/**
 * 按 JSON Pointer 规则解析本地 #/ 引用，支持 ~0/~1 转义与数组下标。
 * 输出：解析成功返回目标值，任一步缺失或格式非法返回 undefined（不抛错，供调用方判定不可解析）。
 */
function resolveLocalJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  try {
    for (const encodedSegment of ref.slice(2).split("/")) {
      const segment = decodeURIComponent(encodedSegment)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      if (Array.isArray(current)) {
        if (!/^\d+$/u.test(segment)) return undefined;
        current = current[Number(segment)];
        continue;
      }
      const record = asPlainRecord(current);
      if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) {
        return undefined;
      }
      current = record[segment];
    }
  } catch {
    return undefined;
  }
  return current;
}

/**
 * 递归复制 schema，把可映射的 $ref 改写为 #/$defs/<defKey>；其余字段保持原值。
 * 纯函数：不修改输入对象，未命中映射的引用原样保留。
 */
function rewriteJsonSchemaRefs(value: unknown, defKeyByRef: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonSchemaRefs(item, defKeyByRef));
  }
  const record = asPlainRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string") {
        const defKey = defKeyByRef.get(child);
        if (defKey) {
          return [key, `#/$defs/${defKey}`];
        }
      }
      return [key, rewriteJsonSchemaRefs(child, defKeyByRef)];
    }),
  );
}

/** 判断是否为普通对象（排除 null 与数组），用作 schema 遍历的类型收窄。 */
function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 生成客户端工具的 providerOptions；仅 Anthropic 需要，其他 provider 返回空对象。
 * 输出：{ providerOptions } 或 {}，通过 spread 合并进 tool 定义，不产生额外字段。
 */
function providerOptionsForClientTool(
  options: AiSdkToolTransformOptions,
  contract: ModelToolContract,
): {
  providerOptions?: Record<string, Record<string, boolean>>;
} {
  if (options.providerKind !== "anthropic") {
    return {};
  }

  // AI SDK enables Anthropic fine-grained tool input streaming by default
  // and serializes eager_input_streaming on every function tool. Several
  // Anthropic-compatible gateways reject that extra tool field, so ZCode opts out
  // at the provider-option boundary unless a future capability contract enables it.
  return {
    providerOptions: {
      anthropic: {
        eagerInputStreaming: false,
        ...(options.toolSearchEnabled && contract.deferLoading ? { deferLoading: true } : {}),
      },
    },
  };
}

/**
 * 把 providerNative 契约编码成对应 SDK 的原生工具；目前只支持 Anthropic WebSearch。
 * 输入：contract.providerNative.logicalName 必须为 WebSearch，args 提供 maxUses/域名黑白名单。
 * 输出：原生工具对象；logicalName 不匹配时返回 undefined（该工具被静默跳过）。
 * 失败语义：provider 不支持原生搜索或类型无法编码时抛 InvalidModelRequest，绝不降级成普通函数工具。
 * 默认值：maxUses 缺省为 8；空数组的域名列表视为未指定。
 */
function toAiSdkProviderNativeTool(
  contract: ModelToolContract,
  options: AiSdkToolTransformOptions,
): ToolSet[string] | undefined {
  if (contract.providerNative?.logicalName !== "WebSearch") {
    return undefined;
  }

  const args = contract.providerNative.args ?? {};
  const maxUses = numberArg(args.maxUses) ?? 8;
  const allowedDomains = stringArrayArg(args.allowedDomains);
  const blockedDomains = stringArrayArg(args.blockedDomains);

  switch (options.providerKind) {
    case "anthropic":
      if (!options.supportsNativeWebSearch) {
        throw new AiSdkModelAdapterError(
          ModelErrorCode.InvalidModelRequest,
          "Effective Model Config does not support provider-native WebSearch",
        );
      }
      return anthropic.tools.webSearch_20260209({
        maxUses,
        allowedDomains,
        blockedDomains,
      }) as ToolSet[string];

    default:
      throw new AiSdkModelAdapterError(
        ModelErrorCode.InvalidModelRequest,
        `Provider API kind ${options.providerKind ?? "unknown"} does not encode provider-native WebSearch`,
      );
  }
}

/** 从 providerNative.args 读取有限数值，类型不符返回 undefined 以走默认值。 */
function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 读取字符串数组，过滤非字符串项；空结果返回 undefined 表示“未指定”。 */
function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length > 0 ? values : undefined;
}
