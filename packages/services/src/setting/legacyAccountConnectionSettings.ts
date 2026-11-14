// 旧版账号连接设置的迁移器：把早期 modelProviderFamilyModes / modelProviderFamilySelectedKeys
// 解释成新的 providerFamilyConnectionSelections，仅用于 settings 文件的读取边界。
// 旧键保留只为回滚可读，运行时代码不得再依据它们做判断。
import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import { readFile } from "node:fs/promises";

// 旧配置来自磁盘 JSON，任何字段都可能缺失或类型不符；必须统一收敛为对象，
// 让后续按键读取不会因 null 或数组而抛错。
function record(value: unknown): Record<string, unknown> {
  // 同时排除 null 与数组，否则按键读取会在非字典值上抛错
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface LegacyTeamConnection {
  readonly family: ProviderFamilyDomain;
  readonly productId: string;
  readonly projectId: string;
}

/** 仅迁移器解释旧键；组织信息由 Host 的只读 OAuth 查询注入。退役旧版后删除。 */
// 只读取「旧 Team 计划」中缺失组织信息的条目，供迁移器在 Host 查询组织后补齐；
// 解析失败或字段不全时静默跳过，避免一条脏数据阻断整个启动流程。
// 顺序约束：必须先于 migrateLegacyAccountConnectionSettings 调用。新字段一旦写入，本函数会因
// needsLegacyAccountConnectionMigration 为 false 返回空数组，未补全的 Team 条目就再也不会被查询。
export function readIncompleteLegacyTeamConnections(value: unknown): LegacyTeamConnection[] {
// 已经写过新字段的配置不再回看旧键，保证迁移只发生一次、可重复调用且幂等。
  if (!needsLegacyAccountConnectionMigration(value)) return [];
  // 旧配置可能不是对象，先用 record 收敛再按键读取
  const raw = record(value);
  // modes 与 keys 分开收敛，任一字段缺失时另一侧仍能参与判断
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
// 旧版只存在 zai 与 bigmodel 两个 family，顺序固定；apiKey 模式由 Provider 配置迁移处理，此处跳过。
  return (["zai", "bigmodel"] as const).flatMap((family) => {
    if (modes[family] === "apiKey") return [];
    const prefix = `team-plan:builtin:${family}-coding-plan:`;
    // 非字符串的 key 视为空，startsWith 才不会在数字上抛错
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
    if (!key.startsWith(prefix)) return [];
    try {
      const parts = key
        .slice(prefix.length)
        .split(":")
        .map((part) => decodeURIComponent(part).trim());
// 旧 Team key 只编码 productId/projectId 两段，organizationId 需要由只读 OAuth 查询补全，
// 因此段数不符或存在空段时视为无法迁移，而不是拼出伪造的组织身份。
      if (parts.length !== 2 || parts.some((part) => !part)) return [];
      return [{ family, productId: parts[0]!, projectId: parts[1]! }];
    } catch {
      return [];
    }
  });
}

// 读取旧设置文件：文件不存在返回空对象，让首次启动按默认值继续；
// 其他读取或解析错误必须上抛，避免把权限问题与文件损坏伪装成「没有配置」。
export async function readLegacyAccountConnectionSettingsFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    // readFile 与 JSON.parse 都可能抛错，只有 ENOENT 在下面被吞掉
    return record(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
// 仅 ENOENT 视为没有设置文件；EACCES、JSON 解析失败等真实故障保持原样抛出。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

// 判定是否需要迁移：缺少新字段但存在任一旧字段。用 hasOwn 而非真值判断，
// 因为空对象或空字符串也代表旧版写过该字段，migrate 仍需要补出新结构。
export function needsLegacyAccountConnectionMigration(value: unknown): boolean {
  // 缺 providerFamilyConnectionSelections 但存在任一旧字段才算需要迁移，两条旧字段用或连接
  const raw = record(value);
  return (
    // hasOwn 而非真值判断，空对象或空串也代表旧版写过而语义上仍要补出新结构
    !Object.hasOwn(raw, "providerFamilyConnectionSelections") &&
    (Object.hasOwn(raw, "modelProviderFamilySelectedKeys") ||
      Object.hasOwn(raw, "modelProviderFamilyModes"))
  );
}

/** 仅在 settings 文件读取边界导入旧连接；运行时代码不能再解释旧导航 key。 */
// 迁移入口：仅在设置读取边界调用，返回带新字段的新对象，不改动传入值；
// 运行时代码不再解释旧导航 key，旧 key 的语义只在这里集中解释一次。
// 幂等依据是 hasOwn 判据而不是旧键是否被删：新字段写入后再次调用会直接返回原对象，不会二次解释旧 key。
export function migrateLegacyAccountConnectionSettings(value: unknown): unknown {
  if (!needsLegacyAccountConnectionMigration(value)) return value;
  const raw = record(value);
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
// 只有明确识别的旧 key 才写入 selections；无法识别的保持不变，等下一版按缺省处理。
  // 只填明确识别的 family，未命中的键保持原样等下一版按缺省处理
  const selections: ProviderFamilyConnectionSelectionSettings = {};
  // 旧版只有 zai 与 bigmodel 两个 family，顺序固定以便输出稳定
  for (const family of ["zai", "bigmodel"] as const) {
    // API 实例由 Provider 配置迁移负责；旧 API 模式不是一个账号套餐。
    // apiKey 模式由 Provider 配置迁移负责，这里跳过以免覆盖成账号套餐
    if (modes[family] === "apiKey") continue;
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
// start-plan 与 individual-coding-plan 是旧版两种个人套餐 key，直接映射为新的 kind 枚举。
    if (key === `coding-plan:builtin:${family}-start-plan`) {
      // start-plan 是旧版个人套餐 key，直接映射成新的 kind 枚举
      selections[family] = { kind: "start-plan" };
    } else if (key === `coding-plan:builtin:${family}-coding-plan`) {
      selections[family] = { kind: "individual-coding-plan" };
    } else {
      const prefix = `team-plan:builtin:${family}-coding-plan:`;
// 非 Team 前缀的 key 与本次迁移无关，保留原字段交给其他迁移逻辑处理。
      if (!key.startsWith(prefix)) continue;
      try {
        const parts = key
          .slice(prefix.length)
          .split(":")
          .map((part) => decodeURIComponent(part).trim());
        // 旧 project-only key 无法确定组织，保留原字段而非捏造新版 Team 身份。
        if (parts.length !== 3 || parts.some((part) => !part)) continue;
        const [productId, organizationId, projectId] = parts as [string, string, string];
        selections[family] = { kind: "team-coding-plan", productId, organizationId, projectId };
      } catch {
        // 损坏的编码只影响这一项，不能让整个 setting.json 回退成默认值。
      }
    }
  }
// 新对象保留全部旧字段再覆盖 selections，避免丢失本模块不认识的配置项。
  // 先展开旧字段再覆盖新字段，模块不认识的配置项不会被丢掉
  return { ...raw, providerFamilyConnectionSelections: selections };
}

/** 旧字段仅供回滚保留，禁止暴露回 AppSettings 或参与当前运行判断；退役旧版后删除。 */
// 回滚兼容：仅把两个旧键原样带出，供旧版本读取；不得并入 AppSettings，
// 也不得参与当前运行判断，否则新旧两套状态会同时生效。
export function retainLegacyAccountConnectionFields(value: unknown): Record<string, unknown> {
  // 先收敛成对象，fromEntries 才能安全读取两个旧键
  const raw = record(value);
  return Object.fromEntries(
    ["modelProviderFamilyModes", "modelProviderFamilySelectedKeys"]
      // 只保留实际存在的旧键，凭空补 null 会让旧版本误以为配置过
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => [key, raw[key]]),
  );
}
