/* ============================================================
 * MCP OAuth 授权会话（legacy provider，adapters/src/mcp/oauth.ts）
 *
 * 定位：MCP SDK 认证集成的最旧实现——自建 localhost 回调 + 完整 OAuthClientProvider。
 * 当前策略：provider 不再直接完成授权，`redirectToAuthorization` 一律抛出
 * interactiveRequired，由 adapter 转入 oauth-interactive 的 Phase 2 fresh DCR 事务；
 * 但本文件保留作为 SDK 兼容 seam，并负责凭据读取兼容与条件失效。
 * 输入：authorization_code 配置、serverName/serverUrl、回调 URL 展示与打开回调。
 * 输出：McpOAuthSession（provider + 回调等待 + 超时 + close）。
 * 副作用：localhost 监听、凭据读写（含 PKCE verifier per-state 落盘）、日志。
 * 失败语义：client 缺失直接 interactiveRequired；回调超时由调用方用 timeoutMs 收口；
 * close 中 verifier 清理失败只告警，不反转主链路。
 * 不变量：credential key 由 serverName+serverUrl+clientId+scope+redirectPath 的 hash 决定，
 * 任一授权语义变化 => 新 keyPrefix => 必须重新授权；失效删除全部走 compare-and-delete。
 * ============================================================ */

import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import {
  createLocalhostOAuthCallbackServer,
  type LocalhostOAuthCallbackServer,
} from "../auth/localhost-callback.js";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import {
  deriveCredentialPair,
  isCanonicalCredentials,
  isRecord,
  MCP_OAUTH_CANONICAL_CREDENTIALS_KEY,
  MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS,
  publishCanonicalCredentials,
  type McpOAuthCanonicalCredentials,
} from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import {
  loadDiscoveryRecord,
  saveDiscoveryRecord,
  type McpOAuthAuthorizationContext,
} from "./oauth-shared.js";

const DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface CredentialSnapshot<T> {
  raw: string;
  value: T;
}

interface StoredCredentialPair {
  clientInformation?: OAuthClientInformationMixed;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

type TransactionClientSource = "canonical" | "legacy" | "registered";
type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export type { McpOAuthAuthorizationContext };

/**
 * 运行时可选项。
 * authorizationTimeoutMs：等人点击的上限（缺省 5 分钟）；
 * credentialStore：测试/宿主注入的共享凭据 store；
 * 两个回调分别用于展示授权 URL 与显式打开浏览器（默认不自动打开）。
 */
export interface McpOAuthRuntimeOptions {
  authorizationTimeoutMs?: number;
  credentialStore?: SharedZCodeCredentialStore;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
}

/**
 * 会话句柄。
 * provider：交给 SDK；timeoutMs：建议的回调等待预算；
 * hasPendingAuthorization：是否已进入授权等待（用于快速失败/展示）；
 * waitForAuthorizationCallback：阻塞直到回调或监听关闭；
 * close：关闭监听并 best-effort 清 verifier，必须由调用方 finally 调用。
 */
export interface McpOAuthSession {
  close(): Promise<void>;
  readonly provider: OAuthClientProvider;
  readonly timeoutMs: number;
  hasPendingAuthorization(): boolean;
  waitForAuthorizationCallback(): Promise<URLSearchParams>;
}

/**
 * 创建授权会话。
 *
 * 每次调用新建随机 state 与 localhost 监听（端口随机），并据此构造 provider；
 * credential keyPrefix 由 server 身份 + 授权配置派生，配置变化即自然隔离旧凭据。
 * 副作用：绑定端口、可能创建凭据目录；失败（端口不可用等）向上抛给调用方。
 */
export async function createMcpAuthorizationCodeOAuthSession(input: {
  adapterInstanceId?: string;
  config: McpAuthorizationCodeOAuthConfig;
  logger?: Logger;
  options?: McpOAuthRuntimeOptions;
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthSession> {
  const state = randomBytes(24).toString("base64url");
  const callbackPath = normalizeCallbackPath(input.config.redirectPath, input.serverName);
  const callbackServer = await createLocalhostOAuthCallbackServer({
    callbackPath,
    state,
  });
  const credentialStore = input.options?.credentialStore ?? createSharedZCodeCredentialStore();
  const keyPrefix = createCredentialKeyPrefix(input.serverName, input.serverUrl, input.config);
  const provider = new ZCodeMcpAuthorizationCodeProvider({
    adapterInstanceId: input.adapterInstanceId,
    callbackServer,
    config: input.config,
    credentialStore,
    keyPrefix,
    logger: input.logger,
    onAuthorizationRequired: input.options?.onAuthorizationRequired,
    openAuthorizationUrl: input.options?.openAuthorizationUrl,
    serverName: input.serverName,
    state,
  });

  return {
    close: async () => {
      await callbackServer.close();
      await provider.close();
    },
    provider,
    timeoutMs: input.options?.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
    hasPendingAuthorization: () => provider.hasPendingAuthorization(),
    waitForAuthorizationCallback: async () => {
      const callback = await callbackServer.waitForCallback();
      return new URL(callback.url).searchParams;
    },
  };
}

/**
 * legacy provider：实现 SDK 的 OAuthClientProvider 契约。
 *
 * 状态缓存（canonical/legacy 原始快照）用于 compare-and-delete；事务内 client 只留内存；
 * tokens() 返回已存 pair（SDK 可能据此跳过授权）；但在 redirectToAuthorization 处一律
 * handoff 到 Phase 2。所有磁盘写入均为多 key 原子或按原始值条件删除。
 */
class ZCodeMcpAuthorizationCodeProvider implements OAuthClientProvider {
  private readonly adapterInstanceId?: string;
  private readonly callbackServer: LocalhostOAuthCallbackServer;
  private readonly config: McpAuthorizationCodeOAuthConfig;
  private readonly credentialStore: SharedZCodeCredentialStore;
  private readonly keyPrefix: string;
  private readonly logger?: Logger;
  private readonly onAuthorizationRequired?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly openAuthorizationUrl?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly serverName: string;
  private readonly stateValue: string;
  private readonly transactionId: string;
  private canonicalSnapshot?: CredentialSnapshot<McpOAuthCanonicalCredentials>;
  private credentialSnapshotsLoaded = false;
  private legacyClientSnapshot?: CredentialSnapshot<OAuthClientInformationMixed>;
  private legacyTokensSnapshot?: CredentialSnapshot<OAuthTokens>;
  private storedCredentialPair?: StoredCredentialPair;
  private storedCredentialPairLoaded = false;
  private pendingAuthorization = false;
  private transactionClientInformation?: OAuthClientInformationMixed;
  private transactionClientSource?: TransactionClientSource;
  private verifierPersisted = false;

  constructor(input: {
    adapterInstanceId?: string;
    callbackServer: LocalhostOAuthCallbackServer;
    config: McpAuthorizationCodeOAuthConfig;
    credentialStore: SharedZCodeCredentialStore;
    keyPrefix: string;
    logger?: Logger;
    onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    serverName: string;
    state: string;
  }) {
    this.adapterInstanceId = input.adapterInstanceId;
    this.callbackServer = input.callbackServer;
    this.config = input.config;
    this.credentialStore = input.credentialStore;
    this.keyPrefix = input.keyPrefix;
    this.logger = input.logger;
    this.onAuthorizationRequired = input.onAuthorizationRequired;
    this.openAuthorizationUrl = input.openAuthorizationUrl;
    this.serverName = input.serverName;
    this.stateValue = input.state;
    this.transactionId = createHash("sha256").update(input.state).digest("hex");
  }

  /** 当前事务的 localhost 回调地址；provider 生命周期内端口不变。 */
  get redirectUrl(): string {
    return this.callbackServer.callbackUrl;
  }

  /** DCR 元数据：redirect_uris 为当前监听；scope 取静态配置，注意与并集 scope 的差异由 Phase 2 处理。 */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? `ZCode ${this.serverName}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      ...(this.config.clientSecret ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  /** 事务 state：创建时固定；用于回调校验，不写日志原文。 */
  state(): string {
    return this.stateValue;
  }

  /**
   * 取 client：静态配置优先；其次本事务内存；再次持久化 pair 的 client。
   * 都没有时抛 interactiveRequired（而不是返回 undefined 触发 SDK 动态注册——
   * DCR 归属已移交 Phase 2，避免留下永不被使用的注册）。
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    if (this.transactionClientInformation) {
      return this.transactionClientInformation;
    }

    const storedPair = await this.loadStoredCredentialPair();
    if (storedPair?.clientInformation) {
      this.transactionClientInformation = storedPair.clientInformation;
      this.transactionClientSource = storedPair.source;
      return this.transactionClientInformation;
    }

    // 修复原因（根因 2 的过渡 seam）：返回 undefined 会让 SDK 立刻做一次动态注册，而 DCR 的
    // 归属已经整体移交 Phase 2。没有 client 也就没有 refresh token，本来就只能交互授权，
    // 因此这里直接抛 interactiveRequired，避免在授权服务器上留下一个永不会被使用的注册。
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_credentials",
      serverName: this.serverName,
    });
  }

  /**
   * 保存 DCR client：先写 legacy client 作为重建种子，再固定到本事务内存。
   * 当前事务后续只读内存值，避免被并发注册覆盖。
   */
  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    // 修复原因：MCP SDK 在 authorization code exchange 时会再次读取 provider。
    // 动态注册结果必须固定在当前 state 对应的 provider 实例；同时先写入 legacy client
    // 作为 provider 重建后的恢复种子。当前事务后续只读内存值，不会被并发注册覆盖。
    await this.credentialStore.save(
      this.key("client_information"),
      JSON.stringify(clientInformation),
    );
    this.transactionClientInformation = clientInformation;
    this.transactionClientSource = "registered";
  }

  /** 返回已持久化的 token pair；无则 undefined（SDK 会继续授权流程）。 */
  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.loadStoredCredentialPair())?.tokens;
  }

  /**
   * 发布 token：client 与 tokens 走同一次 canonical 原子发布，并同步更新内存快照
   * （供后续条件失效使用）。日志只记录 client 的 hash、generation 前缀与是否轮换。
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const clientInformation = await this.clientInformation();
    if (!clientInformation) {
      throw new Error(`Missing MCP OAuth client information for ${this.serverName}`);
    }
    const previousTokens = this.storedCredentialPair?.tokens;
    // 通过共享 helper 发布，确保 Phase 2 与本 provider 写出的 canonical 形态完全一致
    // （含每次 publication 唯一的 generation）。client 与 refresh token 必须来自同一次授权，
    // 三个 key 仍在同一个跨进程 read-modify-write 临界区内原子写入。
    const published = await publishCanonicalCredentials(this.credentialStore, this.keyPrefix, {
      clientInformation,
      publishedBy: this.transactionId,
      tokens,
    });
    this.canonicalSnapshot = { raw: published.raw, value: published.canonical };
    this.legacyClientSnapshot = { raw: published.legacyClientRaw, value: clientInformation };
    this.legacyTokensSnapshot = { raw: published.legacyTokensRaw, value: tokens };
    this.credentialSnapshotsLoaded = true;
    this.storedCredentialPair = {
      clientInformation,
      source: "legacy",
      tokens,
    };
    this.storedCredentialPairLoaded = true;
    this.transactionClientSource = "canonical";
    // 修复原因：授权与刷新过去都没有成功侧事件，日志里只能看到 authorization.required，
    // 无法判断一次 refresh 到底成功过没有。只记录安全标识与形态，不记录任何 token 明文。
    this.logger?.info("MCP OAuth credentials published", {
      event: "mcp.oauth.credentials.published",
      ...this.logContext(),
      clientIdHash: hashIdentifier(clientInformation.client_id),
      grantKind: previousTokens ? "refresh" : "authorization_code",
      hasRefreshToken: Boolean(tokens.refresh_token),
      publishedGeneration: published.generation.slice(0, 12),
      refreshTokenRotated: Boolean(
        previousTokens?.refresh_token &&
          tokens.refresh_token &&
          previousTokens.refresh_token !== tokens.refresh_token,
      ),
      status: "completed",
      tokenExpiresInSeconds: tokens.expires_in,
    });
  }

  /**
   * 授权入口一律 handoff：持久化 DCR client 的 redirect_uris 锁死旧端口，
   * 继续投影该 URL 会被 AS 按 RFC 6749 拒绝且永不回调。因此不打开浏览器、不等待，
   * 直接抛 interactiveRequired，由编排层转入 Phase 2 fresh DCR。
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorization = true;
    // 修复原因（根因 2 的过渡 seam）：本 provider 复用持久化的 DCR client，而它的 redirect_uris
    // 锁死在注册当时的随机端口，`authorizationUrl` 因此可能带「旧 client_id + 新 redirect_uri」。
    // 授权服务器按 RFC 6749 §4.1.2.1 禁止回跳、就地渲染错误页，回调永不到达且重试永不自愈。
    // 所以这里不再投影该 URL、也不打开浏览器，而是抛出 interactiveRequired，由 adapter 编排层
    // 转入 Phase 2 的 fresh DCR 授权事务（见 docs/mcp-oauth-two-phase.md §4.7）。
    this.logger?.warn("MCP OAuth authorization handed off to interactive transaction", {
      event: "mcp.oauth.authorization.handoff",
      ...this.logContext(),
      callbackPort: Number(new URL(this.redirectUrl).port),
      status: "cancelled",
    });
    void authorizationUrl;
    throw createInteractiveAuthorizationRequiredError({
      reason: "legacy_provider_seam",
      serverName: this.serverName,
    });
  }

  /** PKCE verifier 按 state 落到共享 store：SDK 的 exchange 可能发生在 provider 之外。 */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.credentialStore.save(this.verifierKey(), codeVerifier);
    this.verifierPersisted = true;
  }

  /** 读取本 state 的 verifier；缺失说明事务已关闭/被清理，抛错让调用方重新授权。 */
  async codeVerifier(): Promise<string> {
    const codeVerifier = await this.credentialStore.load(this.verifierKey());
    if (!codeVerifier) {
      throw new Error(`Missing MCP OAuth PKCE verifier for ${this.serverName}`);
    }
    this.verifierPersisted = true;
    return codeVerifier;
  }

  /** 与 Phase 2 共用同一份带 TTL 的 discovery 记录，避免两侧缓存口径分裂。 */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    // 与 Phase 2 共用同一份带时间戳的 discovery 记录：否则一侧刷新了 AS metadata，另一侧
    // 仍可能使用无 TTL 的旧缓存。
    await saveDiscoveryRecord(this.credentialStore, this.keyPrefix, state);
  }

  /** 读取共享 discovery 记录；过期/损坏返回 undefined，下次调用会重新 discovery。 */
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return await loadDiscoveryRecord(this.credentialStore, this.keyPrefix);
  }

  /**
   * SDK 触发的失效回调：scope 与 OAuth error 一一对应（tokens←invalid_grant，
   * client/all←invalid_client）。删除全部按快照原始值 CAS；canonical 已被他人替换时
   * 保留 winner。附带脱敏告警日志，弥补 SDK 不把错误码传出来的可观测性缺口。
   */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    // 修复原因：过去 refresh 失败只在 SDK 内部分类，ZCode 侧不留任何痕迹，事后无法区分
    // token 过期、被撤销、client mismatch 和服务端临时错误（见 docs/analysis 的可观测性缺口）。
    // SDK 不把 OAuth error code 传给 provider，但 invalidation scope 与之一一对应：
    // tokens ← invalid_grant；client/all ← invalid_client / unauthorized_client。
    this.logger?.warn("MCP OAuth credentials invalidated", {
      event: "mcp.oauth.credentials.invalidated",
      ...this.logContext(),
      invalidationScope: scope,
      status: "failed",
    });
    if (scope === "all" || scope === "client" || scope === "tokens") {
      await this.invalidateCredentialSnapshot(scope);
    }
    if (scope === "all" || scope === "verifier") {
      await this.clearVerifier();
    }
    if (scope === "all" || scope === "discovery") {
      await this.credentialStore.delete(this.key("discovery_state"));
    }
  }

  /** 是否已进入“等待用户在浏览器授权”状态（redirectToAuthorization 被调用后为 true）。 */
  hasPendingAuthorization(): boolean {
    return this.pendingAuthorization;
  }

  /**
   * 关闭事务：best-effort 清理本 state 的 verifier（失败只告警，不反转连接结果），
   * 清空事务 client 与所有凭证快照，防止后续误用旧值。
   */
  async close(): Promise<void> {
    // 修复原因：PKCE verifier 只属于当前 state。adapter 超时或关闭时必须清理本事务，
    // 不能再删除相同 MCP 配置下另一个并发授权正在等待的 verifier。清理属于 best-effort：
    // token exchange 已成功时，锁超时或损坏文件不能把主链路反转成连接失败。
    try {
      await this.clearVerifier();
    } catch (error) {
      this.logger?.warn("MCP OAuth verifier cleanup failed", {
        event: "mcp.oauth.verifier.cleanup_failed",
        adapterInstanceId: this.adapterInstanceId,
        error: error instanceof Error ? error.message : String(error),
        mcpServerName: this.serverName,
        oauthStateId: this.transactionId.slice(0, 16),
        processId: process.pid,
        status: "failed",
      });
    }
    this.transactionClientInformation = undefined;
    this.transactionClientSource = undefined;
    this.resetCredentialSnapshots();
  }

  /**
   * 按快照原始值条件删除 canonical/legacy key。
   * canonicalDeleted=false 表示期间有别的进程发布了新 pair，本次失效整体放弃（保留 winner）；
   * canonicalDeleted=true 时把事务 client 来源标记为 registered，允许用同一 client 重新授权。
   */
  private async invalidateCredentialSnapshot(scope: "all" | "client" | "tokens"): Promise<void> {
    await this.loadCredentialSnapshots();
    const canonicalSnapshot = this.canonicalSnapshot;
    const expectedValues: Record<string, string> = {};
    if (canonicalSnapshot) {
      expectedValues[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)] = canonicalSnapshot.raw;
    }
    if ((scope === "all" || scope === "client") && this.legacyClientSnapshot) {
      expectedValues[this.key("client_information")] = this.legacyClientSnapshot.raw;
    }
    if (
      (scope === "all" || scope === "client" || scope === "tokens") &&
      this.legacyTokensSnapshot
    ) {
      expectedValues[this.key("tokens")] = this.legacyTokensSnapshot.raw;
    }
    const deleted = await this.credentialStore.deleteIfValues(expectedValues);
    const canonicalDeleted = canonicalSnapshot
      ? deleted[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]
      : undefined;
    this.logger?.warn("MCP OAuth credential snapshot invalidation resolved", {
      event: "mcp.oauth.credentials.invalidate_snapshot",
      ...this.logContext(),
      canonicalDeleted,
      // canonicalDeleted=false 表示 compare-and-delete 失败：另一个事务已发布新 pair，
      // 本次失效必须保留 winner。这是并发收口的正常结果，不是错误。
      hadCanonicalSnapshot: Boolean(canonicalSnapshot),
      invalidationScope: scope,
      legacyClientDeleted: deleted[this.key("client_information")],
      legacyTokensDeleted: deleted[this.key("tokens")],
      status: canonicalDeleted === false ? "cancelled" : "completed",
    });

    if (scope === "all" || scope === "client") {
      this.transactionClientInformation = undefined;
      this.transactionClientSource = undefined;
    } else if (
      this.transactionClientSource === "canonical" ||
      (canonicalSnapshot && this.transactionClientSource === "legacy")
    ) {
      if (canonicalDeleted === false) {
        // 修复原因：当前快照已被其他进程替换时，失败方不能删除新 pair；清空本地缓存，
        // 让 SDK 的同一次重试重新读取获胜事务发布的 client/tokens。
        this.transactionClientInformation = undefined;
        this.transactionClientSource = undefined;
      } else if (canonicalDeleted === true) {
        // token 已失效但动态 client 仍可用于当前 provider 重新授权。
        this.transactionClientSource = "registered";
      }
    }

    this.resetCredentialSnapshots();
  }

  /**
   * 一次 loadMany 读取三个 key 并缓存原始快照。
   * 未知版本（新 CLI 写入）只在内存忽略、不删除；结构损坏才按 raw CAS 删除。
   * 只有全部成功后才置 loaded=true，读取失败会让下一次调用重试。
   */
  private async loadCredentialSnapshots(): Promise<void> {
    if (this.credentialSnapshotsLoaded) return;
    const canonicalKey = this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
    const legacyClientKey = this.key("client_information");
    const legacyTokensKey = this.key("tokens");
    const values = await this.credentialStore.loadMany([
      canonicalKey,
      legacyClientKey,
      legacyTokensKey,
    ]);
    const parsedCanonicalSnapshot = await this.parseJsonSnapshot<McpOAuthCanonicalCredentials>(
      canonicalKey,
      values[canonicalKey],
    );
    let canonicalSnapshot: CredentialSnapshot<McpOAuthCanonicalCredentials> | undefined;
    if (
      parsedCanonicalSnapshot &&
      isRecord(parsedCanonicalSnapshot.value) &&
      typeof parsedCanonicalSnapshot.value.version === "number" &&
      !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(parsedCanonicalSnapshot.value.version)
    ) {
      // 修复原因：CLI 与 desktop 会独立升级但共享凭据文件。旧版本只能忽略未知版本，
      // 不能把新版本写入的 canonical pair 当损坏数据删除。
    } else if (parsedCanonicalSnapshot && !isCanonicalCredentials(parsedCanonicalSnapshot.value)) {
      await this.credentialStore.deleteIfValue(canonicalKey, parsedCanonicalSnapshot.raw);
    } else {
      canonicalSnapshot = parsedCanonicalSnapshot;
    }
    const legacyClientSnapshot = await this.parseJsonSnapshot<OAuthClientInformationMixed>(
      legacyClientKey,
      values[legacyClientKey],
    );
    const legacyTokensSnapshot = await this.parseJsonSnapshot<OAuthTokens>(
      legacyTokensKey,
      values[legacyTokensKey],
    );

    // 修复原因：共享凭据读取可能因锁超时或临时 I/O 失败而抛错。只有完整快照成功后
    // 才发布缓存和 loaded 标志，确保同一个 provider 的下一次调用仍会重试。
    this.canonicalSnapshot = canonicalSnapshot;
    this.legacyClientSnapshot = legacyClientSnapshot;
    this.legacyTokensSnapshot = legacyTokensSnapshot;
    this.credentialSnapshotsLoaded = true;
  }

  /** 解析单个 JSON 快照；损坏时按 raw CAS 删除该 key 并返回 undefined（自愈）。 */
  private async parseJsonSnapshot<T>(
    key: string,
    raw: string | null | undefined,
  ): Promise<CredentialSnapshot<T> | undefined> {
    if (!raw) return undefined;
    try {
      return { raw, value: JSON.parse(raw) as T };
    } catch {
      await this.credentialStore.deleteIfValue(key, raw);
      return undefined;
    }
  }

  /**
   * 从已读快照派生可用 pair（共享纯函数），不再重复读文件。
   * 快照原始值仍保留在本类，用于后续 compare-and-delete。
   */
  private async loadStoredCredentialPair(): Promise<StoredCredentialPair | undefined> {
    if (this.storedCredentialPairLoaded) return this.storedCredentialPair;
    await this.loadCredentialSnapshots();
    // 委托给共享的纯函数：canonical 与 legacy 镜像的交错兼容规则只能有一份，两处各写一遍必然
    // 发散。用已经读到的快照派生，不再多读一次凭据文件；快照本身仍留在本类里，因为
    // compare-and-delete 需要发起方读到的原始值。
    const pair = deriveCredentialPair({
      canonicalRaw: this.canonicalSnapshot?.raw,
      legacyClientRaw: this.legacyClientSnapshot?.raw,
      legacyTokensRaw: this.legacyTokensSnapshot?.raw,
    });
    this.storedCredentialPair = pair
      ? {
          ...(pair.clientInformation ? { clientInformation: pair.clientInformation } : {}),
          source: pair.source,
          ...(pair.tokens ? { tokens: pair.tokens } : {}),
        }
      : undefined;
    this.storedCredentialPairLoaded = true;
    return this.storedCredentialPair;
  }


  /** 清空所有内存快照与 loaded 标志，使下一次读取重新走磁盘（用于失效/关闭后）。 */
  private resetCredentialSnapshots(): void {
    this.canonicalSnapshot = undefined;
    this.credentialSnapshotsLoaded = false;
    this.legacyClientSnapshot = undefined;
    this.legacyTokensSnapshot = undefined;
    this.storedCredentialPair = undefined;
    this.storedCredentialPairLoaded = false;
  }

  /** 通用按 key 读 JSON；损坏记录按 raw CAS 删除并视为不存在（不抛错）。 */
  private async loadJson<T>(name: string): Promise<T | undefined> {
    const raw = await this.credentialStore.load(this.key(name));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.credentialStore.deleteIfValue(this.key(name), raw);
      return undefined;
    }
  }

  /** 通用按 key 写 JSON；单 key 写入，失败向上冒泡。 */
  private async saveJson(name: string, value: unknown): Promise<void> {
    await this.credentialStore.save(this.key(name), JSON.stringify(value));
  }

  /** 拼接本 server 的 credential key：`<keyPrefix>:<name>`。 */
  private key(name: string): string {
    return `${this.keyPrefix}:${name}`;
  }

  /** 并发诊断日志只允许安全标识：PID、adapter id、credential key prefix、state 短哈希。 */
  private logContext(): Record<string, unknown> {
    return {
      adapterInstanceId: this.adapterInstanceId,
      credentialKeyPrefix: this.keyPrefix,
      mcpServerName: this.serverName,
      oauthStateId: this.transactionId.slice(0, 16),
      processId: process.pid,
    };
  }

  /** verifier key 带 state，保证并发授权事务之间互不覆盖、清理互不影响。 */
  private verifierKey(): string {
    return this.key(`code_verifier:${this.stateValue}`);
  }

  /** 仅当本事务确实写过 verifier 才删除；失败向上抛由 close 统一降级告警。 */
  private async clearVerifier(): Promise<void> {
    if (!this.verifierPersisted) return;
    await this.credentialStore.delete(this.verifierKey());
    this.verifierPersisted = false;
  }
}

/** 日志用脱敏摘要：client_id 等标识只记录哈希前缀，不记录原值。 */
function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** 回调路径规范化：空值使用按 server 名生成的默认路径；相对路径补前导 `/`。 */
function normalizeCallbackPath(value: string | undefined, serverName: string): string {
  const fallback = `/oauth/callback/mcp/${encodeURIComponent(serverName)}`;
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

/**
 * 派生凭据命名空间：serverName + serverUrl + clientId + scope + redirectPath 的 SHA-256
 * 前 24 hex。任一授权语义变化都会得到新 keyPrefix，因此旧凭据不会被错误复用。
 * 纯函数，无 IO。
 */
export function createCredentialKeyPrefix(
  serverName: string,
  serverUrl: string,
  config: McpAuthorizationCodeOAuthConfig,
): string {
  // OAuth token 和动态 client 注册都依赖授权语义，scope/client/redirect 变化时必须重新授权。
  const hash = createHash("sha256")
    .update(
      [
        serverName,
        serverUrl,
        config.clientId ?? "",
        config.scope ?? "",
        config.redirectPath ?? "",
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 24);
  return `mcp:oauth:${hash}`;
}
