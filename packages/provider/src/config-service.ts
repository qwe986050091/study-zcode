// ===== 深度注释：Provider/Model 个人配置服务（Personal Overlay 唯一写入口）=====
// 职责边界（做什么 / 不做什么 / 依赖谁）：
// - 做：合并 Built-in 与 Personal 两层快照，提供只读 ProviderConfigSnapshot，并把两层变更转发为单一 reason 事件。
// - 做：在同一个 Repository.update 事务里完成 Provider 保存、创建、删除、排序，以及 Model 增删改启停与顺序维护。
// - 不做：不读写磁盘、不做 schema 校验、不发网络请求；持久化与字段合法性由 Repository/Source 层负责。
// - 不做：不接受 Renderer 自报的模型名单；继承模型只来自 Built-in 或 Facade 注入的 membership 事实。
// - 依赖：ProviderSource（builtin/personal）、resolveOwnedOrder、config 值对象（ProviderConfig/ModelConfig/ProviderConfigMap）。
//
// 不变量（INV，改动前逐条确认）：
// INV-01 断言：read 必须并行读取两层并冻结结果 —— 守住它的位置：read —— 改错故障：串行读取让两层快照来自不同时间点。
// INV-02 断言：复合 revision 必须同时包含两侧 revision —— 守住它的位置：revision 拼接 —— 改错故障：只变一层时缓存不失效。
// INV-03 断言：#updatePersonal 必须原样保留 defaultModelSelection —— 守住它的位置：update 包装 —— 改错故障：改 Provider 时清掉用户默认模型。
// INV-04 断言：writableProviderOverlay 只允许已有 Personal 或继承 Built-in —— 守住它的位置：保存/模型操作 —— 改错故障：已删除 Provider 被迟到请求复活。
// INV-05 断言：固定 Account Provider 不允许禁用 —— 守住它的位置：enable 校验 —— 改错故障：UI 隐藏后仍能写盘，账号态不可恢复。
// INV-06 断言：固定 Account Provider 的 access 只能由 Built-in 声明 —— 守住它的位置：保存校验 —— 改错故障：通用入口绕过 schema 写坏 access。
// INV-07 断言：普通保存只更新、不创建 —— 守住它的位置：currentPersonal/builtin 判空 —— 改错故障：删除后的迟到保存凭空复活 Overlay。
// INV-08 断言：Built-in Provider 的 group 不可被 Personal 覆盖 —— 守住它的位置：group 校验 —— 改错故障：内置 Provider 被挪到个人分组。
// INV-09 断言：Personal-only Provider 必须 standard-personal —— 守住它的位置：group 归一 —— 改错故障：自建 Provider 混入内置分组。
// INV-10 断言：成员名单必须去重且保持既有顺序 —— 守住它的位置：normalizePersonalProviderMembership —— 改错故障：保存一次就重排用户模型。
// INV-11 断言：重名校验只针对本次名称变更 —— 守住它的位置：assertProviderLabelMutationIsUnique —— 改错故障：历史重名阻断所有无关保存。
// INV-12 断言：创建必须先在事务内占用 id 与 label —— 守住它的位置：createPersonalProvider —— 改错故障：并发创建拿到同一个 id。
// INV-13 断言：initialConfig 不允许携带 group/builtinModelIds —— 守住它的位置：创建入口校验 —— 改错故障：调用方伪造分组或继承模型。
// INV-14 断言：新 Provider 必须追加到顺序末尾 —— 守住它的位置：appendCurrentProviderOrder —— 改错故障：新建项插到用户当前视野之外。
// INV-15 断言：删除 Provider 必须同时删除其精确 Model Rule 与顺序项 —— 守住它的位置：deletePersonalProvider —— 改错故障：残留 model 规则污染下次同名 Provider。
// INV-16 断言：add/rename/delete Model 不得触碰 Built-in 模型 —— 守住它的位置：各 model 方法 —— 改错故障：内置模型被改名或删除后无法恢复。
// INV-17 断言：rename 当前 id 等于目标 id 时直接读快照 —— 守住它的位置：早返回 —— 改错故障：无意义事务触发 revision 变化与全量刷新。
// INV-18 断言：saveDraft 必须用 expectedPersonalRevision 做乐观并发 —— 守住它的位置：savePersonalModelDraft —— 改错故障：两个弹窗互相覆盖。
// INV-19 断言：recommended 且结构为空时必须删除 Rule —— 守住它的位置：saveDraft 尾部 —— 改错故障：空规则覆盖可继承的默认配置。
// INV-20 断言：dispose 必须幂等，先置位再释放 source —— 守住它的位置：dispose —— 改错故障：重复释放抛错或释放后仍收到事件。
// INV-21 断言：所有 id 必须 trim 后非空 —— 守住它的位置：normalizeId/assertNonEmptyId —— 改错故障：空白 id 进入 Map 形成不可见条目。
// INV-22 断言：id 冲突时从 2 开始无限递增 —— 守住它的位置：nextPersonalProviderId —— 改错故障：并发创建生成同名 Provider。
//
// 标注约定：[事务] 单次 Repository.update；[并发] revison/成员快照；[权衡] 校验强度与历史数据兼容。
/* oxlint-disable eslint(max-lines) -- Provider/Model 的原子配置生命周期共享一次 Repository 更新边界，拆开会重复顺序与规范化逻辑。 */
import type {
  ModelConfigRules,
  ModelId,
  ProviderConfig,
  ProviderId,
  ProviderTemplateId,
  ProviderConfigRule,
  ProviderTemplateLocale,
} from "./config/index.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ProviderConfigMap,
  ProviderConfig as ProviderConfigValue,
  ProviderTemplateMap,
  resolveProviderTemplateName,
} from "./config/index.js";
import { resolveOwnedOrder } from "./owned-order.js";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderConfigSnapshot, ProviderSource } from "./sources.js";

// [契约] 该快照是「单层」事实：Built-in 与 Personal 各有一份，复合视图只在 read 时生成。
// revision 由 Source 负责单调递增；Service 不重新计算单层 revision。
export interface ProviderConfigLayerSnapshot {
  readonly revision: string;
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

// Update 是可写子集：缺省 providerTemplates/order/default 表示「保持原值」，而不是清空。
export interface ProviderConfigLayerUpdate {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates?: ProviderTemplateMap;
  readonly models: ModelConfigRules;
  readonly providerOrder?: readonly ProviderId[];
  readonly defaultModelSelection?: ModelSelection;
}

// [事务] update 的 transform 必须是纯函数：Repository 可能重试，副作用会重复执行。
// update 返回提交后的完整快照，调用方不得自行拼接结果。
export interface PersonalProviderConfigRepository extends ProviderSource<ProviderConfigLayerSnapshot> {
  update(
    // [事务] 回调内不得 await 或读取外部可变状态；Repository 无法回滚已经发生的副作用。
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot>;
}

// 两个 Source 都从构造函数注入，Service 不感知具体存储实现，也不缓存读取结果。
export interface ProviderConfigServiceDependencies {
  // Built-in Source 在生命周期内不可替换；需要热切换时必须 dispose 后重建 Service。
  readonly zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  // Personal Repository 同时是读源与写源；不要另外注入一个只读 Source，否则两层快照会分叉。
  readonly personalRepository: PersonalProviderConfigRepository;
}

// 创建结果只暴露 providerId：调用方需要再 read 才能拿到完整配置。
export interface PersonalProviderCreation {
  readonly providerId: ProviderId;
}

// locale 只影响模板名称的本地化，不影响 providerId 与配置内容。
export interface CreatePersonalProviderInput {
  readonly templateId?: ProviderTemplateId;
  readonly providerName?: string;
  readonly locale?: ProviderTemplateLocale;
  readonly initialConfig?: ProviderConfig;
}

/** Facade 提供的 Host 内部成员事实；不得接受 Renderer 自报的模型名单。 */
export interface ProviderModelMembership {
  readonly providerId: ProviderId;
  // inheritedModelIds 是 Facade 计算的继承事实，Service 只信它或 Built-in，不接受前端名单。
  readonly inheritedModelIds: readonly ModelId[];
  // membership 携带的是「调用方看到的 Personal revision」，用于事务内检测发布快照是否过期。
  readonly personalRevision: string;
  /** 在 Personal 事务内检查发布快照未过期，不触发网络请求。 */
  readonly assertCurrent: () => void;
}

// membership 为空表示调用方不需要动态成员校验；此时完全回退到 Built-in 事实。
// [并发] 先调用 assertCurrent 再做 revision 比较：前者负责发布快照，后者负责事务内一致性。
function assertMembershipCurrent(
  membership: ProviderModelMembership | undefined,
  providerId: ProviderId,
  current: ProviderConfigLayerSnapshot,
): void {
  // 没有成员上下文时不能代替调用方做假设，直接放行是兼容旧调用端的必要条件。
  if (!membership) return;
  // 先让 Facade 校验自身发布状态，再做 Service 侧的 revision 比较；两层检查职责不同。
  membership.assertCurrent();
  // providerId 不匹配说明 membership 被跨 Provider 复用；revision 不匹配说明快照已过期。
  // 两者都抛出同一类冲突错误，调用方需要重新读取后再发起操作。
  if (membership.providerId !== providerId || membership.personalRevision !== current.revision) {
    throw new Error("Provider Settings membership revision conflict");
  }
}

/** Personal 根记录只是覆盖层，不是 Provider 存在性的依据；仅继承 Provider 可按需创建覆盖。 */
// 这是所有写操作的统一准入：只有已存在 Personal 或继承 Built-in 才能继续。
// 返回空 ProviderConfig 而不是 undefined，表示「允许创建覆盖层」但不复制 Built-in 字段。
function writableProviderOverlay(
  builtin: ProviderConfigLayerSnapshot,
  current: ProviderConfigLayerSnapshot,
  providerId: ProviderId,
): ProviderConfig {
  const provider = current.providers.get(providerId);
  // 已有 Personal 覆盖层直接返回，不再叠加 Built-in 字段；覆盖层本身就是完整可写值。
  if (provider) return provider;
  // 继承 Provider 的覆盖层从空对象开始，避免把 Built-in 的可写字段复制成 Personal 真值。
  if (builtin.providers.has(providerId)) return new ProviderConfigValue({});
  // 已删除的自定义/模板实例没有继承 Provider 身份，迟到操作不能把它复活。
  throw new Error(`Provider 不存在: ${providerId}`);
}

// [并发] 实例本身无锁：所有写操作串行化依赖 Repository.update，Service 只保证单次事务内的判断顺序。
// listeners 是同步集合，通知不排队；监听方必须自行处理重入。
export class ProviderConfigService implements ProviderSource<ProviderConfigSnapshot> {
  readonly #zcodeBuiltinSource: ProviderSource<ProviderConfigLayerSnapshot>;
  readonly #personalRepository: PersonalProviderConfigRepository;
  readonly #listeners = new Set<(reason: string) => void>();
  // 两个 source 的 dispose 与监听解除都收集在这里，dispose 时一次性消费。
  readonly #sourceDisposers: Array<() => void>;
  // disposed 只在 dispose 中置 true，且永不复位；Service 实例不可重用。
  #disposed = false;

  // 构造即订阅两层变更；reason 加前缀区分来源，避免上层无法归因。
  // 订阅回调只做转发，不做读取或写回，防止构造期产生 IO。
  constructor(dependencies: ProviderConfigServiceDependencies) {
    this.#zcodeBuiltinSource = dependencies.zcodeBuiltinSource;
    this.#personalRepository = dependencies.personalRepository;
    // [资源] 两个订阅的取消函数按注册顺序保存；dispose 时 splice 一次性取出并逐个调用。
    // 如果订阅建立失败，构造函数会抛出，不会留下半订阅实例。
    this.#sourceDisposers = [
      this.#zcodeBuiltinSource.onDidChange((reason) => this.#emit(`zcodeBuiltin:${reason}`)),
      this.#personalRepository.onDidChange((reason) => this.#emit(`personal:${reason}`)),
    ];
  }

  // [并发] 两层必须并行读取；串行会让 revision 组合出现时间差。
  // 返回前冻结顶层对象，防止调用方修改快照字段（内层 Map 仍由 Source 保证不可变）。
  async read(): Promise<ProviderConfigSnapshot> {
    this.#assertNotDisposed();
    // 并行读取的另一个收益是失败语义一致：任一层失败整体失败，不存在半份快照。
    const [zcodeBuiltin, personal] = await Promise.all([
      this.#zcodeBuiltinSource.read(),
      this.#personalRepository.read(),
    ]);
    return Object.freeze({
      // 复合 revision 用数组序列化而不是字符串拼接：避免分隔符与 revision 内容冲突。
      // 顺序固定为 builtin 在前，personal 在后；调整顺序会让所有下游缓存失效。
      revision: JSON.stringify([zcodeBuiltin.revision, personal.revision]),
      zcodeBuiltinRevision: zcodeBuiltin.revision,
      personalRevision: personal.revision,
      zcodeBuiltinProviders: zcodeBuiltin.providers,
      // 模板层缺失时补空 Map，让下游不需要处理 undefined；这是快照的规范化边界。
      zcodeBuiltinProviderTemplates: zcodeBuiltin.providerTemplates ?? ProviderTemplateMap.empty(),
      personalProviders: personal.providers,
      zcodeBuiltinModelRules: zcodeBuiltin.models,
      personalModels: personal.models,
      // 个人顺序缺失时补空数组；空数组表示「按默认顺序」，不是「无 Provider」。
      personalProviderOrder: personal.providerOrder ?? [],
    });
  }

  // 返回的取消函数可以安全重复调用：Set.delete 幂等，不需要额外守卫。
  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    // 取消订阅只删除当前 listener；不要在取消时 clear，否则会误删其他监听方。
    return () => this.#listeners.delete(listener);
  }

  /** 仅供版本迁移或事实源 cutover 原子替换完整 Personal Overlay。 */
  // 仅供迁移与事实源 cutover 使用：它跳过所有字段级校验，直接替换整个 Personal 层。
  // 不要把它接到普通保存路径；否则会绕过 group/access/成员保护。
  replacePersonalConfig(config: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    // 全量导入/分发与字段编辑不同；新信封未带默认选择时必须清除，不能继承接收端旧值。
    // 整层替换不做任何字段合并：缺省字段等同于删除，这正是迁移/切换事实源需要的语义。
    return this.#personalRepository.update(() => config);
  }

  // [事务] 读取 Built-in 在事务外，事务内只读 Personal 快照；Built-in 在单次保存期间视为稳定。
  // membership 与 metadata 都是可选增强，缺省时退化为纯 Personal 覆盖保存。
  async savePersonalProviderOverlay(
    providerId: ProviderId,
    config: ProviderConfig,
    membership?: ProviderModelMembership,
    metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      // 区分 Built-in 继承与 Personal-only：两条分支对 group 与成员的处理完全不同。
      // 变量名 builtin 在此指「Built-in 中的 Provider 配置」，不是整个快照。
      const builtin = zcodeBuiltin.providers.get(providerId);
      const currentPersonal = current.providers.get(providerId);
      // 有效视图用于重名校验；它不写回，也不参与本次提交，只是判断基线。
      const currentEffectiveProviders = zcodeBuiltin.providers.overlay(current.providers);
      // 账号总禁用已撤销；在公共写入边界拒绝新操作，避免隐藏 UI 后仍能写出无效状态。
      // Account Provider 的启用状态受账号体系约束，禁用等于让用户失去唯一的登录入口。
      // 在校验层拒绝而不是隐藏 UI：任何调用方都必须得到同一个错误。
      if (builtin?.access?.type === "zhipu-account" && metadata?.enabled === false) {
        throw new Error(`Account Provider 不允许禁用: ${providerId}`);
      }
      // 固定 Account Provider 的 access 属于 Built-in 声明；Personal 只能改其他字段。
      // 这里用 !== undefined 判存在，而不是判 truthy：空对象同样是非法写入。
      if (builtin?.access?.type === "zhipu-account" && config.access !== undefined) {
        // 通用保存入口只解析 ProviderConfig，曾绕过 Personal Source Schema，
        // 允许固定 Account Provider 的 access 被写盘，直到下次读取才整份拒绝。
        throw new Error(
          `固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明: ${providerId}`,
        );
      }
      // 普通保存曾同时承担创建语义，删除后的迟到保存可以凭空复活 Overlay。
      // 创建已经是明确的领域操作，普通保存只更新现有配置，不存在即拒绝。
      // 删除后 Provider 既不在 Personal 也不在 Built-in，普通保存必须拒绝。
      // 创建是独立的 createPersonalProvider，普通保存不做隐式创建。
      if (!currentPersonal && !builtin) {
        throw new Error(`Personal Provider 尚未创建: ${providerId}`);
      }
      // normalized 是可写副本：后续可能去掉 group 或叠加默认 group，但不能修改调用方对象。
      let normalized = config;
      // Built-in 分支只允许改可覆盖字段，group 与成员归属由 Built-in 决定。
      if (builtin) {
        // 只拒绝「显式给出且不同」的 group；未提供时沿用 Built-in，不算冲突。
        if (normalized.group != null && normalized.group !== builtin.group) {
          // group 决定 Provider 在设置页的分区；改写会让内置项出现在错误的分类里。
          throw new Error(`Personal Overlay 不能改写 Built-in Provider group: ${providerId}`);
        }
        // Built-in Provider 的 group 必须回到继承值，Personal 只保存「不覆盖」。
        normalized = normalized.withoutGroup();
      } else {
        // Personal-only 的 group 优先沿用旧值，其次要求显式 standard-personal；两者都没有则拒绝。
        const group = normalized.group ?? currentPersonal?.group;
        if (group !== "standard-personal") {
          throw new Error(`Personal-only Provider 必须使用 standard-personal group: ${providerId}`);
        }
        normalized = normalized.overlay(new ProviderConfigValue({ group }));
      }
      const membershipBaseline =
        builtin ?? resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      // 成员归一必须在写入前完成：先合并再去重，保证 personalModelIds 与 modelOrder 同步。
      // 传入 membership.inheritedModelIds 优先于 Built-in，体现动态上下文的更高优先级。
      const next = normalized.withModelMembershipFrom(
        // 普通 Provider 保存也保留动态成员顺序；不能改名称时又按静态名单删掉已保存的调序。
        normalizePersonalProviderMembership(
          currentPersonal,
          membershipBaseline,
          membership?.inheritedModelIds,
        ),
      );
      // 保留旧 rule 的其他字段（templateId/enabled/providerName），只覆盖调用方显式提供的项。
      // undefined 表示「不修改」；null 才是「清空」，两者不能混用。
      const currentRule = current.providers.getRule(providerId);
      const providers = current.providers.setRule({
        ...currentRule,
        providerId,
        ...(metadata?.templateId === undefined ? {} : { templateId: metadata.templateId }),
        ...(metadata?.enabled === undefined ? {} : { enabled: metadata.enabled }),
        ...(metadata?.providerName === undefined
          ? {}
          : { providerName: metadata.providerName?.trim() || null }),
        // rule 中的 config 是归一后的最终值，不是调用方原始输入；写入前所有分支都已收敛。
        config: next,
      });
      // 重名校验必须基于叠加后的有效视图，否则只看 Personal 会漏掉与 Built-in 同名的情况。
      const nextEffectiveProviders = zcodeBuiltin.providers.overlay(providers);
      // 旧版本可能已经留下重名 Provider。全量校验会让这些历史问题阻断
      // 任意无关 Provider 的保存；这里仅禁止本次名称变更新引入重名。
      // 只比较「本次写入后的 label」与「其他 Provider 的当前 label」，不修复历史重名。
      // 历史重名若被全量校验，会让任何一个 Provider 的保存都被阻断。
      assertProviderLabelMutationIsUnique(
        providerId,
        currentEffectiveProviders,
        nextEffectiveProviders,
      );
      return {
        providers,
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  // [并发] template 读取在事务外，id/label 计算在事务内；并发创建靠 occupied 集合保证唯一。
  // initialConfig 与模板配置的叠加顺序固定：模板在前，用户输入覆盖在后。
  async createPersonalProvider(
    input: CreatePersonalProviderInput = {},
  ): Promise<PersonalProviderCreation> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    const templateId = input.templateId?.trim();
    // 模板只在创建时用于初值与名称，不会随创建结果持久化为可写引用。
    const template = templateId ? zcodeBuiltin.providerTemplates?.get(templateId) : undefined;
    // 模板 id 已提供但查不到时直接失败；不能静默退化成空白 Provider。
    if (templateId && !template) throw new Error(`Provider Template 不存在: ${templateId}`);
    // group 由创建流程强制写为 standard-personal，调用方即使传了也会被拒绝而不是被覆盖。
    if (input.initialConfig?.group !== undefined) {
      throw new Error("initialConfig 不能包含 group");
    }
    // builtinModelIds 属于继承事实，创建入参携带它等于伪造继承关系。
    if (input.initialConfig?.builtinModelIds !== undefined) {
      throw new Error("initialConfig 不能包含 builtinModelIds");
    }
    // id 在事务闭包内产生，闭包外读取；不设默认值是为了让「事务未执行」显式暴露。
    let createdProviderId: ProviderId | undefined;
    await this.#updatePersonal((current) => {
      // 占用集合必须同时包含两层：只查 Personal 会生成与 Built-in 冲突的 id。
      // 在事务内构建集合，保证并发重试时看到最新 Personal。
      const occupied = new Set([...zcodeBuiltin.providers.keys(), ...current.providers.keys()]);
      const providerId = nextPersonalProviderId(occupied, templateId);
      // 在事务闭包内记录 id；如果 Repository 重试，这个赋值会被覆盖为最后一次结果。
      createdProviderId = providerId;
      const effectiveProviders = resolvePersonalProviderBaselines(zcodeBuiltin, current.providers);
      // label 冲突基于有效 Provider 视图；同名的 Built-in 也算占用，避免创建后无法区分。
      const label = nextPersonalProviderLabel(
        input.providerName ??
          (template && templateId
            ? resolveProviderTemplateName(templateId, template, input.locale ?? "en-US")
            : "new-provider"),
        effectiveProviders,
      );
      // 空初始配置也要走 overlay，保证 group/access/模型数组都有明确初值。
      const initial = input.initialConfig ?? new ProviderConfigValue();
      const providers = current.providers.setRule({
        providerId,
        ...(templateId ? { templateId } : {}),
        providerName: label,
        config: new ProviderConfigValue({
          group: "standard-personal",
          access: templateId ? undefined : new ApiKeyAccessConfig(),
          personalModelIds: [],
          modelOrder: [],
        }).overlay(initial),
      });
      return {
        providers,
        models: current.models,
        providerOrder: appendCurrentProviderOrder(
          zcodeBuiltin.providers,
          providers,
          current.providerOrder,
          providerId,
        ),
      };
    });
    // 事务成功但未赋值说明 transform 未被调用，属于 Repository 契约被破坏，必须显式失败。
    if (!createdProviderId) throw new Error("Personal Provider 创建失败");
    return Object.freeze({ providerId: createdProviderId });
  }

  // 删除是幂等语义：目标不存在时 Map.delete 返回原集合，不抛错。
  // 同时删除 Model Rule，避免同名 Provider 重建后继承到旧规则。
  deletePersonalProvider(providerId: ProviderId): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    return this.#updatePersonal((current) => ({
      // 删除 Provider 覆盖层；Built-in 同 id 的 Provider 仍然存在，这是期望行为。
      providers: current.providers.delete(providerId),
      // 精确删除只清理该 Provider 的 Personal Rule，不影响 Built-in 或模板继承的模型。
      models: current.models.deleteExactForProvider(providerId),
      // 顺序数组同样要去掉目标 id；保留 undefined 语义，避免把「无自定义顺序」变成空数组。
      providerOrder: current.providerOrder?.filter((candidate) => candidate !== providerId),
    }));
  }

  // 排序只作用于 standard-personal 分组；Built-in Provider 的顺序由 Built-in 自己决定。
  // requested 中不存在的 id 会被 resolveOwnedOrder 过滤，调用方不需要预清洗。
  async reorderPersonalProviders(
    providerIds: readonly ProviderId[],
  ): Promise<ProviderConfigLayerSnapshot> {
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => ({
      providers: current.providers,
      models: current.models,
      providerOrder: normalizeProviderOrder(zcodeBuiltin.providers, current.providers, providerIds),
    }));
  }

  // 模型排序同样走 writableProviderOverlay：已删除的 Provider 不允许恢复排序。
  // 成员来源优先 membership，其次 Built-in，最后模板基线。
  async reorderPersonalModels(
    providerId: ProviderId,
    modelIds: readonly ModelId[],
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    assertNonEmptyId("providerId", providerId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, providerId, current);
      // Built-in 缺失时回退模板基线，保证继承模型与排序在模板实例上仍然成立。
      const builtinProvider =
        zcodeBuiltin.providers.get(providerId) ??
        resolveTemplateBaseline(zcodeBuiltin, current.providers, providerId);
      const provider = writableProviderOverlay(zcodeBuiltin, current, providerId);
      // normalizeModelOrder 会补齐缺失 id 并丢弃未知 id，保证顺序数组与成员集合一致。
      const modelOrder = normalizeModelOrder(
        membership?.inheritedModelIds ?? builtinProvider?.builtinModelIds ?? [],
        provider.personalModelIds ?? [],
        modelIds,
      );
      return {
        providers: current.providers.set(providerId, provider.withModelOrder(modelOrder)),
        models: current.models,
        providerOrder: current.providerOrder,
      };
    });
  }

  // [事务] 重名检查在事务内完成：先查 Built-in 继承，再查 Personal 已有。
  // useRecommendedConfig 透传给 ModelConfig 规则选择，不影响成员写入。
  async addPersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    config: ModelConfig,
    membership?: ProviderModelMembership,
    useRecommendedConfig?: boolean,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = writableProviderOverlay(zcodeBuiltin, current, normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      // Built-in 模型已经存在时不允许再添加同名 Personal 模型；这会造成成员归属二义。
      if (builtinModelIds.includes(normalizedModelId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${normalizedModelId}`);
      }
      // 读取一次并复用，避免在追加与判重之间被其他分支改动引用（事务内虽不可变，但语义更清晰）。
      const currentModelIds = provider.personalModelIds ?? [];
      // 与 Built-in 分开检查是为了给出更准确的错误来源；合并检查会丢失上下文。
      if (currentModelIds.includes(normalizedModelId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${normalizedModelId}`);
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider.withPersonalModelIds([...currentModelIds, normalizedModelId]).withModelOrder(
            // 添加不能重新按成员名单排序，否则会丢掉用户已经保存的顺序。
            normalizeModelOrder(
              builtinModelIds,
              [...currentModelIds, normalizedModelId],
              provider.modelOrder ?? [],
            ),
          ),
        ),
        models: current.models.setExact(
          normalizedProviderId,
          normalizedModelId,
          config.overlay(new ModelConfig({ enabled: true })),
          useRecommendedConfig,
        ),
        providerOrder: current.providerOrder,
      };
    });
  }

  // 重命名涉及成员数组、顺序数组与 Model Rule 三处同步，必须在同一事务内完成。
  // Built-in 模型不允许重命名，即使当前 Personal 中也有同名条目。
  async renamePersonalModel(
    providerId: ProviderId,
    currentModelId: ModelId,
    nextModelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const currentId = normalizeId("modelId", currentModelId);
    const nextId = normalizeId("modelId", nextModelId);
    // 无变化时直接读快照，不进入事务；避免制造一次空 revision。
    // 注意这里读的是 Personal 层，不是复合快照：调用方只关心该层是否变化。
    if (currentId === nextId) return this.#personalRepository.read();
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      // 继承归属保护适用于 Facade 和底层直接调用，不能只在有动态上下文时检查。
      // 先拒绝 Built-in 再拒绝不存在，顺序影响错误可读性；内置保护是最重要的语义。
      if (builtinModelIds.includes(currentId))
        throw new Error(`Built-in Model 不能重命名: ${normalizedProviderId}/${currentId}`);
      if (!provider?.personalModelIds?.includes(currentId)) {
        throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${currentId}`);
      }
      // 目标 id 与现有 Personal 冲突时拒绝；不要与 Built-in 检查合并，前者可以给出「已存在」。
      if (provider.personalModelIds.includes(nextId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }
      if (builtinModelIds.includes(nextId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }
      const modelIds = provider.personalModelIds.map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
        modelId === currentId ? nextId : modelId,
      );
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        ),
        models: current.models.renameExactModel(normalizedProviderId, currentId, nextId),
        providerOrder: current.providerOrder,
      };
    });
  }

  // 启停不接收完整 config，只改 enabled 位；这是「局部更新」与「草稿保存」的分界。
  // enabled 必须显式 boolean，字符串 "false" 不能被真值化。
  async setPersonalModelEnabled(
    providerId: ProviderId,
    modelId: ModelId,
    enabled: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const id = normalizeId("providerId", providerId);
    const model = normalizeId("modelId", modelId);
    // 运行时类型守卫，因为 IPC/脚本调用可能绕过 TypeScript。
    if (typeof enabled !== "boolean") throw new Error("Model enabled 必须是 boolean");
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, id, current);
      const provider = current.providers.get(id);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, id);
      // 只允许对可见成员启停：既不在 Built-in 也不在 Personal 的 id 属于非法调用。
      if (!inherited.includes(model) && !provider?.personalModelIds?.includes(model)) {
        throw new Error(`Model 不存在: ${id}/${model}`);
      }
      // 启停曾复用完整草稿保存，可能覆盖其他编辑或被固定配置完整性阻挡。
      // 在事务内只修改最新 enabled；不改变模式、成员和其他模型字段。
      const config = (current.models.getExact(id, model) ?? new ModelConfig({})).overlay(
        new ModelConfig({ enabled }),
      );
      return {
        providers: current.providers,
        models: current.models.setExact(id, model, config),
        providerOrder: current.providerOrder,
      };
    });
  }

  /** Model 编辑弹窗的唯一写入边界：成员、顺序、精确 Rule 在同一次 Repository update 中提交。 */
  // [事务] 这是编辑弹窗的唯一写入边界：成员、顺序、Rule 必须一次提交，否则会出现半保存。
  // expectedPersonalRevision 是乐观锁；不匹配时整体回滚，不做字段级合并。
  async savePersonalModelDraft(
    providerId: ProviderId,
    originalModelId: ModelId,
    nextModelId: ModelId,
    config: ModelConfig,
    expectedPersonalRevision: string,
    useRecommendedConfig?: boolean,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const originalId = normalizeId("modelId", originalModelId);
    const nextId = normalizeId("modelId", nextModelId);
    const zcodeBuiltin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      // 并发冲突直接抛错，让弹窗提示用户重新加载；静默覆盖会丢失另一端的编辑。
      if (current.revision !== expectedPersonalRevision) {
        throw new Error(
          `Personal Provider Config revision conflict: expected ${expectedPersonalRevision}, current ${current.revision}`,
        );
      }
      // 未显式指定时，根据当前 Rule 类型推导：manual-provider-model 表示用户自定义，保留完整配置。
      // 这个推导必须发生在读取 latest 快照之后，不能使用打开弹窗时的旧值。
      const recommended =
        useRecommendedConfig ??
        current.models.getExactRule(normalizedProviderId, originalId)?.type !==
          "manual-provider-model";
      const provider = current.providers.get(normalizedProviderId);
      const builtinModelIds =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(zcodeBuiltin, current.providers, normalizedProviderId);
      const builtinSet = new Set(builtinModelIds);
      // 只有真正改名时才检查 Built-in 冲突；同 id 保存不应被自身阻挡。
      if (originalId !== nextId && builtinSet.has(originalId)) {
        throw new Error(`Built-in Model 不能重命名: ${normalizedProviderId}/${originalId}`);
      }
      if (originalId !== nextId && builtinSet.has(nextId)) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }
      // saveDraft 允许 Provider 尚不存在覆盖层：此时成员为空，后续按 Built-in 继承判断。
      const personalModelIds = provider?.personalModelIds ?? [];
      const originalExists = builtinSet.has(originalId) || personalModelIds.includes(originalId);
      if (!originalExists) {
        throw new Error(`Model 不存在: ${normalizedProviderId}/${originalId}`);
      }
      // 目标 id 冲突检查合并了两个来源；这里用 Set 与数组混合判断是有意的，避免再建一个 Set。
      if (originalId !== nextId && (personalModelIds.includes(nextId) || builtinSet.has(nextId))) {
        throw new Error(`Model 已存在: ${normalizedProviderId}/${nextId}`);
      }

      // 只有发生改名时才替换 providers；不改名时保持原引用，减少下游无意义的重渲染。
      // 两个 let 的赋值必须与 models 的赋值成对出现，否则会出现成员已改名而规则未改名的中间态。
      let providers = current.providers;
      // models 先指向当前规则集合，只有需要改名或写入草稿时才替换；保持不变时复用引用可减少变更面。
      let models = current.models;
      if (originalId !== nextId) {
        if (!provider?.personalModelIds?.includes(originalId)) {
          throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${originalId}`);
        }
        const modelIds = provider.personalModelIds.map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        const requestedOrder = (provider.modelOrder ?? []).map((modelId) =>
          modelId === originalId ? nextId : modelId,
        );
        providers = providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(modelIds)
            .withModelOrder(normalizeModelOrder(builtinModelIds, modelIds, requestedOrder)),
        );
        models = models.renameExactModel(normalizedProviderId, originalId, nextId);
      }
      models =
        // 推荐配置下空草稿应删除 Rule，让模型回退到继承默认；写入空规则会固定成显式空配置。
        // isStructurallyEmpty 不是 === {}：嵌套空对象也必须识别。
        recommended && isStructurallyEmpty(config.toJSON())
          ? models.deleteExact(normalizedProviderId, nextId)
          : models.setExact(normalizedProviderId, nextId, config, recommended);
      return { providers, models, providerOrder: current.providerOrder };
    });
  }

  // 删除只允许 Personal 成员；Built-in 模型即便在 effective 视图中可见也不可删。
  // 删除后必须重算 modelOrder，避免顺序数组保留幽灵 id。
  async deletePersonalModel(
    providerId: ProviderId,
    modelId: ModelId,
    membership?: ProviderModelMembership,
  ): Promise<ProviderConfigLayerSnapshot> {
    const normalizedProviderId = normalizeId("providerId", providerId);
    const normalizedModelId = normalizeId("modelId", modelId);
    const builtin = await this.#zcodeBuiltinSource.read();
    return this.#updatePersonal((current) => {
      assertMembershipCurrent(membership, normalizedProviderId, current);
      const provider = current.providers.get(normalizedProviderId);
      const inherited =
        membership?.inheritedModelIds ??
        resolveProviderBuiltinModelIds(builtin, current.providers, normalizedProviderId);
      // 继承模型保护优先于存在性检查：用户更容易误以为「删除内置模型」是合法操作。
      if (inherited.includes(normalizedModelId))
        throw new Error(`Built-in Model 不能删除: ${normalizedProviderId}/${normalizedModelId}`);
      if (!provider?.personalModelIds?.includes(normalizedModelId)) {
        throw new Error(`Personal Model 不存在: ${normalizedProviderId}/${normalizedModelId}`);
      }
      return {
        providers: current.providers.set(
          normalizedProviderId,
          provider
            .withPersonalModelIds(
              provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
            )
            .withModelOrder(
              normalizeModelOrder(
                inherited,
                provider.personalModelIds.filter((candidate) => candidate !== normalizedModelId),
                provider.modelOrder ?? [],
              ),
            ),
        ),
        models: current.models.deleteExact(normalizedProviderId, normalizedModelId),
        providerOrder: current.providerOrder,
      };
    });
  }

  // [资源] 幂等：重复 dispose 直接返回，不抛错，方便在错误路径与正常路径都调用。
  // 先置位 `releasing` 再释放，防止释放期回调重入。
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#sourceDisposers.splice(0)) dispose();
    this.#listeners.clear();
  }

  // [事务] 所有 Personal 写操作的唯一入口：包装 transform 并保留 defaultModelSelection。
  // transform 抛错时 Repository 不落盘，调用方看到 reject，不需要额外回滚代码。
  #updatePersonal(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    return this.#personalRepository.update((current) => ({
      // Provider/Model/排序只修改自己的成员，不能因共用文件清掉默认选择。
      // Provider/Model/排序更新不拥有默认选择；省略这一行会让默认模型被静默清空。
      // 注意展开顺序：它必须在 transform 之前，允许 transform 显式覆盖。
      defaultModelSelection: current.defaultModelSelection,
      ...transform(current),
    }));
  }

  // dispose 后不再通知；reason 为空时回退 "changed"，保证监听方永远拿到非空字符串。
  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason || "changed");
  }

  // 所有公开入口在开始处调用；放在异步读取之后会白白发起 IO。
  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("ProviderConfigService 已 dispose");
  }
}

// 空对象、空数组与 undefined 都算空；null 与非对象算非空，保持语义严格。
// 递归遍历值而不是 JSON 序列化，避免键顺序与循环引用问题。
function isStructurallyEmpty(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length === 0;
  return Object.values(value).every(isStructurallyEmpty);
}

// 名称比较统一转小写：`normalizedName`，展示层保留用户大小写。
// 空 label 表示「未命名」，不参与冲突判断。
function assertProviderLabelMutationIsUnique(
  providerId: ProviderId,
  currentProviders: ProviderConfigMap,
  nextProviders: ProviderConfigMap,
): void {
  const currentLabel = currentProviders.getRule(providerId)?.providerName?.trim();
  const nextLabel = nextProviders.getRule(providerId)?.providerName?.trim();
  const currentKey = currentLabel?.toLocaleLowerCase();
  const nextKey = nextLabel?.toLocaleLowerCase();
  // 未改名时提前返回：历史重名不应阻断一次无关字段的保存。
  if (!nextKey || nextKey === currentKey) return;
  for (const candidate of nextProviders.rules()) {
    const candidateId = candidate.providerId;
    if (candidateId === providerId) continue;
    if (candidate.providerName?.trim().toLocaleLowerCase() === nextKey) {
      throw new Error(`Provider 名称已存在: ${nextLabel}`);
    }
  }
}

// Built-in 成员优先去重，Personal 中与 Built-in 重名的条目会被剔除。
// 顺序只在已有 modelOrder 时重算；没有顺序时保留成员原顺序，避免制造新顺序。
function normalizePersonalProviderMembership(
  personal: ProviderConfig | undefined,
  builtin: ProviderConfig | undefined,
  inheritedModelIds?: readonly ModelId[],
): ProviderConfig | undefined {
  // 没有 Personal 覆盖层时不构造空对象；undefined 表示「无成员需要维护」。
  if (!personal) return undefined;
  const builtinModelIds = uniqueInOrder(inheritedModelIds ?? builtin?.builtinModelIds ?? []);
  const builtinSet = new Set(builtinModelIds);
  const personalModelIds = uniqueInOrder(personal.personalModelIds ?? []).filter(
    (modelId) => !builtinSet.has(modelId),
  );
  let normalized = personal.withPersonalModelIds(personalModelIds);
  if (personal.modelOrder !== undefined && personal.modelOrder !== null) {
    normalized = normalized.withModelOrder(
      normalizeModelOrder(builtinModelIds, personalModelIds, personal.modelOrder),
    );
  }
  return normalized;
}

// 只校验不返回归一值，用于已经持有 ProviderId 类型的调用路径。
function assertNonEmptyId(label: string, value: string): void {
  if (!value.trim()) throw new Error(`${label} 不能为空`);
}

// 归一与校验合一：调用方拿到的就是 trim 后的值，后续不必重复 trim。
function normalizeId(label: string, value: string): string {
  // 返回归一值而不是布尔，调用方后续使用 normalized 即可，避免再次 trim 造成不一致。
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空`);
  return normalized;
}

// 保持首次出现顺序去重；不要改成 Set 展开，那会丢失顺序语义（旧运行时）或增加不必要的分配。
function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (const value of values) if (!result.includes(value)) result.push(value);
  return result;
}

// 排序只保留 standard-personal 分组，Built-in id 即使传入也会被 resolveOwnedOrder 过滤。
// 第一个参数保留但未使用，是历史签名兼容；不要删除，避免调用方改签名。
function normalizeProviderOrder(
  _zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  requested: readonly ProviderId[],
): ProviderId[] {
  const personalIds = personalProviders
    .entries()
    .filter(([, config]) => config.group === "standard-personal")
    .map(([providerId]) => providerId);
  return [...resolveOwnedOrder([], personalIds, requested)];
}

// 先归一当前顺序，再过滤目标 id 后追加；保证重复调用不会产生重复项。
// 新 Provider 永远在末尾，避免打乱用户已经调整好的顺序。
function appendCurrentProviderOrder(
  zcodeBuiltinProviders: ProviderConfigMap,
  personalProviders: ProviderConfigMap,
  currentOrder: readonly ProviderId[] | undefined,
  addedProviderId: ProviderId,
): ProviderId[] {
  const current = normalizeProviderOrder(
    zcodeBuiltinProviders,
    personalProviders,
    currentOrder ?? [],
  );
  return normalizeProviderOrder(zcodeBuiltinProviders, personalProviders, [
    ...current.filter((providerId) => providerId !== addedProviderId),
    addedProviderId,
  ]);
}

// 模型顺序与成员集合共用 resolveOwnedOrder，Built-in 与 Personal 的归属规则只在这里定义一次。
function normalizeModelOrder(
  builtinModelIds: readonly ModelId[],
  personalModelIds: readonly ModelId[],
  requested: readonly ModelId[],
): ModelId[] {
  return [...resolveOwnedOrder(builtinModelIds, personalModelIds, requested)];
}

// 模板 id 作为种子，无模板用 new-provider；种子会做 slug 归一。
// 冲突时从 2 开始递增，不设上限；占用集合是唯一事实。
function nextPersonalProviderId(
  occupied: ReadonlySet<ProviderId>,
  templateId?: ProviderTemplateId,
): ProviderId {
  const base = templateId ? normalizeProviderIdSeed(templateId) : "new-provider";
  if (!occupied.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

// 非字母数字全部折叠成单个连字符，并去掉首尾连字符；空结果回退 new-provider。
// 使用 toLocaleLowerCase 与仓库其他 id 归一保持一致。
function normalizeProviderIdSeed(value: string): string {
  return (
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "new-provider"
  );
}

// 模板配置作为 Personal 的基线叠加，用于生成 label 冲突判断与有效视图。
// 叠加顺序固定模板在前、Personal 在后；反过来会让用户配置被模板覆盖。
function resolvePersonalProviderBaselines(
  zcodeBuiltin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
): ProviderConfigMap {
  const personal = personalProviders.mapConfigs((config, _id, rule) => {
    const template = rule.templateId
      ? zcodeBuiltin.providerTemplates?.get(rule.templateId)
      : undefined;
    return template ? template.config.overlay(config) : config;
  });
  return zcodeBuiltin.providers.overlay(personal);
}

// 只通过 rule.templateId 找模板，不从 Provider 名称猜测。
function resolveTemplateBaseline(
  builtin: ProviderConfigLayerSnapshot,
  providers: ProviderConfigMap,
  providerId: ProviderId,
): ProviderConfig | undefined {
  const templateId = providers.getRule(providerId)?.templateId;
  return templateId ? builtin.providerTemplates?.get(templateId)?.config : undefined;
}

// 继承模型来源优先级：Built-in Provider 自身 → 模板基线 → 空数组。
function resolveProviderBuiltinModelIds(
  builtin: ProviderConfigLayerSnapshot,
  personalProviders: ProviderConfigMap,
  providerId: ProviderId,
): readonly ModelId[] {
  return (
    builtin.providers.get(providerId)?.builtinModelIds ??
    resolveTemplateBaseline(builtin, personalProviders, providerId)?.builtinModelIds ??
    []
  );
}

// label 冲突大小写不敏感，后缀从 " 2" 开始；与 id 的数字后缀规则不同，不能复用。
function nextPersonalProviderLabel(seed: string, providers: ProviderConfigMap): string {
  const base = seed.trim() || "new-provider";
  const labels = new Set(
    providers
      .rules()
      .map((provider) => provider.providerName?.trim().toLocaleLowerCase())
      .filter((label): label is string => Boolean(label)),
  );
  // 无冲突时保留原始大小写；只有冲突才追加序号。
  if (!labels.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!labels.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
