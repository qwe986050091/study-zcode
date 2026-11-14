// ===========================================================================
// settingService：~/.zcode/v2/setting.json 的唯一读写实现（Host 侧）。
// INV-01：实例创建时解析一次 settingsFile；每次 IO 重读 HOME 会让迟到的异步
//         投影写进后来实例的目录，读取、加锁与替换必须同源。
// INV-02：写是「锁内重读-合并-提交」事务；generation 让超时旧写只能清理临时文件。
// INV-03：坏 JSON 先短重试再隔离；重试躲开并发覆盖造成的半截文件，隔离避免反复失败。
// INV-04：迁移落盘必须进 updateQueue 并在队列内重读，否则覆盖并发保存的其他字段。
// INV-05：账号连接走 CAS，值不变也算新操作，版本号在锁内单调递增。
// INV-06：recentProjects 去重后截断到 10；INV-07：legacy 账号字段必须原样回写。
// ===========================================================================
import { readFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AppSettings,
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelectionSettings,
} from "@zcode/shared";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
  formatLogPrefix,
  formatZodError,
} from "@zcode/shared";
import type { ISettingService, WorkspaceSettingsProjection } from "./setting.js";
import { normalizeSettingsPatch } from "#src/setting/normalizeSettingsPatch.js";
import { copyDataDirectory, getDataBaseDir, validateDataBaseDirTarget } from "../paths.js";
import { isEffectiveDevelopmentNodeEnv } from "../runtime-tools/nodeEnv.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";
import { withSettingsWriteQueueTimeout } from "./settingsWriteQueue.js";
import {
  migrateLegacyAccountConnectionSettings,
  needsLegacyAccountConnectionMigration,
  readLegacyAccountConnectionSettingsFile,
  readIncompleteLegacyTeamConnections,
  retainLegacyAccountConnectionFields,
  type LegacyTeamConnection,
} from "#src/setting/legacyAccountConnectionSettings.js";
// recentProjects 上限：只保留最近 10 个，既是 UI 展示约束也是文件体积上限。
const MAX_RECENT_PROJECTS = 10;
// 重试间隔取 300ms，覆盖一次原子替换的落盘窗口，又不会让 get 明显变慢。
const SETTINGS_PARSE_RETRY_DELAY_MS = 300;
const SETTINGS_PARSE_RETRY_COUNT = 3;

// 普通日志不过滤环境：写盘失败、隔离坏文件等生产事件必须留下痕迹。
const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("settingService", process.pid), ...args);
// debug 只在开发运行时输出；开关判据来自 runtime env，不接受外部 NODE_ENV。
const debugLog = (...args: unknown[]) => {
  // NODE_ENV 来自用户 shell 时会误导服务层 debug 开关；统一使用 ZCODE_RUNTIME_ENV。
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  console.debug(formatLogPrefix("settingService", process.pid), ...args);
};

// 桌面 Dev 实例会注入独立 home；若这里仍读真实 HOME，启动迁移和外观操作
// 会污染其他实例，所以显式 home 覆盖优先于 HOME/USERPROFILE。
function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home，设置服务却仍写真实 HOME，
  // 导致启动迁移和外观操作污染其他实例。与 Electron 的显式 home 覆盖保持一致。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

// 默认值必须由 schema 生成，手写对象会与 schema 默认值逐渐不一致。
function defaultSettings(): AppSettings {
  return appSettingsSchema.parse({});
}

function buildCorruptSettingsBackupPath(settingsFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${settingsFile}.corrupt-${timestamp}`;
}

// [失败路径] 隔离而不是删除：坏文件是用户可能想人工修复的唯一副本，
// 移到带时间戳的备份路径后，后续 update 才能重建合法配置。
async function quarantineCorruptSettingsFile(settingsFile: string, error: unknown): Promise<void> {
  const backupPath = buildCorruptSettingsBackupPath(settingsFile);
  try {
    // 用户手动编辑或远端磁盘异常可能把 setting.json 写成非 JSON（例如 ":wq"）。
    // 如果只返回默认值不隔离坏文件，每次启动都会重复解析失败；这里保留备份后让后续 update 重建合法配置。
    maybeThrowInjectedFsFault({ operation: "rename", path: settingsFile });
    await rename(settingsFile, backupPath);
    log("invalid settings json backed up:", backupPath, "error:", error);
  } catch (renameError) {
    if (
      renameError &&
      typeof renameError === "object" &&
      "code" in renameError &&
      (renameError as { code?: string }).code === "ENOENT"
    ) {
      // 启动时多个服务可能同时读取同一个坏 setting.json。
      // 第一个读取已经完成隔离后，后续读取再 rename 会遇到 ENOENT；这是并发下的预期结果，不应当按备份失败刷错误日志。
      log("invalid settings json already quarantined by another reader, returning defaults");
      return;
    }
    log("invalid settings json backup failed, returning defaults. error:", renameError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 只在内存里迁移会让磁盘继续保存旧版本，回滚的旧客户端读到旧值又改回来；
// 这里的每个条件对应一项必须落盘的迁移标记。
function shouldPersistSettingsMigrations(rawValue: unknown): boolean {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return false;
  const raw = rawValue as Record<string, unknown>;
  return (
    // 原因：只在内存迁移仍会把磁盘上的 3 留给回滚客户端；必须走现有写锁落盘。
    raw.remoteBoundaryOnboardingVersion === 3 ||
    (needsLegacyAccountConnectionMigration(rawValue) &&
      readIncompleteLegacyTeamConnections(rawValue).length === 0) ||
    raw.closeToTrayOnWindowsMigrationInitialized !== true ||
    raw.messageStreamShowReasoningMigrationInitialized !== true ||
    raw.taskAutoArchiveResetVersion !== 1
  );
}

interface ReadSettingsResult {
  settings: AppSettings;
  needsMigrationPersist: boolean;
}

// 读取分两层：解析成功与否决定返回值，needsMigrationPersist 决定调用方
// 是否要再走一次写队列。两者必须来自同一份 raw，否则会漏掉迁移。
async function readSettingsWithMetaAt(settingsFile: string): Promise<ReadSettingsResult> {
  try {
    // settingService.get() 会被 UI 和远程会话高频调用。
    // 之前每次读取都把完整配置写入生产日志，导致日志暴涨且暴露路径/配置细节；普通读取只保留开发态 debug。
    debugLog("reading settings from:", settingsFile);
    const raw = await readFile(settingsFile, "utf-8");
    let rawValue: unknown;
    try {
      rawValue = JSON.parse(raw);
    } catch (parseError) {
// 保留最后一次解析错误：重试全部失败时要按坏文件隔离，
// 记录最早那次错误反而无法反映最终失败原因。
      let lastParseError: unknown = parseError;
      // setting.json 可能正被另一次 update 覆盖写入，读者会短暂读到半截 JSON。
      // 先做短重试，只有连续失败才按坏文件隔离，避免把正常会话配置误清成默认值。
      for (let retryAttempt = 1; retryAttempt <= SETTINGS_PARSE_RETRY_COUNT; retryAttempt += 1) {
        await delay(SETTINGS_PARSE_RETRY_DELAY_MS);
        try {
          rawValue = JSON.parse(await readFile(settingsFile, "utf-8"));
          break;
        } catch (retryParseError) {
          lastParseError = retryParseError;
        }
      }
// 三次重试后仍未解析成功，才认定为坏文件并进入隔离流程。
      if (rawValue === undefined) {
        await quarantineCorruptSettingsFile(settingsFile, lastParseError);
        return {
          settings: defaultSettings(),
          needsMigrationPersist: false,
        };
      }
    }
// 先迁移再校验：legacy 字段需要先补齐成当前 schema 形态，
// 否则老用户配置会因缺少新字段被判为非法并整体回退默认值。
    const result = appSettingsSchema.safeParse(migrateLegacyAccountConnectionSettings(rawValue));
    if (!result.success) {
      log(
        "read failed schema validation, returning defaults. error:",
        formatZodError(result.error),
      );
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }
    return {
      settings: result.data,
// 迁移标记基于原始 raw 判断，不能用解析后的结果，否则标记会随迁移被抹掉。
      needsMigrationPersist: shouldPersistSettingsMigrations(rawValue),
    };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      debugLog("settings file missing, using defaults");
      return {
        settings: defaultSettings(),
        needsMigrationPersist: false,
      };
    }

    // 文件解析失败等异常兜底返回默认值
    log("read failed, returning defaults. error:", err);
    return {
      settings: defaultSettings(),
      needsMigrationPersist: false,
    };
  }
}

// 写入前重新读一次磁盘上的 legacy 字段：本次 settings 是内存快照，
// 不含只存在于磁盘的账号连接信息，直接覆盖会把它删掉。
async function writeSettingsAt(
  settingsFile: string,
  settings: AppSettings,
  shouldCommit: () => boolean = () => true,
  enterCommitPhase: () => void = () => undefined,
  commitAccountSelection = false,
): Promise<void> {
  const settingsDir = dirname(settingsFile);
  log("writing settings to:", settingsFile, JSON.stringify(settings));
  maybeThrowInjectedFsFault({ operation: "mkdir", path: settingsDir });
  await mkdir(settingsDir, { recursive: true });
// 建目录之后才判 generation：过期写不再继续落盘，但仍保证目录存在。
  if (!shouldCommit()) return;
  maybeThrowInjectedFsFault({ operation: "writeFile", path: settingsFile });
  const raw = await readLegacyAccountConnectionSettingsFile(settingsFile);
// 保留旧 Team 待补 OAuth 的字段，回滚到旧客户端时仍能读到原配置；
// 这些字段不在当前 schema 中，只能靠原样搬运维持兼容。
  const rollbackFields = retainLegacyAccountConnectionFields(raw);
  const persisted = { ...rollbackFields, ...settings };
  // 旧 Team 尚待 OAuth 补组织时，schema 的默认 {} 不是用户的新选择。
  // 普通偏好保存必须保留新字段缺席；只有迁移提交或用户显式选连接才结束旧导入。
  if (!commitAccountSelection && readIncompleteLegacyTeamConnections(raw).length > 0) {
// 普通偏好保存必须保留「新字段缺席」，否则 schema 默认的空对象会被当成
// 用户的真实选择，旧 Team 导入就此结束。
    delete persisted.providerFamilyConnectionSelections;
  }
// 原子替换：临时文件写完后 rename，读者不会看到半截 JSON。
  await atomicWriteText(settingsFile, JSON.stringify(persisted, null, 2), {
// 文件锁由外层 withAtomicFileLock 持有，这里再锁一次会自锁；
// `useFileLock: false` 是约定：外层 `withAtomicFileLock` 已持锁，内层再锁会自锁。
    useFileLock: false,
    beforeRename: () => {
      if (!shouldCommit()) {
        // 提交前超时的旧写只能清理临时文件，不能晚到 rename 覆盖新语言偏好。
// rename 前再判一次 generation：这是唯一还能拦截迟到写的时机，
// 一旦 rename 完成就会覆盖别人的新偏好。
        throw new Error("stale settings write skipped before atomic rename");
      }
      enterCommitPhase();
    },
  });
  log("write done");
}

export function createSettingService(): ISettingService {
  return createSettingServiceWithMigrations().service;
}

/** Host 私有迁移入口，不加入 Setting RPC；普通 get/update 从不等待 OAuth 查询。 */
// Host 私有入口：普通 get/update 不等待 OAuth 查询，迁移由调用方显式触发，
// 因此不暴露到 Setting RPC。
export function createSettingServiceWithMigrations(): {
  service: ISettingService;
  setWorkspaceProjection: (
    reader: (settings: AppSettings) => Promise<WorkspaceSettingsProjection>,
  ) => void;
  prepareLegacyAccountConnections: (
    resolveOrganization: (connection: LegacyTeamConnection) => Promise<string | null>,
  ) => Promise<readonly ProviderFamilyDomain[]>;
} {
  // 原因：每次 IO 动态读 HOME 会让旧异步投影写进后来实例的目录。
  // 在实例创建时取值，既支持测试/Host 注入，也让读取、文件锁与替换始终同源。
// INV-01：路径在实例创建时解析一次并闭包捕获，后续读、锁、替换都用同一个值；
// 每次 IO 重新读 HOME 会让异步投影写进另一个实例的目录。
  const settingsFile = join(resolveUserHomeDir(), ".zcode", "v2", "setting.json");
  const getSettingsFile = () => settingsFile;
  const getSettingsDir = () => dirname(settingsFile);
  const readSettingsWithMeta = () => readSettingsWithMetaAt(settingsFile);
  const readSettings = async () => (await readSettingsWithMeta()).settings;
  const writeSettings = (
    settings: AppSettings,
    shouldCommit?: () => boolean,
    enterCommitPhase?: () => void,
    commitAccountSelection?: boolean,
  ) =>
    writeSettingsAt(settingsFile, settings, shouldCommit, enterCommitPhase, commitAccountSelection);
// 串行队列：同一进程内的 update 与迁移写必须按入队顺序执行，
// 否则两个补丁都基于旧快照覆盖，后写者会抹掉前一个字段。
  let updateQueue = Promise.resolve();
// 代际号只增不减，用于让超时/失败的旧写失去提交资格。
  let writeQueueGeneration = 0;
  let workspaceProjection:
    | ((settings: AppSettings) => Promise<WorkspaceSettingsProjection>)
    | undefined;
// 工作区投影只影响返回值，不影响磁盘内容；绑定前是恒等函数，
// 保证未接投影的 Host（例如 CLI）行为与旧版一致。
  const projectSettings = async (settings: AppSettings): Promise<AppSettings> =>
    workspaceProjection
      ? appSettingsSchema.parse({ ...settings, ...(await workspaceProjection(settings)) })
      : settings;

// 入队的每个任务都重新拿 generation；成功与失败都要执行 runCurrentUpdate，
// 否则一次失败会让后续所有写永远排在拒绝态上。
  const enqueueSettingsWrite = async (
    runUpdate: (shouldCommit: () => boolean, enterCommitPhase: () => void) => Promise<void>,
  ) => {
    const runCurrentUpdate = async () => {
// 先自增再比较：一旦新写入队，旧写的 shouldCommit 立刻变 false，
// 哪怕它还没走到 rename。
      const currentGeneration = ++writeQueueGeneration;
// shouldCommit 是闭包而不是布尔值，让写路径在任意时刻都能看到最新代际。
      const shouldCommit = () => currentGeneration === writeQueueGeneration;
      await mkdir(getSettingsDir(), { recursive: true });
      // Main 的窗口尺寸与 Host 的远程目录会并发保存同一文件。只锁 rename 会让后写者
      // 用锁外读取的旧快照覆盖对方字段；事务必须在锁内重新读取、合并、提交。
// INV-02：锁包住「重读-合并-提交」整个事务，而不是只包 rename；
// 否则后写者会用锁外读到的旧快照覆盖对方字段。
      return withAtomicFileLock(getSettingsFile(), () =>
        withSettingsWriteQueueTimeout(
          (enterCommitPhase) => runUpdate(shouldCommit, enterCommitPhase),
          () => {
            if (writeQueueGeneration === currentGeneration) {
              writeQueueGeneration += 1;
            }
          },
        ),
      );
    };
    const queued = updateQueue.then(
      () => runCurrentUpdate(),
      () => runCurrentUpdate(),
    );
// [失败路径] 队列本身必须吞掉失败，否则一次写失败会让 updateQueue
// 永久处于 rejected，之后所有写入都直接短路。
    updateQueue = queued.catch(() => {});
    await queued;
  };

  const service: ISettingService = {
// get 也可能触发迁移写盘，因此要等队列排空再读，并在这里补一次写；
// 不补的话迁移标记会一直留在内存，直到某次 update 才偶然落盘。
    async get(): Promise<AppSettings> {
      // 设置切换后可能立即创建或冷恢复 Session；读取若越过已入队写入，
      // runtime 会固定旧开关值。先等待现有写队列，保证启动偏好读取到已提交的选择。
// 先等已入队写入：设置切换后可能立即创建或冷恢复 Session，
// 读到旧开关会让 runtime 固定错误值。
      await updateQueue;
      const result = await readSettingsWithMeta();
      const projected = await projectSettings(result.settings);
      if (
        !result.needsMigrationPersist &&
        JSON.stringify(projected) === JSON.stringify(result.settings)
      ) {
        return projected;
      }

      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const latest = await readSettingsWithMeta();
        const projected = await projectSettings(latest.settings);
        if (
          !latest.needsMigrationPersist &&
          JSON.stringify(projected) === JSON.stringify(latest.settings)
        ) {
          return;
        }

        // 初始化原因：旧版设置可能已把无法区分来源的默认值落盘；升级后按 schema 统一迁移一次。
        // 迁移写盘必须进入 updateQueue，并在队列内重读最新文件，避免覆盖并发保存的其他设置。
// 队列内重读最新文件再投影，避免用 get 开头那份旧快照写回；
// `writeSettings` 在队列内二次判等：等待期间被别的写处理过即跳过。
        await writeSettings(projected, shouldCommit, enterCommitPhase);
      });

      return readSettings();
    },

// update 是唯一的补丁入口：校验、CAS、合并、串行化都在这里完成，
// 调用方不应自己读改写，否则会绕过 generation 与锁。
    async update(patch: Partial<AppSettings>, expectedAccountSettings): Promise<void> {
      const runUpdate = async (shouldCommit: () => boolean, enterCommitPhase: () => void) => {
// 补丁先过 patch schema 再合并：未知键被剥离，类型错误在这里失败，
// 不会把半合法对象写进磁盘。
        const validatedPatch = appSettingsPatchSchema.parse(normalizeSettingsPatch(patch));
        const current = await readSettings();
        // 原因：完整连接映射来自读改写快照；任一无版本写入者都能绕过其它窗口的 CAS。
// INV-05：完整连接映射来自读改写快照，任何无版本写入都能绕过其他窗口的 CAS，
// 因此只要补丁涉及该字段就必须带期望版本。
        const writesConnections = Object.hasOwn(patch, "providerFamilyConnectionSelections");
        if (
          writesConnections &&
          expectedAccountSettings?.providerFamilyDomainUpdatedAt === undefined
        ) {
          throw new Error("Account connection CAS required");
        }
        if (expectedAccountSettings) {
          // 账号查询期间用户可能已手动切换。必须在同一写队列内校验，不能靠调用方先读再写。
          const expected = appSettingsPatchSchema.parse(expectedAccountSettings);
          if (
            current.providerFamilyDomain !== expected.providerFamilyDomain ||
            // 原因：另一窗口重新选择相同身份时映射值不变；旧回滚仍须按操作版本拒绝。
            (expected.providerFamilyDomainUpdatedAt !== undefined &&
              (current.providerFamilyDomainUpdatedAt ?? 0) !==
                expected.providerFamilyDomainUpdatedAt) ||
            JSON.stringify(current.providerFamilyConnectionSelections ?? {}) !==
              JSON.stringify(expected.providerFamilyConnectionSelections ?? {})
          ) {
// [失败路径] 冲突统一抛错由调用方重试，不在这里自动合并，避免误判用户意图。
            throw new Error("Account connection settings changed");
          }
        }
        const merged = appSettingsSchema.parse({
          ...current,
          ...validatedPatch,
        });

// 版本取「当前时间」与「旧版本 +1」的较大者：即使选择值相同也要前进，
// 否则另一个窗口拿着旧版本仍能通过 CAS。
        if (writesConnections) {
          // 即使选择值相同也代表一次新操作，版本由同一写锁保证单调递增。
// max 保证单调：系统时钟回拨时仍比旧值大，CAS 不会因为时间倒退失效。
          merged.providerFamilyDomainUpdatedAt = Math.max(
            validatedPatch.providerFamilyDomainUpdatedAt ?? Date.now(),
            (current.providerFamilyDomainUpdatedAt ?? 0) + 1,
          );
        }

        // 打开工作区后会几乎同时写 recentProjects 和 lastWorkspaceSession。
        // 之前两个 update 都是基于各自读到的旧 settings 直接覆盖写回，
        // 后写入的补丁会把前一个字段整块抹掉，导致下次启动恢复不到会话。
        // 这里把写入串行化，让每个补丁都基于上一次真正落盘后的最新状态继续合并。
// Set 去重保留首次出现顺序，再截断到上限；不排序是有意的——
// 最近使用顺序本身就是信息。
        if (merged.recentProjects) {
          merged.recentProjects = [...new Set(merged.recentProjects)].slice(0, MAX_RECENT_PROJECTS);
        }

        await writeSettings(
          await projectSettings(merged),
          shouldCommit,
          enterCommitPhase,
          Object.hasOwn(patch, "providerFamilyConnectionSelections"),
        );
      };

      await enqueueSettingsWrite(runUpdate);
    },

// 数据目录迁移先校验再复制，最后才写设置；顺序反过来会让新设置指向
// 尚未复制完的目录，启动时读不到旧数据。
    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      const currentBaseDir = getDataBaseDir();
      const targetBaseDir = newDir?.trim() || homedir();
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // Windows 安装目录由安装器/自动更新管理，把 .zcode/v2 放进去可能在升级时被覆盖。
        // 迁移前在 service 层拦截，避免 UI 入口变化或 RPC 调用绕过前端判断。
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

// 源与目标相同就跳过复制，避免把目录复制进自身；
// 复制成功后才更新设置，失败时保持原路径可用。
      if (currentBaseDir !== targetBaseDir) {
        log("copying data directory from", currentBaseDir, "to", targetBaseDir);
        await copyDataDirectory(currentBaseDir, targetBaseDir);
        log("data directory copy done");
      }

      await this.update({ dataBaseDir: newDir });
    },
  };

// 同一时刻只跑一次迁移：并发调用复用同一个 Promise，避免重复读文件、
// 重复发起组织查询，也避免两次写互相覆盖。
  let inFlight: Promise<readonly ProviderFamilyDomain[]> | null = null;
  let migrationComplete = false;
  return {
    service,
    setWorkspaceProjection(reader) {
      if (workspaceProjection) throw new Error("settings.workspace-projection-already-bound");
      workspaceProjection = reader;
    },
// 迁移分三段：先做普通 get 保证基础配置就绪，再在锁外做网络查询，
// 最后在写队列内按原输入复核后提交；网络不能占着文件锁。
    prepareLegacyAccountConnections(resolveOrganization) {
      // 已完成导入后不让每次请求鉴权重复读迁移文件。恢复旧备份需要重启 Host。
// 完成标记只在「没有未解决连接」时为 true；恢复旧备份需要重启 Host，
// 否则每次鉴权都会重复读迁移文件。
      if (migrationComplete) return Promise.resolve([]);
      if (inFlight) return inFlight;
      const run = async (): Promise<readonly ProviderFamilyDomain[]> => {
        await service.get();
        const original = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
        const incomplete = readIncompleteLegacyTeamConnections(original);
        if (incomplete.length === 0) return [];
        // 网络在写队列外：代理设置读取及用户操作均可继续，不形成 get -> HTTP -> get 循环。
        const resolved = await Promise.all(
          incomplete.map(async (connection) => ({
            ...connection,
            organizationId: await resolveOrganization(connection).catch(() => null),
          })),
        );
        await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
          const latest = await readLegacyAccountConnectionSettingsFile(getSettingsFile());
          // 只核对迁移输入，不因普通语言/窗口设置变化丢失合法结果，也不覆盖用户新账号意图。
          if (
            Object.hasOwn(latest, "providerFamilyConnectionSelections") ||
            latest.providerFamilyDomain !== original.providerFamilyDomain ||
            JSON.stringify(retainLegacyAccountConnectionFields(latest)) !==
              JSON.stringify(retainLegacyAccountConnectionFields(original))
          )
            return;
          if (resolved.some((entry) => !entry.organizationId?.trim())) return;
          const migrated = appSettingsSchema.parse(migrateLegacyAccountConnectionSettings(latest));
          const selections: ProviderFamilyConnectionSelectionSettings = {
            ...migrated.providerFamilyConnectionSelections,
          };
          for (const { family, productId, projectId, organizationId } of resolved) {
            selections[family] = {
              kind: "team-coding-plan",
              productId,
              projectId,
              organizationId: organizationId!.trim(),
            };
          }
          await writeSettings(
            await projectSettings({ ...migrated, providerFamilyConnectionSelections: selections }),
            shouldCommit,
            enterCommitPhase,
            true,
          );
        });
        return readIncompleteLegacyTeamConnections(
          await readLegacyAccountConnectionSettingsFile(getSettingsFile()),
        ).map((entry) => entry.family);
      };
      const pending = run();
      inFlight = pending;
      void pending.then(
        (unresolved) => {
          migrationComplete = unresolved.length === 0;
          if (inFlight === pending) inFlight = null;
        },
        () => {
          if (inFlight === pending) inFlight = null;
        },
      );
      return pending;
    },
  };
}
