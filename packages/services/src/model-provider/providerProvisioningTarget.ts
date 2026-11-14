/* eslint-disable max-lines -- Provisioning target keeps transaction and rollback invariants together. */
import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { decodeProviderConfigFile, encodeProviderConfigFile } from "@zcode/provider-node";
import {
  providerProvisioningEnvelopeSchema,
  providerProvisioningResultSchema,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningEnvelope,
  type ProviderProvisioningResult,
  type ProviderProvisioningErrorCode,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import type { ProviderRuntime } from "./providerRuntime.js";
import type { AccountProviderService } from "@zcode/provider";
import type { IProviderProvisioningTargetService } from "./providerProvisioning.js";
import {
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  readProvisionablePersonalConfig,
} from "./providerProvisioningSource.js";

// INV-01：apply 以 syncId 为幂等键，记录写在状态文件里；同一 syncId 第二次投递返回 already-applied，
// 不再触碰任何 Store。
// INV-02：一次 apply 要么整体生效（status=applied），要么把三个域都回滚到 before 快照（status=failed）；
// 无法确认可安全回滚时返回 rollback_failed，绝不强行覆盖。
// INV-03：回滚同样是 CAS——只有「当前值等于本次写入值」时才回退，否则报告跳过。
// INV-04：状态文件提交发生在所有写入之后；提交前的任何异常都进入回滚路径。
const PROVISIONING_SCHEMA_VERSION = 1 as const;

const OAUTH_CREDENTIAL_KEYS = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);

// 目标端依赖全部注入：Provider Runtime 负责刷新 Registry，Repository/CredentialService/SettingService
// 是三个写入域，stateFilePath 存幂等记录，listProvisioningCredentialKeys 供删除语义对齐源端。
// [权衡] 依赖数量偏多，但把「写哪些域」显式化后，回滚路径才能逐域独立实现。
export interface ProviderProvisioningTargetOptions {
  readonly providerRuntime: ProviderRuntime;
  readonly personalRepository: PersonalProviderConfigRepository;
  readonly accountProviderSource: AccountProviderService;
  readonly credentialService: ICredentialService;
  readonly settingService: ISettingService;
  readonly personalConfigFilePath: string;
  readonly stateFilePath: string;
  readonly listProvisioningCredentialKeys?: () => Promise<readonly string[]>;
}

interface ProvisioningStateRecord {
  readonly syncId: string;
  readonly result: ProviderProvisioningResult;
}

interface ProvisioningStateFile {
  readonly schemaVersion: typeof PROVISIONING_SCHEMA_VERSION;
  readonly records: readonly ProvisioningStateRecord[];
}

/** 运行在目标 Environment 内的 Provisioning target；负责写正式 Store 并在失败时回滚。 */
// 对外只暴露 apply：没有查询接口，调用方靠返回值判断结果，避免把目标端状态当读模型使用。
// [事务] 事务边界就是一次 apply 调用，中途不暴露任何中间态。
// 每次 apply 读取信封后立即进入文件锁，锁外不做任何写入。
export function createProviderProvisioningTarget(
  options: ProviderProvisioningTargetOptions,
): IProviderProvisioningTargetService {
  return {
    async apply(input: ProviderProvisioningEnvelope): Promise<ProviderProvisioningResult> {
// 先做协议级校验再进锁：非法信封不该占用文件锁，也不该在状态文件里留下记录。
// 解析失败直接抛出，不做部分应用。
      const envelope = providerProvisioningEnvelopeSchema.parse(input);
// [并发] 整个 apply 在 stateFilePath 的独占文件锁内执行：两个 Host 同时推送时，
// 后到者排队并命中幂等检查，而不是并发写同一批 Store。
// [事务] 锁范围覆盖「读状态 → 写三域 → 刷新 → 写状态」，因此崩溃点只可能落在
// 状态文件提交前后，不会出现「记录已写但数据未写」。
// 锁粒度选状态文件而非各 Store：多域写入无法用单个 Store 的锁表达原子性。
      return withFileLock(options.stateFilePath, async () => {
// 状态文件是幂等与审计的唯一依据；读取失败按「无记录」处理，由后续写入重建。
        const previousState = await readStateFile(options.stateFilePath);
        const previousResult = previousState?.records.find(
          (record) => record.syncId === envelope.syncId,
        );
// 命中即返回，只把状态改写为 already-applied：调用方据此区分首次与新推送。
// 记录里的 configRevision 可能已过期，仍原样返回，避免用旧结果重放写入。
        if (previousResult) {
          return {
            ...previousResult.result,
            status: "already-applied",
          } satisfies ProviderProvisioningResult;
        }

// 白名单校验放在锁内、写前：拒绝未知 key 或不匹配的 scope，防止任意凭据被搬运。
        validateCredentialEntries(envelope);
        // schema v1 接受旧 Source 的账号 Key 字段，但新 Host 不再读取或应用它。
        // 旧/手工 Key 留在原 Store，避免升级同步误删其它客户端共享的凭据。
// 过滤结果同时驱动写入与 credentialCount，因此只裁剪一次；
// 被裁剪掉的条目已在校验阶段按 scope 白名单拒绝，不会静默丢弃。
        const oauthCredentials = envelope.credentials.filter(
          (entry) => entry.scope === "oauth-session",
        );
// 先启动 Provider Runtime：后续 refresh 与 Store 读取都依赖已装配的 Registry。
        await options.providerRuntime.start();
// 写入前先取三域快照：它是回滚的唯一依据，必须在第一次写之前完成，
// 否则回滚会把本次写入的一半当成旧值。
        const before = await captureBeforeState(envelope, options);
// 提前解码得到线上 Personal 层更新，后续既用于写入也用于回滚的 CAS 期望值。
        const personalUpdate = parsePersonalConfig(envelope);
// applied 记录「本次实际推进到哪一步」，回滚只处理已登记的部分。
// 三个 expected 字段保存本次写入值，是回滚时判断「当前是否仍是本次写入」的依据。
// settingsVersion 取 now 与旧版本+1 的较大值，保证跨进程单调递增，供 CAS 比较。
        const applied: AppliedProvisioningState = {
          settings: false,
          settingsExpected: envelope.accountSettings,
          settingsVersion: Math.max(
            Date.now(),
            (before.settings.providerFamilyDomainUpdatedAt ?? 0) + 1,
          ),
          credentials: [],
          personalConfig: false,
          personalConfigExpected: personalUpdate,
        };

// errorCode 随失败阶段推进：write → refresh → commit，用于区分「数据没写成」
// 与「写成了但刷新失败」，后者同样需要回滚。
// 默认 target-write-failed 覆盖进入 try 后立刻失败的情况。
        let errorCode: ProviderProvisioningErrorCode = "target-write-failed";
        try {
          // 先登记再写入：底层原子写即使在替换完成后才抛错，也必须进入回滚集合。
// 紧随其后的 update 第二个参数是 CAS 期望快照：完整比对 domain + selections + version，
// 只比版本号会让「版本相同但内容被改」的写入静默通过。
// 期望值取自 before.settings，所以必须在 captureBeforeState 之后、任何写入之前构造。
          applied.settings = true;
          await options.settingService.update(
            {
              providerFamilyDomainUpdatedAt: applied.settingsVersion,
// [事务] providerFamilyDomainUpdatedAt 同时是内容版本与 CAS 令牌：
// 回滚必须比对同一版本号，才能确认期间没有第三方写入。
              providerFamilyDomain: envelope.accountSettings.providerFamilyDomain ?? undefined,
              providerFamilyConnectionSelections:
                envelope.accountSettings.providerFamilyConnectionSelections,
            },
            {
              // 原因：Host 同步也与本地连接选择竞争，提交必须比较捕获的完整快照和版本。
              providerFamilyDomain: before.settings.providerFamilyDomain,
              providerFamilyConnectionSelections:
                before.settings.providerFamilyConnectionSelections,
              providerFamilyDomainUpdatedAt: before.settings.providerFamilyDomainUpdatedAt ?? 0,
            },
          );

// 以源端条目建 Map：遍历本地现有 key 而不是传入条目，
// 这样「源端已删除的 key」也会被识别并删除（replace-allowlist 语义）。
          const incomingCredentials = new Map(
            oauthCredentials.map((credential) => [credential.key, credential.value]),
          );
// 每个 key 的旧值都记入 applied，供回滚逐项 CAS；value 为 null 表示本次删除。
// [资源] save/delete 逐个串行：CredentialService 可能落到钥匙串，并发写会互相阻塞。
          for (const key of before.credentials.keys()) {
            const value = incomingCredentials.get(key);
            applied.credentials.push({ key, value: value ?? null });
            if (value === undefined) await options.credentialService.delete(key);
            else await options.credentialService.save(key, value);
          }

// 同样是先登记再写：update 回调可能已执行成功，但随后的逻辑仍会失败。
          applied.personalConfig = true;
          await options.personalRepository.update((current) => {
            // 其他域写入期间 Personal 可能已被编辑；检查与替换必须在同一个文件锁内。
            if (!samePersonalConfig(current, before.personal)) {
              throw new Error("Personal Provider Config 在同步期间被其它操作修改");
            }
// 回调内比对「当前 == before」，比对与替换在同一文件锁内完成，
// 避免把期间被用户编辑的配置覆盖掉。
            return personalUpdate;
          });

// 从这行起失败都要回滚：三域数据已写入，只是派生视图没刷新。
// 先刷新 Account 再刷新 Registry：Registry 合并需要最新的账号快照。
          errorCode = "target-refresh-failed";
          await options.accountProviderSource.refresh("provider-provisioning");
// Registry 刷新产出新 sourceRevisions，其中 config revision 作为结果的一部分回给 Host。
          const snapshot =
            await options.providerRuntime.registryService.refresh("provider-provisioning");
          // 失效默认只是新会话偏好；把它当同步硬条件会让正常 SSH 被旧模型/档位阻断。
          // 原样保留偏好，由 Host 现有推荐逻辑解析；真实写入/刷新失败仍按事务回滚。

// 结果只回传计数与 revision，不回传配置内容：Host 用它推进同步状态即可。
          const result = {
            syncId: envelope.syncId,
            status: "applied" as const,
            personalProviderCount: personalUpdate.providers.keys().length,
            credentialCount: oauthCredentials.length,
            configRevision: snapshot.sourceRevisions.config,
            rolledBack: false,
          } satisfies ProviderProvisioningResult;
// [事务] 状态文件写入是提交点：此前失败全部回滚，此后失败意味着数据已生效但幂等记录缺失。
// 这种情况仍走 catch 回滚——宁可返回 failed，也不留下「写入成功却无法去重」的中间态。
          errorCode = "target-commit-failed";
          await writeStateFile(options.stateFilePath, appendStateRecord(previousState, result));
          return result;
        } catch (error) {
          // 回滚前对每个 domain 做 CAS 式校验；若期间已有其它写入，宁可报告
          // rollback_failed，也不能用过期快照覆盖或删除用户的新配置。
// [失败路径] catch 覆盖全部三域写入与刷新；回滚失败不覆盖原始错误，
// 而是把两个错误拼进 errorMessage 并标记 rollback_failed。
// 未登记（applied=false）的域不会被回滚，因此不会删掉用户既有配置。
// [事务] 回滚内部逐域做 CAS 校验：期间已有其它写入时宁可报告 rollback_failed，
// 也不能用过期快照覆盖或删除用户的新配置。
// 回滚只回退「本次确实写入且当前仍等于本次写入值」的部分。
          const rollbackError = await rollback(before, applied, options);
// 失败结果仍带 before 的 provider 数与 credentialCount，便于 Host 判断本地现状。
// errorCode 保留首次失败阶段，不被回滚错误覆盖。
          if (rollbackError) {
            return {
              syncId: envelope.syncId,
              status: "rollback_failed",
              personalProviderCount: before.personal.providers.keys().length,
              credentialCount: oauthCredentials.length,
              errorMessage: `${formatError(error)}；回滚失败：${formatError(rollbackError)}`,
              errorCode,
              rolledBack: false,
            } satisfies ProviderProvisioningResult;
          }
          return {
            syncId: envelope.syncId,
            status: "failed",
            personalProviderCount: before.personal.providers.keys().length,
            credentialCount: oauthCredentials.length,
            errorMessage: formatError(error),
            errorCode,
            rolledBack: true,
          } satisfies ProviderProvisioningResult;
        }
      });
    },
  };
}

// 三域快照：Personal 层更新、账号设置、allowlist 内凭据的旧值（null 表示原本不存在）。
interface BeforeState {
  readonly personal: ProviderConfigLayerUpdate;
  readonly settings: Awaited<ReturnType<ISettingService["get"]>>;
  readonly credentials: ReadonlyMap<string, string | null>;
}

// 与 BeforeState 对称：expected 字段是本次写入值，回滚时用于 CAS。
interface AppliedProvisioningState {
  settings: boolean;
  settingsExpected: ProviderProvisioningEnvelope["accountSettings"];
  settingsVersion: number;
  credentials: Array<{ key: string; value: string | null }>;
  personalConfig: boolean;
  personalConfigExpected: ProviderConfigLayerUpdate;
}

// 接收端不另建字段清单，避免两套模式判断漂移；schemaVersion=1 是 Personal codec 的固定协议版本。
// 这里不做任何字段补全：缺失字段保持缺失，由 Registry 在合并时按 Built-in 默认值填充。
function parsePersonalConfig(envelope: ProviderProvisioningEnvelope): ProviderConfigLayerUpdate {
  // 信封与本地保存复用正式 Personal codec，不在接收端另建字段清单或模式判断。
  return decodeProviderConfigFile({ schemaVersion: 1, config: envelope.personalConfig });
}

// 并发读取 Personal 与 settings：两者互不依赖。
// 凭据必须串行逐个 load：CredentialService 可能走钥匙串，并发访问会互相阻塞。
// 凭据 key 集合取三源并集后仍过滤 allowlist，保证不会把非同步凭据读入内存。
async function captureBeforeState(
  envelope: ProviderProvisioningEnvelope,
  options: ProviderProvisioningTargetOptions,
): Promise<BeforeState> {
  const [personal, settings] = await Promise.all([
    readProvisionablePersonalConfig(options.personalRepository, options.personalConfigFilePath),
    options.settingService.get(),
  ]);
// Map 的 value 允许 null：null 表示该 key 原本不存在，回滚时对应删除。
  const credentials = new Map<string, string | null>();
  const credentialKeys = new Set<string>([
    ...OAUTH_CREDENTIAL_KEYS,
    ...((await options.listProvisioningCredentialKeys?.()) ?? []),
    ...envelope.credentials.map((entry) => entry.key),
  ]);
  for (const key of credentialKeys) {
    if (!OAUTH_CREDENTIAL_KEYS.has(key)) {
      continue;
    }
    credentials.set(key, await options.credentialService.load(key));
  }
  return {
    personal,
    settings,
    credentials,
  };
}

// 回滚顺序与写入顺序相反：Personal → Credential → Settings，
// 因为 Settings 的版本号是其它域的 CAS 参照，最后处理可减少误判。
// 各域独立 try/catch：一个域失败不影响其它域继续回退，错误最后汇总。
// [资源] 先回滚数据再触发刷新：刷新读到半回滚状态会把不一致推到 UI。
async function rollback(
  before: BeforeState,
  applied: AppliedProvisioningState,
  options: ProviderProvisioningTargetOptions,
): Promise<Error | undefined> {
  const errors: unknown[] = [];
// Personal 用一次 update 完成「比对 + 替换」：默认选择与 Provider/Model 共用同一份 CAS。
  if (applied.personalConfig) {
    try {
      await options.personalRepository.update((current) => {
        if (samePersonalConfig(current, before.personal)) return current;
        if (!samePersonalConfig(current, applied.personalConfigExpected)) {
          throw new Error("Personal Provider Config 在同步期间被其它操作修改，跳过回滚");
        }
        // 默认选择与 Provider/Model 共用一份 CAS；不能分别回滚制造混合状态或覆盖新选择。
        return before.personal;
      });
    } catch (error) {
      errors.push(error);
    }
  }
// 逐 key 回滚：current 既不是 previous 也不是本次写入值，说明第三方改过，跳过并记录。
// 跳过而不是中断：已回滚的 key 保持回退状态，用户能看到部分成功的真实情况。
// 先 load 再比较，避免对未变化的 key 做一次多余的写。
  for (const { key, value } of applied.credentials) {
    try {
      const previous = before.credentials.get(key) ?? null;
      const current = await options.credentialService.load(key);
      if (current === previous) {
        continue;
      }
      if (current !== value) {
        errors.push(new Error(`Credential ${key} 在同步期间被其它操作修改，跳过回滚`));
        continue;
      }
      if (previous === null) {
        await options.credentialService.delete(key);
      } else {
        await options.credentialService.save(key, previous);
      }
    } catch (error) {
      errors.push(error);
    }
  }
// 当前值已等于 before 时不做任何事：写入在落盘前失败，目标本就处于回滚前状态。
// 否则要求「当前 == 本次写入值」且版本号一致，才允许写回 before。
// [并发] 归属检查与写入之间仍有竞态，因此 update 的 CAS 期望值取 current 而非 before。
  if (applied.settings) {
    try {
      const current = await options.settingService.get();
      const previousSettings = toProvisioningAccountSettings(before.settings);
      if (sameAccountSettings(current, previousSettings)) {
        // 写入失败发生在落盘前，目标已经处于回滚前的状态。
      } else if (
        !sameAccountSettings(current, applied.settingsExpected) ||
        (current.providerFamilyDomainUpdatedAt ?? 0) !== applied.settingsVersion
      ) {
        errors.push(new Error("Account Settings 在同步期间被其它操作修改，跳过回滚"));
      } else {
        await options.settingService.update(
          {
            providerFamilyDomain: before.settings.providerFamilyDomain,
            providerFamilyConnectionSelections: before.settings.providerFamilyConnectionSelections,
          },
          {
            // 原因：归属检查与写入间仍有竞态，回滚也必须在锁内比较本次提交版本。
            providerFamilyDomain: current.providerFamilyDomain,
            providerFamilyConnectionSelections: current.providerFamilyConnectionSelections,
            providerFamilyDomainUpdatedAt: applied.settingsVersion,
          },
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
// 有任何域回滚失败就不再做刷新：此时 Store 处于混合状态，刷新只会把不一致暴露给 UI。
  if (errors.length > 0) {
    return new Error(errors.map(formatError).join("；"));
  }
  try {
    await options.accountProviderSource.refresh("provider-provisioning-rollback");
    await options.providerRuntime.registryService.refresh("provider-provisioning-rollback");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return undefined;
}

// 用 codec 序列化后比较：直接比较类实例会因字段顺序/附加属性不同而误判。
function samePersonalConfig(
  left: ProviderConfigLayerUpdate,
  right: ProviderConfigLayerUpdate,
): boolean {
  return (
    JSON.stringify(encodeProviderConfigFile(left)) ===
    JSON.stringify(encodeProviderConfigFile(right))
  );
}

function toProvisioningAccountSettings(
  settings: Awaited<ReturnType<ISettingService["get"]>>,
): ProviderProvisioningEnvelope["accountSettings"] {
  return {
    providerFamilyDomain: settings.providerFamilyDomain ?? null,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections ?? {},
  };
}

// 只比较参与同步的两个字段，其余设置的变化不属于本事务范围。
function sameAccountSettings(
  current: Awaited<ReturnType<ISettingService["get"]>>,
  expected: ProviderProvisioningEnvelope["accountSettings"],
): boolean {
  return JSON.stringify(toProvisioningAccountSettings(current)) === JSON.stringify(expected);
}

// 三类校验：key 不得重复（否则后写覆盖前写）、scope 与 key 必须匹配、
// account-provider 段只接受共享常量提供的合法 key。
// 校验在写入前完成，任何一条不通过都会在未触碰 Store 的情况下失败。
function validateCredentialEntries(envelope: ProviderProvisioningEnvelope): void {
  const seen = new Set<string>();
  for (const entry of envelope.credentials) {
    if (seen.has(entry.key)) throw new Error(`重复 Provisioning Credential key: ${entry.key}`);
    seen.add(entry.key);
    const allowed =
      (entry.scope === "oauth-session" && OAUTH_CREDENTIAL_KEYS.has(entry.key)) ||
      (entry.scope === "account-provider" && isProviderProvisioningAccountCredentialKey(entry.key));
    if (!allowed) throw new Error(`不允许同步的 Credential key: ${entry.key}`);
  }
}

// 状态文件是「尽力而为」的幂等记录：解析失败、版本不符、记录非法都降级为空，
// 让下一次同步重新写一份干净文件，而不是让同步永久失败。
async function readStateFile(filePath: string): Promise<ProvisioningStateFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== PROVISIONING_SCHEMA_VERSION) {
      return null;
    }
// 兼容单记录旧格式（{syncId, result}）与数组格式，避免升级后丢失已应用的 syncId。
    const rawRecords = Array.isArray(parsed.records)
      ? parsed.records
      : parsed.syncId && parsed.result
        ? [{ syncId: parsed.syncId, result: parsed.result }]
        : [];
// 逐条 safeParse：坏记录被丢弃而不是整文件作废，防止一条脏数据让全部幂等信息失效。
    const records = rawRecords.flatMap((record) => {
      if (typeof record !== "object" || record === null) return [];
      const candidate = record as Record<string, unknown>;
      if (typeof candidate.syncId !== "string" || !candidate.syncId.trim()) return [];
      const result = providerProvisioningResultSchema.safeParse(candidate.result);
      return result.success ? [{ syncId: candidate.syncId, result: result.data }] : [];
    });
    return { schemaVersion: PROVISIONING_SCHEMA_VERSION, records };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return null;
  }
}

// 先按 syncId 去重再追加，保证同一 syncId 只保留最新结果。
function appendStateRecord(
  previousState: ProvisioningStateFile | null,
  result: ProviderProvisioningResult,
): ProvisioningStateFile {
  const records = [
    ...(previousState?.records ?? []).filter((record) => record.syncId !== result.syncId),
    { syncId: result.syncId, result },
  ];
  return {
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    records,
  };
}

// 原子私有写：状态文件含 syncId 与 revision，不能出现半份 JSON。
function writeStateFile(filePath: string, state: ProvisioningStateFile): Promise<void> {
  return atomicWritePrivateTextFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

// 统一错误文本：非 Error 抛出（字符串/对象）也要能进入 errorMessage。
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
