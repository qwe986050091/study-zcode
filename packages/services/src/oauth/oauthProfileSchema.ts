// 文件职责：BigModel 缓存 profile 的 schema 迁移与 best-effort 刷新；只在 restoreCachedSession
// 发现缓存缺少 schema 版本时被调用，因此同时承担「旧缓存可读」与「新版本号不回退」两项职责。
// INV-01：schemaVersion >= 2 或处于 retry-after 窗口内的缓存不得再打 userinfo（守住位置：
//   refreshLegacyBigModelCachedProfile 首个 if）。破坏后：每次启动多一次网络请求，离线启动被拖慢。
// INV-02：迁移结果绝不能用 unknown/User 哨兵值覆盖已有可信展示名（守住位置：
//   isBigModelUserInfoFallback 分支）。破坏后：版本号被写死，错误昵称永久固化且无法自愈。
// INV-03：只有 401/403 才判定迁移完结并写入版本 2，其余错误只写 retry-after（守住位置：
//   shouldCompleteMigrationAfterError 及其调用点）。破坏后：瞬时 5xx 会让用户永久停在旧 schema。
import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import type { OAuthProviderAdapter } from "./providers/index.js";

// 版本号是「迁移已完成」的唯一持久化证据；提升它必须同时提供新的迁移分支，否则旧缓存会被
// 当成新格式直接信任。retry 间隔取 1h：更短会反复触发失败请求，更长则用户需重启才自愈。
const BIGMODEL_PROFILE_SCHEMA_VERSION = 2;
const BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS = 60 * 60 * 1000;

// 依赖全部注入而非直接 import，便于单测替换时钟与适配器；now 是函数而非常量，
// 保证同一次迁移内 retry-after 的比较基准与写入基准同源。
interface RefreshLegacyBigModelCachedProfileOptions {
  adapter: OAuthProviderAdapter;
  cachedProfile: OAuthUserProfile;
  loadTokenSet: () => Promise<OAuthTokenSet | null>;
  saveProfile: (profile: OAuthUserProfile) => Promise<void>;
  now: () => number;
  runWithAdapterError: <T>(run: () => Promise<T>) => Promise<T>;
}

// rawProfile 来自磁盘 JSON：字段可能缺失或被手改成 string，但这里只接受 number。
// 其余一律当作「没有版本号」，宁可多刷一次也不能把垃圾值比较成 >= 2 而跳过迁移。
function getCachedProfileSchemaVersion(profile: OAuthUserProfile): number | null {
  // 版本号藏在 rawProfile 里：它是磁盘 JSON 的透传字段，不是 OAuthUserProfile 的顶层属性。
  const rawProfile = profile.rawProfile;
  // 非对象直接当作没有版本号：旧缓存可能把 rawProfile 存成字符串，展开它会得到下标键。
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  // 只接受 number：字符串 "2" 不转换，宁可多刷一次也不能把脏值比较成已迁移。
  const version = (rawProfile as { zcodeProfileSchemaVersion?: unknown }).zcodeProfileSchemaVersion;
  // 返回 null 而非 0：null 表示没有版本标记，与显式写入的版本 0 语义不同。
  return typeof version === "number" ? version : null;
}

// 同样按未知字段处理：无法解析成数字就等于从未写过 retry-after，允许立即重试。
function getCachedProfileMigrationRetryAfter(profile: OAuthUserProfile): number | null {
  // retry-after 与版本号同源，都从 rawProfile 读取；两者缺失时都返回 null 而不是 0。
  const rawProfile = profile.rawProfile;
  // 同样的非对象判断：解析不出对象就等于从未写过 retry-after，允许立即重试。
  if (!rawProfile || typeof rawProfile !== "object") {
    return null;
  }

  // 与版本号分开读取：retry-after 存在不代表迁移完成，两个判断在调用点各管一段。
  const retryAfter = (rawProfile as { zcodeProfileMigrationRetryAfter?: unknown })
    .zcodeProfileMigrationRetryAfter;
  // 非数字返回 null：调用点用 ?? 0 兜底后与 now 比较，不会把非法值当成未来的时间戳。
  return typeof retryAfter === "number" ? retryAfter : null;
}

// [失败路径] 三个哨兵值同时成立才判为 fallback：adapter 拿不到 BigModel 用户信息时返回
// 这组占位值；只匹配其中一项会把真实昵称为 User 的合法 profile 误判成失败，从而放弃已经成功的迁移结果。
function isBigModelUserInfoFallback(profile: OAuthUserProfile): boolean {
  return profile.id === "unknown" && profile.username === "user" && profile.displayName === "User";
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  // adapter 抛出的错误形状不统一，只认 status 字段；没有它的错误一律当作暂时性失败。
  const status = (error as { status?: unknown }).status;
  // 只接受数字状态码：字符串 "401" 不在这里转换，避免把非 HTTP 错误误判成权限失败。
  return typeof status === "number" ? status : null;
}

// [权衡] 401/403 代表当前 token 对该接口已无权限（旧 JWT 被写进 access token 的典型症状），
// 再重试也不会有不同结果，于是写入版本号终结迁移；5xx/超时/离线只可能是暂时性，
// 若同样写版本号，一次网络抖动就会让用户永远看不到刷新后的昵称。
function shouldCompleteMigrationAfterError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 401 || status === 403;
}

// 写入版本号的同时清掉 retry-after：两者互斥，残留的 retry-after 会让下一次启动误判
// 「仍在退避期」而跳过对新版本号的检查。rawProfile 非对象时重置为 {}，
// 避免把 string/number 展开进对象得到带下标键的脏数据。
// 顺序约束：两个字段必须在同一个对象里一次 saveProfile 写出。拆成两次写时，崩溃窗口会留下
// 「retry-after 已清、版本未写」→ 下次启动立刻再打 userinfo；反向组合会被版本号短路，无害但同样不该出现。
export function withProviderProfileSchema(
  provider: OAuthProviderId,
  profile: OAuthUserProfile,
): OAuthUserProfile {
  // 版本字段只属于 BigModel 的迁移；其它 provider 原样返回，不往 rawProfile 里塞外来键。
  if (provider !== BIGMODEL_PROVIDER_ID) {
    return profile;
  }

  const rawProfile =
    // rawProfile 非对象时重置为 {}：把 string/number 展开进对象会得到带下标键的脏数据。
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};
  // 复制一份再改：直接 delete 会修改调用方传入的 profile.rawProfile，破坏输入不可变。
  const nextRawProfile = { ...(rawProfile as Record<string, unknown>) };
  // 写版本号时清掉 retry-after：两者互斥，残留会让下次启动误判仍在退避期而跳过版本检查。
  delete nextRawProfile.zcodeProfileMigrationRetryAfter;

  return {
    ...profile,
    rawProfile: {
      ...nextRawProfile,
      // zcodeProfileSchemaVersion 只在迁移成功路径写入；提升版本常量必须同时补新的迁移分支。
      zcodeProfileSchemaVersion: BIGMODEL_PROFILE_SCHEMA_VERSION,
    },
  };
}

// 只写 retry-after 而不写 schemaVersion：这是「迁移未完成」的显式标记，
// 与 INV-01 的提前返回条件成对出现，缺一就会退化成每次启动重试。
function withBigModelProfileMigrationRetryAfter(
  profile: OAuthUserProfile,
  now: number,
): OAuthUserProfile {
  const rawProfile =
    // 与版本写入同口径：非对象重置为空表，避免把原始值的字符索引带进 rawProfile。
    profile.rawProfile && typeof profile.rawProfile === "object" ? profile.rawProfile : {};

  return {
    ...profile,
    rawProfile: {
      ...(rawProfile as Record<string, unknown>),
      // 用调用方传入的 now 计算：同一次迁移内比较基准与写入基准同源，不读取系统时钟。
      zcodeProfileMigrationRetryAfter: now + BIGMODEL_PROFILE_MIGRATION_RETRY_DELAY_MS,
    },
  };
}

export async function refreshLegacyBigModelCachedProfile(
  options: RefreshLegacyBigModelCachedProfileOptions,
): Promise<OAuthUserProfile> {
  // 从 options 一次性解构：后续分支只用局部名，避免中途读到被替换的实现。
  const { adapter, cachedProfile, loadTokenSet, now, runWithAdapterError, saveProfile } = options;
  // 三个提前返回条件分别对应：已迁移、仍在退避窗口、适配器不支持 userinfo。
  // 任一成立都直接返回原对象且不产生写入——缓存稳定性优先于「尽快刷新」。
  if (
    (getCachedProfileSchemaVersion(cachedProfile) ?? 0) >= BIGMODEL_PROFILE_SCHEMA_VERSION ||
    (getCachedProfileMigrationRetryAfter(cachedProfile) ?? 0) > now() ||
    !adapter.fetchUserInfo
  ) {
    return cachedProfile;
  }

  // 没有 token 时只补写版本号：此时无法调用 userinfo，但也不该让旧缓存永远停在无版本状态。
  const tokenSet = await loadTokenSet();
  // 没有 token 时无法调用 userinfo，但仍写入版本号，让旧缓存不再永远停在无版本状态。
  if (!tokenSet) {
    await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
    return cachedProfile;
  }

  // [失败路径] fetchUserInfo 的任何抛错都不能让 restoreCachedSession 失败，登录态必须保留。
  try {
    // BigModel 旧缓存只保存 nickName，升级后 restoreCachedSession 会绕过
    // fetchUserInfo。这里对无版本缓存做 best-effort 刷新，失败仍保留本地登录态。
    // 通过 runWithAdapterError 调用：adapter 的错误归一由此完成，保证下面 catch 拿到稳定形状。
    const refreshedProfile = await runWithAdapterError(() =>
      adapter.fetchUserInfo!(tokenSet, {
        providerId: BIGMODEL_PROVIDER_ID,
        state: "",
        redirectUri: adapter.redirectUri,
        now,
      }),
    );
    // 哨兵值意味着 adapter 拿不到真实用户信息，落盘会污染已有缓存，因此保留原 profile 只写版本。
    // 哨兵值说明 adapter 查不到真实用户信息；此时只写版本号，保留已有的可信展示名。
    if (isBigModelUserInfoFallback(refreshedProfile)) {
      // 旧版本可能把 zcode JWT 写进 BigModel access token。
      // adapter 会返回 unknown/User 哨兵值表示无法查 BigModel 用户信息；
      // 迁移不能把已有可信缓存覆盖成这个哨兵值，否则版本标记会永久固化错误展示名。
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }
    // 成功拿到真实资料才覆盖缓存；写版本号与写资料在同一次 saveProfile 里完成。
    const migratedProfile = withProviderProfileSchema(BIGMODEL_PROVIDER_ID, refreshedProfile);
    await saveProfile(migratedProfile);
    return migratedProfile;
  } catch (error) {
    // 失败后果：成功分支里的 saveProfile 也在这个 try 内，它抛错会落进这里被当成 userinfo 暂时性失败再写一次 retry-after；
    // 若两次写盘都失败，错误向上抛给 restoreCachedSession，调用方必须保留登录态而不能因此登出。
    // 401/403 代表当前 token 已无权限，重试不会改变结果，因此写版本号终结迁移。
    if (shouldCompleteMigrationAfterError(error)) {
      await saveProfile(withProviderProfileSchema(BIGMODEL_PROVIDER_ID, cachedProfile));
      return cachedProfile;
    }

    // 离线、超时或 5xx 只是暂时性失败，不能永久写入 schema version 2。
    // 写入 retry-after 可避免每次启动都打 userinfo，同时保留后续成功迁移机会。
    // [权衡] 写 retry-after 而不是静默返回：持久化后才能跨进程生效，否则每次启动仍会打 userinfo。
    // 暂时性失败只写 retry-after：持久化后才能跨进程生效，否则每次启动都会再打一次 userinfo。
    await saveProfile(withBigModelProfileMigrationRetryAfter(cachedProfile, now()));
    return cachedProfile;
  }
}
