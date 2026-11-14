// INV-01 版本号是文件第一道门：守住位置 解码入口；改错故障 无版本文件被当成当前格式。
// INV-02 高版本直接拒绝：守住位置 比较分支；改错故障 新客户端文件被旧端静默降级。
// INV-03 迁移逐级推进：守住位置 while 循环；改错故障 跨版本跳步产生错误结构。
// INV-04 缺迁移器即报错：守住位置 映射查找；改错故障 用当前 schema 强解旧文件。
// INV-05 迁移必须递增恰好一级：守住位置 校验；改错故障 迁移器原地打转导致死循环。
// INV-06 落盘 schema 为 strict：守住位置 顶层与 config；改错故障 未知字段被带进内存。
// INV-07 规则字段先接 unknown：守住位置 解码；改错故障 个性化规则无法兼容历史形状。
// INV-08 版本错误类型专用：守住位置 异常类；改错故障 调用方无法区分损坏与版本不支持。
// INV-09 版本字段必须非负整数：守住位置 读取器；改错故障 字符串版本被强转。
// INV-10 缺版本与非法版本区分：守住位置 两个错误消息；改错故障 排障时分不清原因。
// INV-11 旧手动规则就地归一：守住位置 map 回调；改错故障 单个旧规则阻断整份配置。
// INV-12 现行形状优先放行：守住位置 早退；改错故障 合法配置被多余提取改写。
// INV-13 只认两种旧形状：守住位置 联合校验；改错故障 未知形状被删字段伪装成功。
// INV-14 提取只取可编辑字段：守住位置 转换；改错故障 隐藏字段重新回流。
// INV-15 编码只写当前版本：守住位置 常量；改错故障 保存出未来版本号。
// INV-16 可选字段缺省即省略：守住位置 展开；改错故障 空对象覆盖上层默认值。
// INV-17 编码输出即为可序列化结构：守住位置 返回；改错故障 类实例直接落盘。
// INV-18 读与写共用同一常量：守住位置 版本引用；改错故障 读写版本漂移。
//
// 模块职责：个人 Provider 配置文件的版本解码、迁移与编码。
// 状态所有权：迁移表为模块常量；解码过程全部局部变量。
// 阅读顺序：先看落盘 schema 与异常类，再看解码，最后看旧规则归一与编码。
import { z } from "zod";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";
import {
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  extractManualModelConfig,
  manualModelConfigSchema,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";

const CURRENT_SCHEMA_VERSION = 1 as const;

type ProviderConfigFileMigration = (input: unknown) => unknown;

const migrations: ReadonlyMap<number, ProviderConfigFileMigration> = new Map();

// 顶层与 config 都是严格对象。
// providerConfigRules 与 modelConfigRules 必填，类型交给下游校验。
// providerOrder 与 defaultModelSelection 可选，缺省时不写键。
// .strict() 让未知键在解析期直接报错，不静默丢弃。
const storedProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    config: z
      .object({
        providerOrder: z.array(z.string().min(1)).optional(),
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
        defaultModelSelection: modelSelectionSchema.optional(),
      })
      .strict(),
  })
  .strict();

// 版本缺失时字段为 null。
// version 缺失时字段为 null，便于跨进程序列化。
// name 固定为 "UnsupportedProviderConfigVersionError"，调用方按名识别。
// message 保留原始版本值，供升级提示直接展示。
export class UnsupportedProviderConfigVersionError extends Error {
  readonly version: number | null;

  constructor(message: string, version: number | null) {
    super(message);
    this.name = "UnsupportedProviderConfigVersionError";
    this.version = version;
  }
}

// decodeProviderConfigFile 全程只读，不写盘也不改入参。
// 返回对象用 Object.freeze 冻结，防止调用方就地修改。
// defaultModelSelection 可选，按存在性展开而不是填默认值。
export function decodeProviderConfigFile(input: unknown): ProviderConfigLayerUpdate {
  let candidate = input;
  let version = readSchemaVersion(candidate);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError("Provider Config 缺少 schemaVersion", null);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedProviderConfigVersionError(
      `Provider Config schemaVersion ${version} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}`,
      version,
    );
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations.get(version);
    if (!migration) {
      throw new UnsupportedProviderConfigVersionError(
        `缺少 Provider Config schemaVersion ${version} 到 ${version + 1} 的迁移器`,
        version,
      );
    }
    candidate = migration(candidate);
    const nextVersion = requireSchemaVersion(candidate);
    if (nextVersion !== version + 1) {
      throw new Error(
        `Provider Config 迁移器必须从 schemaVersion ${version} 迁移到 ${version + 1}`,
      );
    }
    version = nextVersion;
  }
  const parsed = storedProviderConfigSchema.parse(candidate);
  return Object.freeze({
    providers: parsePersonalProviderConfigMap(parsed.config.providerConfigRules),
    models: parsePersonalModelConfigRules(
      normalizeLegacyManualRules(parsed.config.modelConfigRules),
    ),
    providerOrder: parsed.config.providerOrder,
    ...(parsed.config.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: parsed.config.defaultModelSelection }),
  });
}

const legacyCompleteManualSchema = completeModelConfigDataSchema.extend({
  enabled: modelConfigDataSchema.shape.enabled,
});

// 旧编辑器曾把 MFJS 当作手动必填项；隐藏后仅在文件边界识别旧合法形状，
// 提取现行可编辑字段，避免整个个人配置加载失败或继续冻结系统能力。
const legacyEditableManualSchema = manualModelConfigSchema.extend({
  properties: manualModelConfigSchema.shape.properties.extend({
    requiresMfjsToolSchema:
      completeModelConfigDataSchema.shape.properties.shape.requiresMfjsToolSchema,
  }),
});

// normalizeLegacyManualRules 对非对象与非数组原样返回。
// 每条 manualProviderModelRules 独立判定，互不影响。
// 已符合 manualModelConfigSchema 的规则直接跳过。
function normalizeLegacyManualRules(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.manualProviderModelRules)) return input;
  return {
    ...input,
    manualProviderModelRules: input.manualProviderModelRules.map((rule: unknown) => {
      if (!isRecord(rule) || manualModelConfigSchema.safeParse(rule.config).success) return rule;
      // 仅识别旧完整形状，不把未知/损坏配置通过删字段伪装成成功；公共写入入口仍严格拒绝隐藏叶子。
      const legacy = z
        .union([legacyCompleteManualSchema, legacyEditableManualSchema])
        .safeParse(rule.config);
      return legacy.success ? { ...rule, config: extractManualModelConfig(legacy.data) } : rule;
    }),
  };
}

// encodeProviderConfigFile 的输出只含 CURRENT_SCHEMA_VERSION。
// providerOrder 仅在存在时写入，不写空数组。
// providerConfigRules 与 modelConfigRules 的序列化交给模型对象。
export function encodeProviderConfigFile(update: ProviderConfigLayerUpdate) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config: {
      ...(update.providerOrder === undefined ? {} : { providerOrder: update.providerOrder }),
      providerConfigRules: { providerRules: update.providers.toJSON() },
      modelConfigRules: update.models.toPersonalJSON(),
      ...(update.defaultModelSelection === undefined
        ? {}
        : { defaultModelSelection: update.defaultModelSelection }),
    },
  };
}

function readSchemaVersion(input: unknown): number | null {
  if (!isRecord(input) || !("schemaVersion" in input)) return null;
  const version = input.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config schemaVersion 必须是非负整数",
      null,
    );
  }
  return version as number;
}

function requireSchemaVersion(input: unknown): number {
  const version = readSchemaVersion(input);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config 迁移器必须产生版本化文件",
      null,
    );
  }
  return version;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
