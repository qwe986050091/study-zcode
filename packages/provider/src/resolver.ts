/* oxlint-disable eslint(max-lines) -- Resolver 同时产出 Settings 分层结果与唯一 Registry 完整类型证明。 */
// Provider 配置解析器（resolver）：把内置、内置模板、个人、账号四路来源归并为三层只读视图——
// 生效配置（effective 前缀）、设置页展示候选（resolvedProviders）与可发布 Registry（registryProviders）。
// 不在本文件内：配置持久化与写回、zod schema 与模板内容定义、账号 OAuth 与网络状态刷新；这里只做纯内存合并与校验。
//
// 核心不变量：
// INV-01 断言：accountProviders 只保留同时存在于内置表的 providerId —— 守住它的位置：resolve 开头的 entries 过滤 —— 改错故障：幽灵账号混入内置覆盖，Registry 出现无模板 Provider。
// INV-02 断言：账号配置参与覆盖前必须先 withoutGroup —— 守住它的位置：accountProviders 的 mapConfigs —— 改错故障：账号 group 污染内置分组，家族排序与隐藏逻辑失效。
// INV-03 断言：模板 overlay 只作用于声明了 templateId 的规则 —— 守住它的位置：effectiveBuiltinProviders 的 mapConfigs —— 改错故障：无模板 Provider 被塞入模板默认值，用户配置被静默改写。
// INV-04 断言：个人 Provider 与内置同 id 时必须去掉 group —— 守住它的位置：personalProviders 的 mapConfigs —— 改错故障：个人分组泄漏到内置域，普通 Provider 被误判为家族成员。
// INV-05 断言：个人 Provider 的模板只在内置不存在时套用 —— 守住它的位置：templatePersonalProviders —— 改错故障：内置模板链被二次覆盖，出现双份互相打架的默认值。
// INV-06 断言：zhipu-account 的 enabled 恒为 true —— 守住它的位置：循环内的 const enabled —— 改错故障：旧覆盖值让无开关账号永久失效，账号从设置页消失。
// INV-07 断言：accessEntitled 只对 zhipu-account 生效 —— 守住它的位置：const accessEntitled —— 改错故障：apiKey Provider 因 entitled 缺省被判未授权，全部模型不可执行。
// INV-08 断言：accountCurrent 用不等于 false 判定 —— 守住它的位置：const accountCurrent —— 改错故障：accountStates 缺省时全部账号被判离线，首次启动无模型可选。
// INV-09 断言：providerExecutable 是四条件合取 —— 守住它的位置：循环内 const providerExecutable —— 改错故障：带 issue 的 Provider 仍发布模型，运行时消费到不完整配置。
// INV-10 断言：个人模型 id 必须剔除与内置重复项 —— 守住它的位置：personalIdsInOrder 的 filter —— 改错故障：同一模型出现两条候选，source 归类错乱。
// INV-11 断言：source 归类以内置 id 集合为准 —— 守住它的位置：候选对象里的 source 三元判断 —— 改错故障：被个人覆盖的内置模型标成 personal，覆盖关系无法解释。
// INV-12 断言：Registry 只收 executable 的模型 —— 守住它的位置：validModels 的 filter —— 改错故障：不可执行模型进入 Registry，调用直接被拒。
// INV-13 断言：没有任何可执行模型时不发布 Provider —— 守住它的位置：validModels.length 为 0 的分支 —— 改错故障：空 Provider 占位，前端出现点进去全空的条目。
// INV-14 断言：Registry 复算失败必须抛错 —— 守住它的位置：模型复算后的 throw —— 改错故障：前序判定与复算口径漂移被静默吞掉，Registry 少模型且无日志。
// INV-15 断言：家族 Provider 固定最前且不参与 ownership 排序 —— 守住它的位置：resolveProviderOrder 的返回拼接 —— 改错故障：家族被个人顺序打散，账号切换顺序错位。
// INV-16 断言：返回值与每个候选对象全部冻结 —— 守住它的位置：各处 Object.freeze —— 改错故障：调用方就地修改共享配置，跨窗口状态互相污染。
//
// 阅读顺序：serialize 系列负责字段白名单，createRegistry 系列是发布门禁，resolve 负责四路合并与三层产出。
// 所有 ConfigValidationIssue 都带完整 path（providers 段加 id 再加 models 段与 modelId），设置页据此定位到具体字段。
// effectiveBuiltin 配置与 config 并存不是冗余：前者是内置默认值快照，用于解释用户实际值覆盖掉了什么。
// 本文件对入参只读，除局部数组外不持有可变状态，因此可被多个窗口并发调用。
// Registry 视图与展示视图刻意分离：前者缺字段即不可发布，后者允许带 issue 展示给用户修正。
// 任何新增字段都必须同时进 zod schema 与 serialize 白名单，否则会在 Registry 侧被静默丢弃。
import type { z } from "zod";
import type { completeModelConfigDataSchema } from "@zcode/shared/model-config";
import type {
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
  completeProviderConfigDataSchema,
} from "./config/provider-data-schema.js";
import type { ConfigValidationIssue } from "./config-overlay.js";
import {
  type ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  type ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderConfig,
  type ProviderConfigRule,
  ProviderConfigMap,
  type ProviderTemplateMap,
  type ProviderId,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type { AccountProviderStates } from "./account-provider-state.js";

// [契约] 交集类型不是装饰：左侧配置类提供行为字段，右侧 zod 推断类型提供「已通过完整校验」的编译期证明。
// [契约] 只有 createRegistry 系列校验通过的实例才允许被断言成 Registry 类型；绕过门禁强转会把 issue 一起带进 Registry。
// [权衡] 这里不做第二次运行时校验：每轮 resolve 只做一次全量 schema 校验，重复校验会拖慢设置页刷新。
export type RegistryZhipuAccountAccessConfig = ZhipuAccountAccessConfig &
  z.infer<typeof completeZhipuAccountAccessDataSchema>;

export type RegistryProviderAccessConfig =
  | (ApiKeyAccessConfig & z.infer<typeof completeApiKeyAccessDataSchema>)
  | RegistryZhipuAccountAccessConfig;

export type RegistryProviderConfig = ProviderConfig &
  z.infer<typeof completeProviderConfigDataSchema> & {
    readonly access: RegistryProviderAccessConfig;
  };

export type RegistryProviderConfigObject = z.infer<typeof completeProviderConfigDataSchema>;

// [契约] 手写白名单而不是展开 config：写入 Registry 的字段集合由 schema 决定，多写一个字段会在读取时被严格校验拒绝。
// [契约] 可选字段（logo、headers、三个成员列表、visibility）用条件展开省掉 undefined，避免把未设置序列化成显式空值。
// [失败路径] access 按 type 分叉：账号分支不写 apiKey，密钥分支不写 accountType 与 mode 与 entitled，两分支字段互斥不可合并。
export function serializeRegistryProviderConfig(
  config: RegistryProviderConfig,
): RegistryProviderConfigObject {
  return {
    group: config.group,
    ...(config.logo === undefined ? {} : { logo: config.logo }),
    access:
      config.access.type !== "zhipu-account"
        ? {
            type: config.access.type,
            apiKey: config.access.apiKey,
            ...(config.access.apiKeyManagementUrl === undefined
              ? {}
              : { apiKeyManagementUrl: config.access.apiKeyManagementUrl }),
          }
        : {
            type: config.access.type,
            accountType: config.access.accountType,
            mode: config.access.mode,
            entitled: config.access.entitled,
          },
    api: {
      type: config.api.type,
      baseUrl: config.api.baseUrl,
      ...(config.api.headers == null ? {} : { headers: config.api.headers }),
    },
    ...(config.builtinModelIds == null ? {} : { builtinModelIds: [...config.builtinModelIds] }),
    ...(config.personalModelIds == null ? {} : { personalModelIds: [...config.personalModelIds] }),
    ...(config.modelOrder == null ? {} : { modelOrder: [...config.modelOrder] }),
    ...(config.visibility === undefined ? {} : { visibility: config.visibility }),
  };
}

export type RegistryModelConfig = ModelConfig & z.infer<typeof completeModelConfigDataSchema>;

export type RegistryModelConfigObject = z.infer<typeof completeModelConfigDataSchema>;

// [契约] 模型字段逐层展开：properties 与 optionSpecs 的每个子键都显式列出，整体展开会把运行时私有字段带进 Registry。
// [契约] 能力位只保留 schema 声明项；新增能力必须先改 schema，否则这里会静默丢弃，UI 读取时永远为假。
// [失败路径] 本函数不校验也不抛错：校验已在 createRegistryModelConfig 完成，这里只对已证明的实例做形状投影。
export function serializeRegistryModelConfig(
  config: RegistryModelConfig,
): RegistryModelConfigObject {
  return {
    enabled: config.enabled,
    properties: {
      requiresMfjsToolSchema: config.properties.requiresMfjsToolSchema,
      contextWindow: config.properties.contextWindow,
      inputFormat: {
        supportsText: config.properties.inputFormat.supportsText,
        supportsImage: config.properties.inputFormat.supportsImage,
        supportsVideo: config.properties.inputFormat.supportsVideo,
        supportsAudio: config.properties.inputFormat.supportsAudio,
        supportsPdf: config.properties.inputFormat.supportsPdf,
      },
      outputFormat: { supportsText: config.properties.outputFormat.supportsText },
      supportsToolCall: config.properties.supportsToolCall,
      supportsJsonSchemaOutput: config.properties.supportsJsonSchemaOutput,
      supportsNativeWebSearch: config.properties.supportsNativeWebSearch,
      supportsMidConversationSystem: config.properties.supportsMidConversationSystem,
    },
    optionSpecs: {
      reasoningLevel: config.optionSpecs.reasoningLevel,
      maxOutputTokens: config.optionSpecs.maxOutputTokens,
    },
  };
}

export type RegistryConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly issues: readonly ConfigValidationIssue[] };

// [契约] 发布门禁唯一入口：validateComplete 返回任何 issue 都让 ok 为 false，调用方不得跳过本函数直接断言 Registry 类型。
// [资源] issues 先复制再冻结：直接冻结上游返回的数组，会让后续校验器 push 时报 TypeError。
// [契约] 默认 path 是 provider 段，resolve 内一律传入带 id 的完整路径覆盖它，保证 issue 能定位到具体条目。
export function createRegistryProviderConfig(
  config: ProviderConfig,
  path: readonly string[] = ["provider"],
): RegistryConfigResult<RegistryProviderConfig> {
  const issues = config.validateComplete(path);
  return issues.length > 0
    ? { ok: false, issues: Object.freeze([...issues]) }
    : { ok: true, config: config as RegistryProviderConfig };
}

// [契约] 与 Provider 版本同构：校验通过就把 ModelConfig 断言为 RegistryModelConfig，否则返回冻结的 issue 列表。
// [权衡] 本函数不合并默认值：模型默认值由 ModelConfigRules.resolve 在调用前完成，职责分离避免出现双份默认值。
export function createRegistryModelConfig(
  config: ModelConfig,
  path: readonly string[] = ["model"],
): RegistryConfigResult<RegistryModelConfig> {
  const issues = config.validateComplete(path);
  return issues.length > 0
    ? { ok: false, issues: Object.freeze([...issues]) }
    : { ok: true, config: config as RegistryModelConfig };
}

// [契约] 内置表同时承载内置与账号覆盖的基底，个人表只做增量覆盖；两者 group 语义不同，不可对调。
// [契约] accountStates 与 accountProviders 分工明确：前者表达当前是否已连接，后者是账号级配置，混用会把离线账号判成无配置。
// [权衡] personalProviderOrder 允许缺省：缺省时按内置序兜底而不是 Map 插入序，保证 UI 顺序在多次刷新间稳定。
export interface ProviderConfigResolverInput {
  readonly zcodeBuiltinProviders: ProviderConfigMap;
  readonly zcodeBuiltinProviderTemplates?: ProviderTemplateMap;
  readonly personalProviders: ProviderConfigMap;
  readonly zcodeBuiltinModelRules: ModelConfigRules;
  readonly personalModels: ModelConfigRules;
  readonly accountProviders: ProviderConfigMap;
  readonly accountStates?: AccountProviderStates;
  readonly personalProviderOrder?: readonly ProviderId[];
}

// [契约] enabled、executable、selectable 是递进三态而非同义词：开关、Provider 门禁与 issue、再加 visibility 隐藏。
// [契约] effectiveBuiltinConfig 与 config 必须同时保留：删掉前者，UI 就无法解释哪些字段被用户覆盖。
// [资源] issues 与对象本身都已冻结，调用方不得改写，否则同一模型在不同视图里的归类会不一致。
export interface ResolvedProviderModelCandidate {
  readonly kind: "candidate";
  readonly modelId: ModelId;
  readonly source: "builtin" | "personal";
  readonly config: ModelConfig;
  readonly effectiveBuiltinConfig: ModelConfig;
  readonly issues: readonly ConfigValidationIssue[];
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly selectable: boolean;
}

export type ResolvedProviderModel = ResolvedProviderModelCandidate;

export interface ResolvedProvider extends Pick<ProviderConfigRule, "templateId" | "providerName"> {
  readonly enabled: boolean;
  readonly providerId: ProviderId;
  readonly config: ProviderConfig;
  readonly templateConfig?: ProviderConfig;
  readonly effectiveBuiltinConfig?: ProviderConfig;
  readonly providerIssues: readonly ConfigValidationIssue[];
  readonly models: readonly ResolvedProviderModel[];
}

export interface ProviderModel {
  readonly modelId: ModelId;
  readonly config: RegistryModelConfig;
}

export interface Provider extends Pick<ProviderConfigRule, "templateId" | "providerName"> {
  readonly providerId: ProviderId;
  readonly config: RegistryProviderConfig;
  readonly models: readonly ProviderModel[];
}

// [契约] 三个 Provider 集合口径不同：effective 是全部合并结果，resolved 是带 issue 的展示项，registry 才是可发布项。
// [失败路径] issues 是全局扁平列表且顺序等于遍历顺序；不要在此去重，否则同一模型的多条错误会丢失定位信息。
// [契约] 返回对象整体冻结，调用方只能读；需要派生数据应重新 resolve，而不是就地修改这些 Map。
export interface ProviderConfigResolution {
  readonly effectiveBuiltinProviders: ProviderConfigMap;
  readonly effectiveProviders: ProviderConfigMap;
  readonly resolvedProviders: readonly ResolvedProvider[];
  readonly registryProviders: readonly Provider[];
  readonly issues: readonly ConfigValidationIssue[];
}

export class ProviderConfigResolver {
  resolve(input: ProviderConfigResolverInput): ProviderConfigResolution {
    // [事务] 先过滤再 withoutGroup：只有内置表里存在的 id 才能参与覆盖，未知账号 Provider 直接丢弃而不报错。
    // [契约] withoutGroup 必须在覆盖前调用：账号携带的 group 会让普通 Provider 被 resolveProviderOrder 误判为家族成员。
    // [权衡] 这里静默丢弃而非产出 issue：账号数据可能来自旧版本，噪声不应阻塞整个设置页加载。
    const accountProviders = new ProviderConfigMap(
      input.accountProviders
        .entries()
        .filter(([providerId]) => input.zcodeBuiltinProviders.has(providerId))
        .map(([providerId, config]) => [providerId, config.withoutGroup()] as const),
    );
    const concreteBuiltinProviders = input.zcodeBuiltinProviders.overlay(accountProviders);
    const providerTemplates = input.zcodeBuiltinProviderTemplates;
    // [权衡] 覆盖方向固定为模板在下、实际值在上：反过来会让账号与内置配置被模板默认值覆盖。
    // [契约] 只有 rule.templateId 存在时才查模板，无模板的 Provider 必须原样返回，不能被塞入默认值。
    // [失败路径] 模板缺失在此不报错，留给后面的 missing-template issue，保证展示视图仍能列出该 Provider。
    const effectiveBuiltinProviders = concreteBuiltinProviders.mapConfigs((concrete, _id, rule) => {
      const template = rule.templateId
        ? providerTemplates?.get(rule.templateId)?.config
        : undefined;
      return template ? template.overlay(concrete) : concrete;
    });
    // [契约] 个人 Provider 与内置同 id 时必须去掉 group：个人分组只对纯个人 Provider 有意义，否则会改写内置家族排序。
    // [事务] 判断依据用已含模板的 effectiveBuiltinProviders，而不是原始内置表，避免模板新增 id 时漏判。
    // [权衡] 这里不去重也不改 id：同 id 的合并交给后面的 overlay，保证每一步都能独立解释。
    const personalProviders = input.personalProviders.mapConfigs((config, providerId) =>
      effectiveBuiltinProviders.has(providerId) ? config.withoutGroup() : config,
    );
    // [契约] 个人模板只对内置不存在的 Provider 生效：内置已带模板链，再套一次会产生互相覆盖的双份默认值。
    // [契约] 覆盖方向同样是模板在下、个人值在上，用户值必须赢过模板默认值。
    // [失败路径] templateId 指向不存在的模板时静默回退原值，issue 由后续 Provider 校验统一产出。
    const templatePersonalProviders = personalProviders.mapConfigs((personal, providerId, rule) => {
      if (effectiveBuiltinProviders.has(providerId)) return personal;
      const template = rule.templateId
        ? providerTemplates?.get(rule.templateId)?.config
        : undefined;
      return template ? template.overlay(personal) : personal;
    });
    // [事务] 合并顺序不可交换：内置（含账号）为底，个人覆盖在上，产出的 effectiveProviders 是所有视图的唯一事实源。
    // [契约] overlay 只增改不删：个人想停用某个 Provider 应改 enabled，而不是把条目移除。
    // [权衡] 先合完再统一校验：合并过程中不校验中间态，避免同一 issue 被多层重复上报。
    const effectiveProviders = effectiveBuiltinProviders.overlay(templatePersonalProviders);
    const effectiveModelRules = ModelConfigRules.composeEffective(
      input.zcodeBuiltinModelRules,
      input.personalModels,
    );
    const issues: ConfigValidationIssue[] = [];
    const resolvedProviders: ResolvedProvider[] = [];
    const registryProviders: Provider[] = [];

    // [并发] 循环体内不 await、不触碰外部 IO，整个 resolve 是同步纯函数，可被多个窗口并发调用而无需加锁。
    // [契约] 遍历顺序由 resolveProviderOrder 决定，循环体不得按键排序或重排，否则展示顺序与 Registry 顺序不一致。
    // [契约] issues 的追加顺序就是最终展示顺序，新增 push 点必须保持 Provider 在前、模型在后的层次。
    for (const providerId of resolveProviderOrder(input, effectiveProviders)) {
      const rule = effectiveProviders.getRule(providerId)!;
      const { config, providerName } = rule;
      // 账号不再支持总禁用；旧覆盖值不能让无开关的账号永久失效，其他资格仍正常校验。
      // [契约] 账号 Provider 恒为启用：账号不再支持总禁用，旧的 rule.enabled 为 false 不能让无开关的账号永久失效。
      // [契约] 只有非账号 Provider 才读 rule.enabled，缺省按 true 处理，维持默认开启的产品语义。
      // [失败路径] 不要在这里叠加权益或连接判断，那属于 executable；混进来会让展示视图错误隐藏账号。
      const enabled = config.access?.type === "zhipu-account" || (rule.enabled ?? true);
      const providerPath = ["providers", providerId];
      const registryProviderResult = createRegistryProviderConfig(config, providerPath);
      const providerIssues: ConfigValidationIssue[] = registryProviderResult.ok
        ? []
        : [...registryProviderResult.issues];
      const templateId = rule.templateId ?? undefined;
      const templateConfig = templateId ? providerTemplates?.get(templateId)?.config : undefined;
      // [失败路径] 模板缺失单独上报 missing-template，而不是让字段校验报一堆缺失，后者会淹没真正原因。
      // [契约] issue 路径精确到 templateId 字段，设置页可据此高亮到具体输入框。
      // [契约] 该 issue 让 providerIssues 非空，进而不可执行且不发布 Registry，但 Provider 仍留在展示视图。
      if (templateId && !templateConfig) {
        providerIssues.push({
          code: "missing-template",
          path: [...providerPath, "templateId"],
          message: `Provider Template 不存在: ${templateId}`,
        });
      }
      issues.push(...providerIssues);
      const builtinModelIds = config.builtinModelIds ?? [];
      const personalModelIds = config.personalModelIds ?? [];
      const builtinIdsInOrder = uniqueInOrder(builtinModelIds);
      const builtinIds = new Set(builtinIdsInOrder);
      const personalIdsInOrder = uniqueInOrder(personalModelIds).filter(
        (modelId) => !builtinIds.has(modelId),
      );
      // [契约] 顺序三段式：未列出的内置 id 在前，显式顺序居中，未列出的个人 id 在后，保证新增内置不会被挤到末尾。
      // [契约] 个人段已剔除内置重复，modelOrder 只负责位置；指向已删除模型的 id 会被过滤掉，不会凭空造出条目。
      // [权衡] 不在此处过滤空 id 或越界 id：上游构造已保证 id 合法，重复校验只会增加每次刷新的开销。
      const orderedModelIds = resolveOwnedOrder(
        builtinIdsInOrder,
        personalIdsInOrder,
        config.modelOrder ?? [],
      );
      // [契约] 权益判断只对账号 Provider 生效：密钥类没有 entitled 字段，用缺省值判定会把正常配置误判为未授权。
      // [契约] 要求严格的布尔真值，其他真值一律视为未授权，防止旧数据里的字符串混入。
      // [失败路径] 未授权只影响 executable，不影响 enabled 与展示，权益过期时用户仍能看到并修改配置。
      const accessEntitled =
        config.access?.type !== "zhipu-account" || config.access.entitled === true;
      // 账号权益与当前连接是两件事。非当前账号仍保留设置展示，不向普通 Registry 发布模型。
      // Off-Peak 不定义 current，沿用其独立调度、隐藏和鉴权规则。
      // [契约] 用不等于 false 而非真值判断：accountStates 缺省时视为当前账号，否则首次启动会把所有账号模型判成不可执行。
      // [契约] Off-Peak 不写 current 字段，沿用独立调度与鉴权，本判断不能改成读取其他状态位。
      // [权衡] 连接状态与权益分开计算，合并成一个布尔值后就无法区分没买和没连。
      const accountCurrent = input.accountStates?.[providerId]?.current !== false;
      const providerExecutable =
        enabled && accessEntitled && accountCurrent && providerIssues.length === 0;
      // [并发] map 内全部是同步纯计算，不得引入 await 或缓存写入，否则同一 Provider 的模型会出现半更新状态。
      // [契约] 每个模型都重新 resolve 两份配置，不跨 Provider 复用，避免模板上下文串味。
      // [资源] 返回前对每个候选冻结，防止下游 store 直接改写导致跨窗口状态污染。
      const models = orderedModelIds.map((modelId): ResolvedProviderModel => {
        const modelConfig = effectiveModelRules.resolve({
          providerId,
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        });
        const effectiveBuiltinConfig = input.zcodeBuiltinModelRules.resolve({
          providerId,
          templateId,
          modelId,
          apiType: config.api?.type,
          baseUrl: config.api?.baseUrl,
        });
        const registryModelResult = createRegistryModelConfig(modelConfig, [
          ...providerPath,
          "models",
          modelId,
        ]);
        const modelIssues = registryModelResult.ok ? [] : registryModelResult.issues;
        issues.push(...modelIssues);
        const modelEnabled = modelConfig.enabled === true;
        // [契约] executable 是三个条件的与：Provider 可执行、模型已启用、模型 issue 为空，缺一不可发布。
        // [失败路径] 模型 issue 只影响自身，不把整个 Provider 拉黑，保证一个坏模型不隐藏同 Provider 的其他模型。
        // [契约] Provider 条件已在循环外算好，这里只做与运算，不要在模型层重复检查 Provider 条件。
        const executable = providerExecutable && modelEnabled && modelIssues.length === 0;
        const selectable = executable && config.visibility !== "hidden";
        return Object.freeze({
          kind: "candidate",
          modelId,
          source: builtinIds.has(modelId) ? "builtin" : "personal",
          config: modelConfig,
          effectiveBuiltinConfig,
          issues: Object.freeze(modelIssues),
          enabled: modelEnabled,
          executable,
          selectable,
        });
      });

      // [契约] 展示视图必须收录带 issue 的 Provider：providerIssues 原样冻结保留，用户需要看到错误才能修复。
      // [契约] templateConfig 与 effectiveBuiltinConfig 都用条件展开，缺省时不写键，避免下游用存在性判断误命中。
      // [契约] effectiveBuiltinConfig 取合并后的内置配置（含模板），用于解释用户值与内置默认值的差异。
      const resolvedProvider = Object.freeze({
        providerId,
        enabled,
        providerName,
        templateId,
        config,
        ...(templateConfig ? { templateConfig } : {}),
        ...(effectiveBuiltinProviders.get(providerId)
          ? { effectiveBuiltinConfig: effectiveBuiltinProviders.get(providerId) }
          : {}),
        providerIssues: Object.freeze([...providerIssues]),
        models: Object.freeze(models),
      });
      resolvedProviders.push(resolvedProvider);

      // [失败路径] 两道门禁任一失败就跳过：Provider 级校验失败或存在 Provider issue，都不允许进入 Registry。
      // [契约] 跳过 Registry 不等于跳过展示，resolvedProviders 已在上方写入，两处顺序不可调换。
      // [权衡] 这里不抛错：单个 Provider 配置不完整属于可恢复，只有内部口径不一致才抛错。
      if (!registryProviderResult.ok || providerIssues.length > 0) {
        continue;
      }
      const validModels = models
        .filter((model) => model.executable)
        .map(({ modelId, config: modelConfig }) => {
          const result = createRegistryModelConfig(modelConfig, [
            ...providerPath,
            "models",
            modelId,
          ]);
          // [失败路径] 走到这里说明刚才判为可执行的模型复算失败，属于内部口径漂移，必须抛错暴露而不是跳过。
          // [契约] 用同一参数调用同一门禁，理论上结果必然一致；不一致只能来自校验判定被外部改动。
          // [失败路径] 抛错比静默跳过安全：静默会让 Registry 少一个模型，且没有任何线索可查。
          if (!result.ok)
            throw new Error(`Registry Model 完整性结果不一致: ${providerId}/${modelId}`);
          return Object.freeze({ modelId, config: result.config });
        });
      if (validModels.length === 0) continue;
      registryProviders.push(
        Object.freeze({
          providerId,
          providerName,
          templateId,
          config: registryProviderResult.config,
          models: Object.freeze(validModels),
        }),
      );
    }

    // [资源] 返回值一次性冻结：Map 与数组都是新建实例，冻结既不影响入参，也阻止调用方回写。
    // [契约] 五个字段口径固定，新增字段需同步所有消费方，否则会出现有数据但读不到的隐性缺失。
    return Object.freeze({
      effectiveBuiltinProviders,
      effectiveProviders,
      resolvedProviders: Object.freeze(resolvedProviders),
      registryProviders: Object.freeze(registryProviders),
      issues: Object.freeze(issues),
    });
  }
}

function uniqueInOrder(modelIds: readonly ModelId[]): readonly ModelId[] {
  const seen = new Set<ModelId>();
  return modelIds.filter((modelId) => {
    if (seen.has(modelId)) return false;
    seen.add(modelId);
    return true;
  });
}

// [契约] 排序分三段且互斥：家族固定最前，其后是内置 id，最后是个人 id，三段不允许交叉。
// [契约] 家族判定依据是合并后的 group，而不是 id 前缀，Provider 改名不会影响归属。
// [契约] 内置与个人各自用集合过滤，同一 id 只能出现在一段，否则列表会重复渲染。
// [权衡] 家族不参与 ownership 排序：账号切换顺序由家族内部规则决定，个人排序不应打散它们。
function resolveProviderOrder(
  input: ProviderConfigResolverInput,
  effectiveProviders: ProviderConfigMap,
): readonly ProviderId[] {
  const sourceIds = effectiveProviders.keys();
  const familyIds = sourceIds.filter((providerId) => {
    const group = effectiveProviders.get(providerId)?.group;
    return group === "zai-family" || group === "bigmodel-family";
  });
  const familySet = new Set(familyIds);
  const builtinIds = input.zcodeBuiltinProviders
    .keys()
    .filter((providerId) => !familySet.has(providerId));
  const builtinSet = new Set(builtinIds);
  const personalIds = input.personalProviders
    .keys()
    .filter((providerId) => !builtinSet.has(providerId) && !familySet.has(providerId));
  return [
    ...familyIds,
    ...resolveOwnedOrder(builtinIds, personalIds, input.personalProviderOrder ?? []),
  ];
}
