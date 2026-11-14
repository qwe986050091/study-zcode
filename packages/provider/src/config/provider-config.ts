/* oxlint-disable eslint(max-lines) -- Provider 与 Access Config 的 Overlay/序列化必须集中维护同一联合类型；待契约稳定后再按配置族拆文件。 */
// Provider 配置域：Overlay 合并、访问配置联合体与 Provider/Template 索引的唯一归口。
// 职责边界：
//   只定义不可变配置对象及其合并、校验、序列化语义；本文件不读磁盘、不发网络请求、不决定落盘时机。
//   保存编排、凭据解析、模型注册表都在上层；本文件只保证覆盖顺序、回退值与 JSON 投影稳定。
//   准入校验与保存校验共用 provider-data-schema 的 schema，不在此另起一套字段判断。
//   Provider 是实际配置，ProviderTemplate 是元数据壳，两个身份空间不允许互相写入。
//
// INV 不变量表：
// INV-01 断言：所有配置类构造完成后冻结，字段只读 —— 守住它的位置：各构造函数末尾的冻结 —— 改错故障：某处缓存复用同一实例并原地改字段，两个窗口读到不同配置。
// INV-02 断言：undefined 表示未声明，合并时保留当前值 —— 守住它的位置：ConfigOverlay 的 overlayValue 与各 overlay 方法 —— 改错故障：上游只下发部分字段时，已有配置被默认值清空。
// INV-03 断言：access 的 null 是显式清空，undefined 才是缺省 —— 守住它的位置：overlayProviderAccess 的前两个判断 —— 改错故障：清空凭据后旧 Key 仍参与请求，账号串用。
// INV-04 断言：access 按 type 分派，type 不同整体替换 —— 守住它的位置：overlayProviderAccess 的类型比较分支 —— 改错故障：apiKey 与 accountType 混存在同一对象，校验通过但请求用错凭据。
// INV-05 断言：Key 判定同时认 api-key 与 zhipu-coding-plan-api-key，排除 zhipu-account —— 守住它的位置：isApiKeyAccess 的返回条件 —— 改错故障：套餐 Key 被当普通 Key 保存，管理 URL 被覆盖。
// INV-06 断言：接口 headers 构造时浅拷贝再冻结 —— 守住它的位置：ProviderApiConfig 构造函数 —— 改错故障：共享 headers 对象被一处修改，所有引用它的 Provider 请求头同时变化。
// INV-07 断言：api 子对象合并时深合并，未声明字段保留 —— 守住它的位置：ProviderConfig 合并时的 overlayConfig 调用 —— 改错故障：只改 baseUrl 的一次保存把 headers 整体重置。
// INV-08 断言：序列化过滤 undefined，保留空串与 null —— 守住它的位置：objectWithoutUndefined 与各序列化方法 —— 改错故障：产物出现 undefined 键，回读产生伪变更与无意义广播。
// INV-09 断言：成员继承只取 source 的三个成员字段 —— 守住它的位置：withModelMembershipFrom 的构造入参 —— 改错故障：保存普通字段时按旧快照回滚成员，刚添加的模型消失。
// INV-10 断言：成员写入统一走合并，不带其它字段 —— 守住它的位置：三个 with 成员方法 —— 改错故障：更新排序时把个人模型列表清空。
// INV-11 断言：移除分组时保留 logo、access、api 与三个成员字段 —— 守住它的位置：withoutGroup 的构造入参 —— 改错故障：移除分组顺带丢掉凭据，Provider 直接不可用。
// INV-12 断言：模型 id 逐个 trim 且拒绝空串 —— 守住它的位置：freezeModelIds 的空串抛错分支 —— 改错故障：空 id 进入索引，按 id 查模型得到 undefined。
// INV-13 断言：两个索引类都拒绝重复 key —— 守住它的位置：两个构造函数的重复键检查 —— 改错故障：重复 key 静默覆盖，模板或 Provider 悄然少一条。
// INV-14 断言：两个索引的合并只增改不删，未出现的 id 保留 —— 守住它的位置：两个索引类的 overlay 方法 —— 改错故障：增量下发被当作全量，内置模板或 Provider 消失。
// INV-15 断言：同 id 合并时 config 也走嵌套合并 —— 守住它的位置：ProviderConfigMap 合并的当前值分支 —— 改错故障：部分更新把 config 整体替换，未下发字段丢失。
// INV-16 断言：重排先按入参去重排序，再追加剩余 id —— 守住它的位置：重排方法的两段循环 —— 改错故障：一次拖拽排序丢掉未在列表中的 Provider。
//
// 阅读提示：先看 INV，再看各类的 overlay 与序列化；两者是对偶的，只改一侧必然漂移。
// INV 编号在评审与注释中被引用，只增不改；新增不变量追加编号，不复用旧号。
//
import { ConfigOverlay, type ConfigValidationIssue } from "../config-overlay.js";
import type { z } from "zod";
import {
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
  completeProviderApiDataSchema,
  completeProviderConfigDataSchema,
  type providerApiTypeDataSchema,
  type providerGroupDataSchema,
  type zhipuAccountModeDataSchema,
  type providerVisibilityDataSchema,
  type providerLogoDataSchema,
  type apiKeyAccessDataSchema,
  type zhipuAccountAccessDataSchema,
  type providerAccessDataSchema,
  type providerApiDataSchema,
  type providerConfigDataSchema,
  type providerTemplateNameMapDataSchema,
  type providerTemplateDataSchema,
} from "./provider-data-schema.js";
import { validateConfigSchema } from "./schema-validation.js";
import type { ModelId, ProviderId, ProviderTemplateId } from "./ids.js";
import type { ProviderConfigRuleData } from "./rule-data-schema.js";

export type ProviderApiType = z.infer<typeof providerApiTypeDataSchema>;
export type ProviderGroup = z.infer<typeof providerGroupDataSchema>;
export type ZhipuAccountMode = z.infer<typeof zhipuAccountModeDataSchema>;

// [契约] 输入类型用交叉类型放宽 type，对象类型保持 type 必填。
// 看起来该把两者合并成一个类型，其实不能：调用方构造时省略 type，靠构造函数补默认值。
// 默认值只落在构造函数的 api-key 兜底，类型层不重复声明，两处必须保持一致。
// 改错后：新建的手动 Key 没有 type，序列化缺字段，complete 校验直接判失败，保存全线中断。
export type ApiKeyAccessConfigInput = Omit<ApiKeyAccessConfigObject, "type"> & {
  readonly type?: ApiKeyAccessConfigObject["type"];
};

export type ApiKeyAccessConfigObject = Readonly<z.infer<typeof apiKeyAccessDataSchema>>;

export class ApiKeyAccessConfig extends ConfigOverlay<ApiKeyAccessConfig> {
  readonly type: ApiKeyAccessConfigObject["type"];
  readonly apiKey?: ApiKeyAccessConfigInput["apiKey"];
  readonly apiKeyManagementUrl?: ApiKeyAccessConfigInput["apiKeyManagementUrl"];

  // [契约] 构造函数只落默认 type 与三个字段原值，不 trim、不校验、不抛错。
  // 看起来该在构造时校验 Key 非空，其实不能：空 access 仍表示已声明但未填写的中间态。
  // 值域校验只在 validateComplete 里由 zod 的 complete schema 做一次。
  // 改错后：草稿态 Provider 一保存就失败，用户无法先建 Provider 后补 Key。
  constructor(input: ApiKeyAccessConfigInput = {}) {
    super();
    this.type = input.type ?? "api-key";
    this.apiKey = input.apiKey;
    this.apiKeyManagementUrl = input.apiKeyManagementUrl;
    Object.freeze(this);
  }

  // [事务] 字段级合并：next 未声明的字段保留当前值，type 直接取 next。
  // 看起来该让非空 apiKey 优先，其实不能：空串是用户主动清除，必须能覆盖旧值。
  // 覆盖判断只认 undefined，空串与 undefined 的语义在这里必须分开。
  // 改错后：用户把 Key 清空后旧 Key 仍生效，或未提交字段被上游默认值回填。
  overlay(next: ApiKeyAccessConfig): ApiKeyAccessConfig {
    return new ApiKeyAccessConfig({
      type: next.type,
      apiKey: this.overlayValue(this.apiKey, next.apiKey),
      apiKeyManagementUrl: this.overlayValue(this.apiKeyManagementUrl, next.apiKeyManagementUrl),
    });
  }

  // [失败路径] 校验用 complete schema，返回问题列表而不抛异常。
  // 看起来该抛错让调用方早失败，其实不能：准入与保存都要一次性收集全部问题。
  // path 由调用方逐层拼接，本类只在末尾透传，不自行补前缀。
  // 改错后：首个错误就中断，表单只报一条，用户要反复保存才发现全部问题。
  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeApiKeyAccessDataSchema, this.toJSON(), path);
  }

  toJSON(): ApiKeyAccessConfigObject {
    return {
      type: this.type,
      ...objectWithoutUndefined({
        apiKey: this.apiKey,
        apiKeyManagementUrl: this.apiKeyManagementUrl,
      }),
    };
  }
}

export type ZhipuAccountAccessConfigInput = Omit<ZhipuAccountAccessConfigObject, "type">;

export type ZhipuAccountAccessConfigObject = Readonly<z.infer<typeof zhipuAccountAccessDataSchema>>;

export class ZhipuAccountAccessConfig extends ConfigOverlay<ZhipuAccountAccessConfig> {
  readonly type = "zhipu-account" as const;
  readonly accountType?: ZhipuAccountAccessConfigInput["accountType"];
  readonly mode?: ZhipuAccountAccessConfigInput["mode"];
  readonly entitled?: ZhipuAccountAccessConfigInput["entitled"];

  constructor(input: ZhipuAccountAccessConfigInput = {}) {
    super();
    this.accountType = input.accountType;
    this.mode = input.mode;
    this.entitled = input.entitled;
    Object.freeze(this);
  }

  overlay(next: ZhipuAccountAccessConfig): ZhipuAccountAccessConfig {
    return new ZhipuAccountAccessConfig({
      accountType: this.overlayValue(this.accountType, next.accountType),
      mode: this.overlayValue(this.mode, next.mode),
      entitled: this.overlayValue(this.entitled, next.entitled),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return validateConfigSchema(completeZhipuAccountAccessDataSchema, this.toJSON(), path);
  }

  toJSON(): ZhipuAccountAccessConfigObject {
    return {
      type: this.type,
      ...objectWithoutUndefined({
        accountType: this.accountType,
        mode: this.mode,
        entitled: this.entitled,
      }),
    };
  }
}

export type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;

export type ProviderAccessConfigObject = Readonly<z.infer<typeof providerAccessDataSchema>>;

/** 手动 Key 的编辑/保存共用能力判断，不把套餐 Key 误写成普通 API Key。 */
// [契约] 判定同时匹配 api-key 与 zhipu-coding-plan-api-key，排除 zhipu-account。
// 看起来该把套餐 Key 拆成独立判定，其实不能：编辑与保存共用同一条路径。
// 只看 type 取值，不做实例类型判断，避免跨包双实例让类型守卫失效。
// 改错后：套餐 Key 被当普通 Key 编辑，管理 URL 被清空，用户换不了 Key。
export function isApiKeyAccess<T extends { readonly type: string }>(
  access: T | null | undefined,
): access is Extract<T, { readonly type: ApiKeyAccessConfigObject["type"] }> {
  return access?.type === "api-key" || access?.type === "zhipu-coding-plan-api-key";
}

export type ProviderVisibility = z.infer<typeof providerVisibilityDataSchema>;

export type ProviderLogoRef = Readonly<z.infer<typeof providerLogoDataSchema>>;

export type ProviderApiConfigInput = Readonly<z.infer<typeof providerApiDataSchema>>;

export class ProviderApiConfig extends ConfigOverlay<ProviderApiConfig> {
  readonly type?: ProviderApiConfigInput["type"];
  readonly baseUrl?: ProviderApiConfigInput["baseUrl"];
  readonly headers?: ProviderApiConfigInput["headers"];

  // [资源] 构造时对 headers 浅拷贝再冻结，其余字段直接引用。
  // 看起来该省掉这次拷贝，其实不能：headers 常量常被多个 Provider 复用。
  // 冻结只保护一层，值必须是字符串，这由 schema 保证。
  // 改错后：一处修改共享 headers 对象，所有引用它的 Provider 请求头同时变化，被网关拒绝。
  constructor(input: ProviderApiConfigInput = {}) {
    super();
    this.type = input.type;
    this.baseUrl = input.baseUrl;
    this.headers = input.headers ? Object.freeze({ ...input.headers }) : input.headers;
    Object.freeze(this);
  }

  // [事务] type、baseUrl、headers 各自合并，headers 是整体替换而不是逐 key 合并。
  // 看起来该按 header 名合并，其实不能：删除某个 header 只能靠整体替换表达。
  // 要保留旧头必须由上游先合并再传入，本层不猜意图。
  // 改错后：删掉的认证头仍在请求里，鉴权失败却不报配置错误，排查落在网络层。
  overlay(next: ProviderApiConfig): ProviderApiConfig {
    return new ProviderApiConfig({
      type: this.overlayValue(this.type, next.type),
      baseUrl: this.overlayValue(this.baseUrl, next.baseUrl),
      headers: this.overlayValue(this.headers, next.headers),
    });
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    // 旧检查只判断 type 非空，不可信 JS 值可绕过枚举；准入与保存共用 schema。
    return validateConfigSchema(completeProviderApiDataSchema, this.toJSON(), path);
  }

  toJSON(): ProviderApiConfigInput {
    return objectWithoutUndefined({
      type: this.type,
      baseUrl: this.baseUrl,
      headers: this.headers,
    });
  }
}

export type ProviderConfigInput = Omit<ProviderConfigObject, "access" | "api"> & {
  readonly access?: ProviderAccessConfig | null;
  readonly api?: ProviderApiConfig | null;
};

export type ProviderConfigObject = Readonly<z.infer<typeof providerConfigDataSchema>>;

// [契约] ProviderConfig 字段全部可选，access 与 api 持有类实例，序列化时才展开。
// 看起来该在这里持有 providerId 与 providerName，其实不能：身份在外层 rule。
// 本类只管配置内容，身份与模板来源由 ProviderConfigMap 的 rule 承担。
// 改错后：同一份 config 挂到两个 providerId 上，改一个另一个跟着变。
export class ProviderConfig extends ConfigOverlay<ProviderConfig> {
  readonly group?: ProviderConfigObject["group"];
  readonly logo?: ProviderConfigObject["logo"];
  readonly access?: ProviderAccessConfig | null;
  readonly api?: ProviderApiConfig | null;
  readonly builtinModelIds?: ProviderConfigObject["builtinModelIds"];
  readonly personalModelIds?: ProviderConfigObject["personalModelIds"];
  readonly modelOrder?: ProviderConfigObject["modelOrder"];
  readonly visibility?: ProviderConfigObject["visibility"];

  // [契约] 构造时递归冻结 logo 与三个 modelId 数组，其余字段保持原引用。
  // 看起来该深拷贝所有字段，其实不能：access 与 api 是带合并语义的实例，拷贝会丢原型。
  // freezeModelIds 同时做 trim 与空值拒绝，所有写入路径都必须经过它。
  // 改错后：绕过构造塞入 modelId 数组，空串进入索引，按 id 查模型得到 undefined。
  constructor(input: ProviderConfigInput = {}) {
    super();
    this.group = input.group;
    this.logo = freezeProviderLogo(input.logo);
    this.access = input.access;
    this.api = input.api;
    this.builtinModelIds = freezeModelIds(input.builtinModelIds);
    this.personalModelIds = freezeModelIds(input.personalModelIds);
    this.modelOrder = freezeModelIds(input.modelOrder);
    this.visibility = input.visibility;
    Object.freeze(this);
  }

  // [事务] access 走 overlayProviderAccess，可清空、可按 type 换实现；api 走 overlayConfig 深合并。
  // 看起来两个字段该用同一种合并方式，其实不能：凭据是原子整体，接口是部分更新。
  // 其余标量与数组字段用 overlayValue，undefined 一律保留当前值。
  // 改错后：清空凭据被保留旧值吞掉，或只改 baseUrl 时 headers 被整体重置。
  overlay(next: ProviderConfig): ProviderConfig {
    return new ProviderConfig({
      group: this.overlayValue(this.group, next.group),
      logo: this.overlayValue(this.logo, next.logo),
      access: overlayProviderAccess(this.access, next.access),
      api: this.overlayConfig(this.api, next.api),
      builtinModelIds: this.overlayValue(this.builtinModelIds, next.builtinModelIds),
      personalModelIds: this.overlayValue(this.personalModelIds, next.personalModelIds),
      modelOrder: this.overlayValue(this.modelOrder, next.modelOrder),
      visibility: this.overlayValue(this.visibility, next.visibility),
    });
  }

  // [权衡] 三个成员写入方法都构造最小增量对象再合并，不整体重建当前配置。
  // 看起来该连 group 与 access 一起传，其实不能：合并只覆盖目标字段，其余自动继承。
  // 因此三个方法的调用顺序无关，互不覆盖。
  // 改错后：withBuiltinModelIds 的 overlay 若整体重建，userModels 会被清空，用户自选模型全部消失。
  withBuiltinModelIds(builtinModelIds: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ builtinModelIds }));
  }

  withPersonalModelIds(modelIds: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ personalModelIds: modelIds }));
  }

  withModelOrder(modelOrder: readonly ModelId[]): ProviderConfig {
    return this.overlay(new ProviderConfig({ modelOrder }));
  }

  withoutGroup(): ProviderConfig {
    return new ProviderConfig({
      logo: this.logo,
      access: this.access,
      api: this.api,
      builtinModelIds: this.builtinModelIds,
      personalModelIds: this.personalModelIds,
      modelOrder: this.modelOrder,
      visibility: this.visibility,
    });
  }

  /** 普通 Provider 字段保存不拥有成员变更；成员只能由明确的领域操作更新。 */
  // [契约] 只从 source 取三个成员字段，group、logo、access、api、visibility 一律取当前值。
  // 看起来可以用 source 整体替换，其实不能：普通字段保存不拥有成员变更权。
  // source 为 undefined 时三个成员字段变空，等价于放弃继承。
  // 改错后：保存 Provider 名称时按旧快照回滚成员，刚添加的模型丢失。
  withModelMembershipFrom(source: ProviderConfig | undefined): ProviderConfig {
    return new ProviderConfig({
      group: this.group,
      logo: this.logo,
      access: this.access,
      api: this.api,
      builtinModelIds: source?.builtinModelIds,
      personalModelIds: source?.personalModelIds,
      modelOrder: source?.modelOrder,
      visibility: this.visibility,
    });
  }

  // [失败路径] 本类的 complete schema 只校验已声明字段的值域，不用字段存在性代替。
  // 看起来该把 logo 与 visibility 设为必填，其实不能：展示与成员字段不参与执行，必填会挡住历史配置。
  // 校验输入是序列化结果，undefined 已被过滤，schema 看到的都是显式值。
  // 改错后：老配置因缺 logo 无法保存，或被写入默认图标覆盖用户自定义。
  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    // 不再用字段存在性代替值域验证，也不把展示/成员等可选字段变成执行必填项。
    return validateConfigSchema(completeProviderConfigDataSchema, this.toJSON(), path);
  }

  toJSON(): ProviderConfigObject {
    return objectWithoutUndefined({
      group: this.group,
      logo: this.logo,
      access: this.access?.toJSON() ?? this.access,
      api: this.api?.toJSON() ?? this.api,
      builtinModelIds: this.builtinModelIds,
      personalModelIds: this.personalModelIds,
      modelOrder: this.modelOrder,
      visibility: this.visibility,
    });
  }
}

export type ProviderTemplateNameMap = Readonly<z.infer<typeof providerTemplateNameMapDataSchema>>;
export type ProviderTemplateLocale = keyof ProviderTemplateNameMap;

export type ProviderTemplateInput = Omit<ProviderTemplateObject, "config"> & {
  readonly config: ProviderConfig;
};

export type ProviderTemplateObject = Readonly<z.infer<typeof providerTemplateDataSchema>>;

/** Template 是元数据与 Provider Overlay 的领域壳，本身不是 Provider。 */
// [契约] Template 只持有 templateId、名称映射与 config，是元数据壳。
// 看起来可以继承 ProviderConfig 复用字段，其实不能：Template 永不进入 Provider Registry。
// 名称映射构造时浅拷贝并冻结，config 直接引用 ProviderConfig 实例。
// 改错后：Template 被当成真实 Provider 注册，模型列表出现不可调用的条目。
export class ProviderTemplate {
  readonly templateId: ProviderTemplateId;
  readonly templateNameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfig;

  constructor(input: ProviderTemplateInput) {
    this.templateId = input.templateId;
    this.templateNameMap = Object.freeze({ ...input.templateNameMap });
    this.config = input.config;
    Object.freeze(this);
  }

  toJSON(): ProviderTemplateObject {
    return {
      templateId: this.templateId,
      templateNameMap: this.templateNameMap,
      config: this.config.toJSON(),
    };
  }
}

// [契约] 名称回退顺序是 locale、en-US、templateId，逐级 trim 后判空。
// 看起来该回退到第一个非空语言，其实不能：顺序不稳定会让同一模板在不同环境显示不同名字。
// templateId 是最终兜底，保证永不返回空串。
// 改错后：未翻译模板显示空标题，列表项无法辨认与点击。
export function resolveProviderTemplateName(
  templateId: ProviderTemplateId,
  template: Pick<ProviderTemplate, "templateNameMap">,
  locale: ProviderTemplateLocale,
): string {
  return (
    template.templateNameMap[locale]?.trim() ||
    template.templateNameMap["en-US"]?.trim() ||
    templateId
  );
}

/** Built-in Template 与真实 Provider 使用不同身份空间；Template 永不进入 Registry。 */
// [契约] 内部用只读 Map 保存，构造时检查重复 templateId，重复即抛错。
// 看起来该让后写覆盖前写，其实不能：重复模板说明上游数据错误，必须早失败。
// Map 插入顺序就是 keys、entries 与序列化的顺序，合并同 id 覆盖但保留位置。
// 改错后：重复模板被吞掉，用户以为新增成功，实际用的是旧模板。
export class ProviderTemplateMap extends ConfigOverlay<ProviderTemplateMap> {
  readonly #values: ReadonlyMap<ProviderTemplateId, ProviderTemplate>;

  constructor(entries: Iterable<readonly [ProviderTemplateId, ProviderTemplate]> = []) {
    super();
    const values = new Map<ProviderTemplateId, ProviderTemplate>();
    for (const [templateId, template] of entries) {
      if (values.has(templateId)) throw new Error(`重复 Provider Template key: ${templateId}`);
      values.set(templateId, template);
    }
    this.#values = values;
    Object.freeze(this);
  }

  static empty(): ProviderTemplateMap {
    return new ProviderTemplateMap();
  }

  // [事务] 先复制当前 Map，再用 next 的同 id 覆盖，next 中缺少的 id 不删除。
  // 看起来该用 next 全量替换，其实不能：模板是增量下发，替换会丢未下发的内置模板。
  // 覆盖只换值不换顺序，保证列表稳定。
  // 改错后：一次增量更新后内置模板消失，新建 Provider 时选不到模板。
  overlay(next: ProviderTemplateMap): ProviderTemplateMap {
    const result = new Map(this.#values);
    for (const [templateId, template] of next.#values) result.set(templateId, template);
    return new ProviderTemplateMap(result);
  }

  validateComplete(): readonly ConfigValidationIssue[] {
    return [];
  }

  get(templateId: ProviderTemplateId): ProviderTemplate | undefined {
    return this.#values.get(templateId);
  }

  has(templateId: ProviderTemplateId): boolean {
    return this.#values.has(templateId);
  }

  keys(): ProviderTemplateId[] {
    return [...this.#values.keys()];
  }

  entries(): Array<readonly [ProviderTemplateId, ProviderTemplate]> {
    return [...this.#values.entries()];
  }

  toJSON(): ProviderTemplateObject[] {
    return this.entries().map(([, template]) => template.toJSON());
  }
}

function freezeProviderLogo(
  logo: ProviderLogoRef | null | undefined,
): ProviderLogoRef | null | undefined {
  return logo ? Object.freeze({ ...logo }) : logo;
}

// [契约] 对每个 modelId 做 trim，空串直接抛错，返回冻结数组；空输入原样返回。
// 看起来该过滤空串而不是抛错，其实不能：空 modelId 是上游数据损坏，静默过滤会掩盖 bug。
// 构造与三个 with 方法都必须经过这里，没有第二条写入路径。
// 改错后：空 id 进入索引，按 id 查模型命中空值，运行时出现无模型可用的 Provider。
function freezeModelIds(
  modelIds: readonly ModelId[] | null | undefined,
): readonly ModelId[] | null | undefined {
  if (!modelIds) return modelIds;
  return Object.freeze(
    modelIds.map((modelId) => {
      const normalized = modelId.trim();
      if (!normalized) throw new Error("Model ID 不能为空");
      return normalized;
    }),
  );
}

export type ProviderConfigRule = Readonly<
  Omit<ProviderConfigRuleData, "config"> & { config: ProviderConfig }
>;

/** 索引只保存完整规则；get/entries 是内容投影，改成员时不能丢掉外层身份和名称。 */
// [契约] 索引保存完整 rule，包含 providerId、可选 templateId 与 providerName、enabled、config。
// 看起来单值读取返回 config 就够，其实不能：改成员时还要保留外层身份与名称。
// 构造接受 rule 或 id 与 config 两种输入，重复 providerId 直接抛错。
// 改错后：按 config 重建索引时丢掉 templateId 与名称，Provider 变成无名配置。
export class ProviderConfigMap extends ConfigOverlay<ProviderConfigMap> {
  readonly #values: ReadonlyMap<ProviderId, ProviderConfigRule>;

  constructor(entries: Iterable<ProviderConfigRule | readonly [ProviderId, ProviderConfig]> = []) {
    super();
    const values = new Map<ProviderId, ProviderConfigRule>();
    for (const entry of entries) {
      const rule = "providerId" in entry ? entry : { providerId: entry[0], config: entry[1] };
      if (values.has(rule.providerId)) throw new Error(`重复 Provider key: ${rule.providerId}`);
      values.set(rule.providerId, Object.freeze({ ...rule }));
    }
    this.#values = values;
    Object.freeze(this);
  }

  static empty(): ProviderConfigMap {
    return new ProviderConfigMap();
  }

  // [事务] 同 id 合并：templateId、providerName、enabled 用 overlayValue，config 用 config.overlay。
  // 看起来该整体替换 rule，其实不能：只改 enabled 的部分更新必须保留其余字段。
  // next 中没有的 providerId 保留原 rule，不删除。
  // 改错后：切换启用状态时 config 被重置，用户配置的 baseUrl 与凭据全部丢失。
  overlay(next: ProviderConfigMap): ProviderConfigMap {
    const result = new Map(this.#values);
    for (const [providerId, rule] of next.#values) {
      const current = result.get(providerId);
      result.set(
        providerId,
        current
          ? {
              providerId,
              templateId: this.overlayValue(current.templateId, rule.templateId),
              providerName: this.overlayValue(current.providerName, rule.providerName),
              enabled: this.overlayValue(current.enabled, rule.enabled),
              config: current.config.overlay(rule.config),
            }
          : rule,
      );
    }
    return new ProviderConfigMap(result.values());
  }

  mapConfigs(
    transform: (
      config: ProviderConfig,
      providerId: ProviderId,
      rule: ProviderConfigRule,
    ) => ProviderConfig,
  ): ProviderConfigMap {
    return new ProviderConfigMap(
      this.rules().map((rule) => ({
        ...rule,
        config: transform(rule.config, rule.providerId, rule),
      })),
    );
  }

  reorder(providerIds: readonly ProviderId[]): ProviderConfigMap {
    const result = new Map<ProviderId, ProviderConfigRule>();
    for (const providerId of providerIds) {
      const rule = this.#values.get(providerId);
      if (rule && !result.has(providerId)) result.set(providerId, rule);
    }
    for (const [providerId, rule] of this.#values) {
      // [契约] 重排先按入参顺序写入已存在的 id 并去重，再追加未列出的剩余 id。
      // 看起来该只保留入参中的 id，其实不能：拖拽数据可能不完整，丢 id 等于删 Provider。
      // 不在当前索引中的 id 静默跳过，不会被新建。
      // 改错后：一次排序丢掉未被拖动的 Provider，配置看起来自己消失。
      if (!result.has(providerId)) result.set(providerId, rule);
    }
    return new ProviderConfigMap(result.values());
  }

  // [契约] 单条写入复用已有 rule 的身份字段，只替换 config；rule 不存在时只得到 providerId 与 config。
  // 看起来该在这里补 templateId，其实不能：本层不知道模板来源，补默认值会污染身份。
  // 需要完整 rule 的调用方走整条写入，不在这里兜底。
  // 改错后：新建 Provider 被写入错误模板来源，按模板重建时配置错乱。
  set(providerId: ProviderId, config: ProviderConfig): ProviderConfigMap {
    return this.setRule({ ...this.#values.get(providerId), providerId, config });
  }

  setRule(rule: ProviderConfigRule): ProviderConfigMap {
    const result = new Map(this.#values);
    result.set(rule.providerId, rule);
    return new ProviderConfigMap(result.values());
  }

  // [并发] 删除方法过滤后重建，返回新实例，不修改当前只读索引。
  // 看起来该就地删除，其实不能：索引是只读 Map，且已发出的快照必须保持不可变。
  // 删除只影响本层，上层仍需重新校验引用该 Provider 的模型。
  // 改错后：一个窗口删除 Provider，另一个窗口持旧快照仍按 id 取到配置，出现幽灵条目。
  delete(providerId: ProviderId): ProviderConfigMap {
    return new ProviderConfigMap(this.rules().filter((rule) => rule.providerId !== providerId));
  }

  validateComplete(path: readonly string[] = []): readonly ConfigValidationIssue[] {
    return this.entries().flatMap(([providerId, config]) =>
      config.validateComplete([...path, providerId]),
    );
  }

  get(providerId: ProviderId): ProviderConfig | undefined {
    return this.#values.get(providerId)?.config;
  }
  getRule(providerId: ProviderId): ProviderConfigRule | undefined {
    return this.#values.get(providerId);
  }
  has(providerId: ProviderId): boolean {
    return this.#values.has(providerId);
  }
  keys(): ProviderId[] {
    return [...this.#values.keys()];
  }
  rules(): ProviderConfigRule[] {
    return [...this.#values.values()];
  }
  entries(): Array<readonly [ProviderId, ProviderConfig]> {
    return this.rules().map((rule) => [rule.providerId, rule.config]);
  }

  toJSON(): ProviderConfigRuleData[] {
    return this.rules().map(({ config, ...rule }) =>
      objectWithoutUndefined({ ...rule, config: config.toJSON() }),
    );
  }
}

// [契约] 顺序是：next 为空保留当前，next 为 null 或当前缺省取 next，type 不同取 next，同 type 交给具体类。
// 看起来该在 type 不同时也做字段合并，其实不能：两种访问方式字段集合不同，混合会产出非法对象。
// 分支覆盖全部三值，联合类型保证没有遗漏情况。
// 改错后：切换账号类型后残留 apiKey 字段，complete 校验报未知字段或凭据串用。
function overlayProviderAccess(
  current: ProviderAccessConfig | null | undefined,
  next: ProviderAccessConfig | null | undefined,
): ProviderAccessConfig | null | undefined {
  if (next === undefined) return current;
  if (next === null || current === undefined || current === null) return next;
  if (current.type !== next.type) return next;
  switch (current.type) {
    case "api-key":
    case "zhipu-coding-plan-api-key":
      return current.overlay(next as ApiKeyAccessConfig);
    case "zhipu-account":
      return current.overlay(next as ZhipuAccountAccessConfig);
  }
}

// [契约] 序列化前过滤 undefined，空串与 null 保留。
// 看起来该直接返回输入，其实不能：undefined 键会进入 JSON 比较与部分校验，制造伪差异。
// 只在各序列化方法末尾使用，不改变字段语义。
// 改错后：objectWithoutUndefined 若原样返回，undefined 键会制造伪差异，每次保存都触发无意义落盘与广播。
function objectWithoutUndefined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
