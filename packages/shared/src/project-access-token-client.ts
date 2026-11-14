// ZCode 项目访问令牌客户端：用登录 token 解析项目与 Key，再换取 Coding Plan 访问令牌。
// INV-01 会话键固定为 origin 与 family 的组合，sessionKey 处守卫；改动会让不同 base URL 串用缓存。
// INV-02 登录 token 变化必须清空旧 cache 并递增代次，会话重建分支守卫；否则旧 Key 会泄漏到新账号。
// INV-03 每个会话持有单调递增 generation，String(++#generation) 处赋值；代次回退会让迟到结果污染新会话。
// INV-04 所有跨 await 的副作用前都调用 assertCurrent，闭包处守卫；漏调会让 clear 后的迟到写回生效。
// INV-05 assertCurrent 以会话对象身份比较而非 token 字符串，比较处守卫；换成值比较会放过同 token 重建。
// INV-06 locationKey 由 accountId、team、selection 三元组构成，JSON.stringify 处守卫；减少维度会跨项目复用 Key ID。
// INV-07 storageKey 额外纳入 origin、family、usageScene，模板串处守卫；缺项会让团队与个人位置互相覆盖。
// INV-08 同一 locationKey 只允许一个在途 Promise，locations Map 处去重；去掉会并发创建重复 API Key。
// INV-09 在途 Promise 失败时必须从 Map 删除，catch 回调处守卫；不删会让后续请求永久复用失败结果。
// INV-10 持久化的位置只是缓存，解密失败走 recoverUnreadable 重建，load 的 catch 处守卫；当成登录事实会卡死登录。
// INV-11 恢复失败或非解密错误必须原样抛出，isCredentialDecryptError 判断处守卫；吞掉会掩盖真实 IO 故障。
// INV-12 读出的位置必须通过 locationSchema 且与请求的团队一致，safeParse 处校验；宽松接受会打到错误项目。
// INV-13 customerInfo 使用裸业务 token，headers 处固定；加 Bearer 会被服务端判为登录失效。
// INV-14 个人 Key 管理沿用 family 既有鉴权格式，keyHeaders 分支处守卫；统一格式会让 zai 家族 401。
// INV-15 团队请求必须带 bigmodel-organization 与 bigmodel-project，keyHeaders 处构造；缺头会落到默认机构。
// INV-16 只有明确 404 才废弃 Key ID，raw.code 判断处守卫；把 403 或网络错误当 404 会触发重建回退。
// INV-17 候选 Key 必须名称匹配，团队还要求 keyType 为 2，find 回调处守卫；放宽会复用他人或错误类型 Key。
// INV-18 对外的错误只保留固定错误码，catch 归一化处守卫；透传原始 message 会把上游凭据写进日志。
// INV-19 令牌未启用时抛 project_token_disabled，enabled 判断处守卫；返回空 token 会让调用方静默 401。
// INV-20 客户端不落盘任何凭据，仅 locationStore 保存项目与 Key ID，构造器端口处约束；写 token 会扩大泄密面。
// 变更前先确认对应 INV 的守卫点仍在；本文件任何代码行改动都不属于本次注释任务。
import { z } from "zod";
import { projectTokenSuccessCodeSchema } from "./project-access-token-response.js";
import { API_KEY_USAGE_SCENE } from "./api-key-usage-scene.js";
import { ProjectAccessTokenCache, ProjectAccessTokenError } from "./project-access-token.js";
import { ZCODE_VERSION } from "./version.js";
import { isCredentialDecryptError } from "./oauth.js";

const DEFAULT_ORGANIZATION_NAME = "默认机构";
const DEFAULT_PROJECT_NAME = "默认项目";
// [失败路径] customerInfo 响应先过 zod 再选项目：数组缺失用 default([]) 兜底，字段用 nullish 容忍服务端省略。
// [权衡] organizationName 与 projectName 允许为空，才能在不完整响应下仍按下标回退；代价是默认项目匹配可能落到下标 0。
// projectType 用 string 与 number 联合，兼容服务端按字符串或数字下发类型码；只认一种会把团队项目误判为个人。
const customerSchema = z.object({
  organizations: z
    .array(
      z.object({
        organizationId: z.string(),
        organizationName: z.string().nullish(),
        projects: z
          .array(
            z.object({
              projectId: z.string(),
              projectName: z.string().nullish(),
              projectType: z.union([z.string(), z.number()]).nullish(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
const keySchema = z.object({
  apiKey: z.string().trim().min(1),
  name: z.string().nullish(),
  keyType: z.number().nullish(),
});
// [失败路径] 所有业务响应统一包一层 code 与 data；code 必须命中成功码，否则 readData 直接判为无效响应。
// data 保持 unknown，交给各接口自己的 schema 解析；提前断言会在字段演进时把兼容响应判死。
const envelopeSchema = z.object({
  code: projectTokenSuccessCodeSchema,
  data: z.unknown(),
});

// rejectedProjectTokenFingerprint 是调用方给出的拒绝指纹，透传给 cache；客户端不解释其内容，避免耦合令牌格式。
// [事务] origin 会先归一为 URL.origin，family 参与会话键；两者任一变化都会切到独立缓存，不会造成跨环境串用。
// [权衡] personalProjectSelection 默认 non-team，保留 CLI 与 Host 各自既有选择；改默认值会改变团队项目的可见性。
export interface ProjectAccessTokenInput {
  readonly rejectedProjectTokenFingerprint?: string;
  readonly origin: string;
  readonly family: "bigmodel" | "zai";
  readonly loginToken: string;
  readonly accountId: string;
  /** 保留各调用端既有项目选择；CLI 默认项目不排除团队类型。 */
  readonly personalProjectSelection?: "non-team" | "default";
  readonly team?: {
    readonly organizationId: string;
    readonly projectId: string;
  };
}

export interface ProjectAccessTokenMaterial {
  readonly token: string;
  readonly apiKeyId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

const locationSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  apiKeyId: z.string().min(1),
});
type KeyLocation = z.infer<typeof locationSchema>;
// [并发] 一个会话内 locations 以 locationKey 去重，cache 负责令牌刷新；两者都绑定 generation，clear 后整体作废。
// token 字段只用于判断登录是否切换，不参与比较以外的逻辑；缓存与在途 Promise 都随会话对象一起丢弃。
interface LoginSession {
  token: string;
  generation: string;
  locations: Map<string, Promise<KeyLocation>>;
  cache: ProjectAccessTokenCache;
}

/** Host/CLI 各自持有实例；网络由已有 adapter 注入，凭据不进入配置或磁盘。 */
// [资源] 每个 Host 或 CLI 进程各自持有实例，实例内不存全局状态；网络与存储都从构造器端口注入。
// 类内只有会话表与代次计数器，没有任何磁盘写入路径；凭据与令牌只存在于内存。
export class ProjectAccessTokenClient {
  // [并发] 会话表键是 origin 加 family 的 JSON 串，保证不同站点与不同品牌不共享缓存。
  // [资源] 换登录 token 时旧会话被覆盖，但必须在覆盖前 clear 旧 cache，否则旧令牌会残留在闭包里直到进程退出。
  // #generation 用私有字段单调递增，只在新建会话时加一；该值同时写入 cache 与断言闭包，是失效判定的唯一依据。
  readonly #sessions = new Map<string, LoginSession>();
  #generation = 0;

  // [失败路径] 依赖全部由外部注入：request 决定网络与超时，observe 决定可观测性，locationStore 决定位置持久化。
  // [权衡] locationStore 的 save 与 delete 都带 assertCurrent 回调，让存储在落盘瞬间再校验一次代次。
  // now 与 random 注入是为了测试可控，不传时由 cache 自行取默认实现；不要在客户端内部兜底时间。
  constructor(
    private readonly options: {
      request(url: string, init: RequestInit): Promise<unknown>;
      observe?(event: { family: string; stage: "resolve"; code: string }): void;
      locationStore?: {
        load(key: string): Promise<string | null>;
        save(key: string, value: string, assertCurrent?: () => void): Promise<void>;
        delete(key: string, assertCurrent?: () => void): Promise<void>;
        recoverUnreadable?(key: string, assertCurrent: () => void): Promise<string | null>;
      };
      now?: () => number;
      random?: () => number;
    },
  ) {}

  // [并发] 先清每个会话的缓存再清会话表，顺序不能反；反了会丢掉引用，导致旧令牌的定时任务无法释放。
  // [资源] 清空后所有在途请求会在下一次 assertCurrent 处失败，这是预期行为，调用方应重新登录再取令牌。
  // clear 不删除 locationStore 里的项目位置：位置是可重建缓存，保留它能减少重新解析的服务端往返。
  clear(): void {
    for (const session of this.#sessions.values()) session.cache.clear();
    this.#sessions.clear();
  }

  // [事务] resolve 是唯一入口：先把 origin 归一、去掉登录 token 的 Bearer 前缀，再校验非空。
  // [失败路径] 登录 token 或 accountId 为空时抛 project_token_login_required，避免用空凭据打服务端。
  // 整个流程分三段：定位项目与 Key、用缓存换访问令牌、归一化错误；每段之间都有代次断言。
  async resolve(input: ProjectAccessTokenInput): Promise<ProjectAccessTokenMaterial> {
    const origin = new URL(input.origin).origin;
    const loginToken = input.loginToken.trim().replace(/^Bearer\s+/i, "");
    if (!loginToken || !input.accountId.trim()) throw new Error("project_token_login_required");
    const sessionKey = JSON.stringify([origin, input.family]);
    // [并发] 会话键只含 origin 与 family，不含 accountId；同一进程切换账号靠 token 不等来重建会话。
    // [事务] 新建会话时先 clear 旧 cache 再写入新对象，保证旧令牌的刷新任务立即失效。
    // 若沿用旧会话，必须确认 token 完全一致；仅比较前缀或大小写会放过实际已切换的登录。
    let session = this.#sessions.get(sessionKey);
    if (!session || session.token !== loginToken) {
      session?.cache.clear();
      session = {
        token: loginToken,
        generation: String(++this.#generation),
        locations: new Map(),
        cache: new ProjectAccessTokenCache({
          now: this.options.now,
          random: this.options.random,
          onRefreshDeferred: () =>
            this.options.observe?.({
              family: input.family,
              stage: "resolve",
              code: "project_token_refresh_deferred",
            }),
        }),
      };
      this.#sessions.set(sessionKey, session);
    }
    // [并发] current 固定住本次调用看到的会话快照，后续所有读写都通过它，避免中途被其他调用替换。
    // assertCurrent 用对象身份判断会话是否仍有效；这比比较 token 更严格，能识别同 token 的并发重建。
    // [失败路径] 断言失败抛 project_token_scope_invalidated，上层会把它归一为固定错误码，不暴露内部状态。
    const current = session;
    const assertCurrent = () => {
      if (this.#sessions.get(sessionKey) !== current)
        throw new ProjectAccessTokenError("project_token_scope_invalidated");
    };
    const headers = {
      Authorization: `Bearer ${loginToken}`,
      "Content-Type": "application/json",
    };
    // [并发] 注入的 request 前后各断言一次代次，覆盖等待网络期间被 clear 的窗口。
    // [失败路径] 断言在网络调用前执行，能在发出请求前就阻止已作废会话继续消耗资源。
    // 包装层不重试也不吞错：重试会导致重复创建 Key，吞错会让调用方拿到不一致的位置。
    const request = async (url: string, init: RequestInit) => {
      assertCurrent();
      const result = await this.options.request(url, init);
      assertCurrent();
      return result;
    };
    try {
      // [事务] 指定 team 时 selection 为 null，位置键只由 team 决定；个人模式才区分 non-team 与 default。
      // [权衡] selection 参与 locationKey，但 team 模式忽略它；把 selection 混进团队键会造成无意义的缓存分裂。
      // locationKey 与 storageKey 必须由同一组输入派生，否则内存命中的位置与磁盘记录会指向不同项目。
      const selection = input.team ? null : (input.personalProjectSelection ?? "non-team");
      const locationKey = JSON.stringify([input.accountId, input.team ?? null, selection]);
      const storageKey = `project-key-location:v1:${encodeURIComponent(JSON.stringify([origin, input.family, input.accountId, input.team ?? null, API_KEY_USAGE_SCENE.CODING_PLAN, selection]))}`;
      // [并发] locations 里的值是 Promise 而非结果：同一位置并发调用共享一次解析，避免重复拉取客户信息。
      // [资源] 命中在途 Promise 后不再发起任何网络请求，但仍要在 await 之后断言代次。
      // 存储键带 v1 前缀与编码后的 JSON，便于未来格式迁移时整体失效，同时避免分隔符歧义。
      let pending = current.locations.get(locationKey);
      if (!pending) {
        pending = (async () => {
          let saved: string | null | undefined;
          try {
            saved = await this.options.locationStore?.load(storageKey);
          } catch (error) {
            // 异常分支也必须先校验代次；clear 后的迟到失败不得触发恢复副作用。
            assertCurrent();
            if (!isCredentialDecryptError(error) || !this.options.locationStore?.recoverUnreadable)
              throw error;
            // 恢复端口本身可能发生 IO 错误；先保留固定诊断，避免外层错误归一后丢失解密线索。
            this.options.observe?.({
              family: input.family,
              stage: "resolve",
              code: "project_token_location_unreadable",
            });
            // 位置是可重建缓存，不是登录事实。恢复端口在共享锁内重读并仅删除仍坏的记录。
            saved = await this.options.locationStore.recoverUnreadable(storageKey, assertCurrent);
            assertCurrent();
            this.options.observe?.({
              family: input.family,
              stage: "resolve",
              code: "project_token_location_recovery",
            });
          }
          assertCurrent();
          // [失败路径] 读取位置失败时先断言再判断错误类型，确保 clear 后的迟到失败不触发恢复副作用。
          // 只有凭据解密错误且存在恢复端口时才走 recoverUnreadable；其他 IO 错误原样抛出，避免掩盖磁盘问题。
          // [事务] 恢复端口在共享锁内重读并只删除仍损坏的记录，恢复成功后重新断言并上报固定诊断码。
          if (saved) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(saved);
            } catch {
              /* 损坏记录通过正常元数据流程重建。 */
            }
            const value = locationSchema.safeParse(parsed);
            if (
              value.success &&
              (!input.team ||
                (value.data.organizationId === input.team.organizationId &&
                  value.data.projectId === input.team.projectId))
            )
              return value.data;
          }
          // [事务] 解析结果写盘前先断言，写盘后再断言；两次断言夹住 IO，保证作废会话不会留下新记录。
          // [失败路径] 解析或写盘失败时，外层会在 pending 的 catch 里删除该 locationKey。
          // 保存的是组织、项目与 Key ID，不含任何令牌；读取方只把它当提示，仍会走 schema 校验。
          const result = await this.#resolveLocation(input, origin, loginToken, request);
          assertCurrent();
          await this.options.locationStore?.save(storageKey, JSON.stringify(result), assertCurrent);
          assertCurrent();
          return result;
        })();
        current.locations.set(locationKey, pending);
        void pending.catch(() => {
          if (current.locations.get(locationKey) === pending) current.locations.delete(locationKey);
        });
      }
      const location = await pending;
      assertCurrent();
      // [并发] 令牌换取交给 ProjectAccessTokenCache：它负责过期、并发去重与延迟刷新，客户端不自行缓存令牌。
      // [事务] loginGeneration 随请求传入，缓存据此判断结果是否属于当前登录；代次不符的结果不得写回。
      // [资源] 位置字段展开进请求参数，usageScene 固定为 Coding Plan，防止同一 Key 被其他场景复用。
      const value = await current.cache.resolve(
        {
          origin,
          family: input.family,
          accountId: input.accountId,
          ...location,
          usageScene: API_KEY_USAGE_SCENE.CODING_PLAN,
          loginGeneration: current.generation,
        },
        async () => {
          const raw = await request(
            `${keyListUrl(origin, location)}/${encodeURIComponent(location.apiKeyId)}/access_tokens`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                clientType: "zcode",
                clientVersion: ZCODE_VERSION,
              }),
            },
          );
          // 仅明确不存在才废弃 ID；权限/网络/开关错误不能触发创建或 Key 回退。
          // [失败路径] 仅当响应体明确带 code 等于 404 时才认为 Key 已不存在，并删除内存与磁盘位置。
          // [权衡] 403、5xx 与网络错误都不触发删除：把权限问题误判为不存在会重建 Key，放大故障面。
          // 删除后仍返回原始响应，由缓存层决定如何报错；此处不抛异常，避免与错误归一逻辑重复。
          if (raw && typeof raw === "object" && "code" in raw && raw.code === 404) {
            current.locations.delete(locationKey);
            await this.options.locationStore?.delete(storageKey, assertCurrent);
          }
          return raw;
        },
        input.rejectedProjectTokenFingerprint,
      );
      assertCurrent();
      // [失败路径] 缓存返回未启用时抛 project_token_disabled，调用方应提示开通而非重试。
      // 返回材料只拼接 token 与位置字段，不携带账号或登录 token，缩小凭据在调用链上的传播范围。
      if (!value.enabled) throw new Error("project_token_disabled");
      return { token: value.token, ...location };
    } catch (error) {
      // 上游错误体或网络异常可能携带凭据；只传播固定错误码，不保留原始 cause/message。
      // [失败路径] 错误归一化只保留白名单错误码；ProjectAccessTokenError 直接取其 code，其余映射为请求失败。
      // [权衡] 上游错误体可能回显凭据，因此不保留 cause 与原始 message，只上报固定码。
      // 上报发生在抛出之前，保证每次失败都有一次 observe 事件；观察器自身异常不应阻断主流程。
      const code =
        error instanceof ProjectAccessTokenError
          ? error.code
          : error instanceof Error &&
              [
                "project_token_disabled",
                "project_token_project_unavailable",
                "project_token_invalid_response",
              ].includes(error.message)
            ? error.message
            : "project_token_request_failed";
      this.options.observe?.({ family: input.family, stage: "resolve", code });
      throw new Error(code);
    }
  }

  // [事务] 定位分两步：先用 customerInfo 校验组织与项目归属，再列出或创建专属 API Key。
  // [失败路径] 客户信息或 Key 列表 schema 不通过时统一抛 project_token_invalid_response。
  // 该方法是私有的，只能由 resolve 的在途 Promise 调用，从而继承同一份代次断言。
  async #resolveLocation(
    input: ProjectAccessTokenInput,
    origin: string,
    loginToken: string,
    request: (url: string, init: RequestInit) => Promise<unknown>,
  ): Promise<KeyLocation> {
    // customerInfo 要求裸业务 token；Bearer 格式拒绝会被误判为登录失效。
    const headers = {
      Authorization: loginToken,
      "Content-Type": "application/json",
    };
    // [失败路径] readData 已校验外层成功码，这里再用 customerSchema 校验组织与项目结构，两层都过才继续。
    // [权衡] 组织与项目数组缺省为空，随后按空集合判定项目不可用，而不是当作无效响应。
    const customer = customerSchema.safeParse(
      readData(
        await request(`${origin}/api/biz/customer/getCustomerInfo`, {
          method: "GET",
          headers,
        }),
      ),
    );
    if (!customer.success) throw new Error("project_token_invalid_response");
    const organizations = customer.data.organizations;
    // [失败路径] 团队模式要求组织与项目同时命中（trim 后比较），任一不匹配抛 project_token_project_unavailable。
    // [事务] 个人模式按 selection 过滤：non-team 排除 projectType 为 2 的团队项目，default 保留全部。
    // [权衡] defaultProject 只是启发式：名称含默认机构与默认项目优先，取不到再退回首个可用组织与项目。
    let location = input.team;
    if (location) {
      if (
        !organizations.some(
          (org) =>
            org.organizationId.trim() === location!.organizationId.trim() &&
            org.projects.some((p) => p.projectId.trim() === location!.projectId.trim()),
        )
      )
        throw new Error("project_token_project_unavailable");
    } else {
      const personal =
        input.personalProjectSelection === "default"
          ? organizations
          : organizations
              .map((org) => ({
                ...org,
                projects: org.projects.filter((p) => String(p.projectType ?? "").trim() !== "2"),
              }))
              .filter((org) => org.organizationId && org.projects.length);
      const org =
        personal.find((org) => org.organizationName?.includes(DEFAULT_ORGANIZATION_NAME)) ??
        personal[0];
      const project =
        org?.projects.find((p) => p.projectName?.includes(DEFAULT_PROJECT_NAME)) ??
        org?.projects[0];
      if (!org?.organizationId || !project?.projectId)
        throw new Error("project_token_project_unavailable");
      location = {
        organizationId: org.organizationId,
        projectId: project.projectId,
      };
    }
    const url = keyListUrl(origin, location);
    const name = input.team ? "zcode-team-api-key" : "zcode-api-key";
    // [事务] 团队请求额外带 bigmodel-organization 与 bigmodel-project，Key 才能落到指定项目。
    // [失败路径] 个人请求按 family 决定是否加 Bearer：zai 需要，bigmodel 只接受裸 token。
    // 两套头部都从同一份裸 token 派生；混用会导致 401 或把 Key 建到默认机构。
    const keyHeaders = input.team
      ? {
          ...headers,
          Authorization: loginToken,
          "bigmodel-organization": location.organizationId,
          "bigmodel-project": location.projectId,
        }
      : {
          ...headers,
          // 个人 Key 管理保留既有格式，不能套用 customerInfo 的鉴权约定。
          Authorization: input.family === "zai" ? `Bearer ${loginToken}` : loginToken,
        };
    const list = z
      .array(z.unknown())
      .safeParse(readData(await request(url, { method: "GET", headers: keyHeaders })));
    if (!list.success) throw new Error("project_token_invalid_response");
    // 列表可能含无关坏条目。个人同名条目缺 ID 时禁止重复创建；团队只复用有效条目。
    // [并发] 复用候选前先按名称过滤，团队条目还要求 keyType 为 2，避免误用个人 Key 或他类型 Key。
    // [权衡] 个人同名条目即使缺 ID 也视为候选，宁可让 schema 报错也不重复创建，防止 Key 数量膨胀。
    // [资源] 只有完全没有候选时才 POST 创建，创建体固定 usageScene，团队还带 keyType 2。
    const candidate = list.data.find((entry) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || entry.name !== name)
        return false;
      if (!input.team) return true;
      const parsed = keySchema.safeParse(entry);
      return parsed.success && parsed.data.keyType === 2;
    });
    const rawKey =
      candidate ??
      readData(
        await request(url, {
          method: "POST",
          headers: keyHeaders,
          body: JSON.stringify({
            name,
            ...(input.team ? { keyType: 2 } : {}),
            usageScene: API_KEY_USAGE_SCENE.CODING_PLAN,
          }),
        }),
      );
    const key = keySchema.safeParse(rawKey);
    if (!key.success || (input.team && (key.data.name !== name || key.data.keyType !== 2)))
      throw new Error("project_token_invalid_response");
    return { ...location, apiKeyId: key.data.apiKey };
  }
}

function keyListUrl(
  origin: string,
  location: { organizationId: string; projectId: string },
): string {
  return `${origin}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys`;
}

// [失败路径] 统一信封解析：成功码不匹配或结构不符都抛 project_token_invalid_response。
// 返回 data 不做二次断言，调用方各自用 schema 解析，保持各接口的严格程度独立。
function readData(raw: unknown): unknown {
  const value = envelopeSchema.safeParse(raw);
  if (!value.success) throw new Error("project_token_invalid_response");
  return value.data.data;
}
