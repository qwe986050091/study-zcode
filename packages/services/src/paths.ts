/* path 规则集中维护：旧 task 快照与 provider 配置路径仍在这里收口。 */
// INV-01：所有数据目录都必须经 getDataBaseDir() 派生，否则 setDataBaseDir 的重定向只对部分路径生效。
// INV-02：baseDir 的来源在模块加载时快照，运行期不再读 process.env.HOME，避免旧实例写进新目录。
// INV-03：Windows 安装目录判定的比较键必须 resolve + 小写 + 去尾分隔符，否则大小写或短路径差异可绕过校验。
// INV-04：workspaceHash 只由 workspaceKey 决定，落盘目录与 session 持久化必须共用同一算法。
import { lstatSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, win32 } from "node:path";
import { homedir } from "node:os";
import {
  DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
  ZCODE_AGENT_RUNTIME,
} from "@zcode/shared";

// 运行期覆盖值：测试与「切换数据根」只改这一处，避免各处缓存的 baseDir 各走各的。
let _dataBaseDir: string | null = null;
export const ZCODE_WINDOWS_APP_INSTALL_DIR_ENV = "ZCODE_WINDOWS_APP_INSTALL_DIR";
// [权衡] 两个来源在模块求值时就固化：服务会起后台刷新任务，若每次动态读 env，
// 宿主改完 HOME 后旧实例会把数据写进新目录（INV-02）。
const envDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || null;
const defaultDataBaseDir = process.env.HOME?.trim() || homedir();

export interface DataBaseDirTargetValidationOptions {
  platform?: NodeJS.Platform | string;
  env?: Record<string, string | undefined>;
  appInstallDir?: string | null;
}

export type DataBaseDirTargetValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE;
      forbiddenDir: string;
    };

/** Set the base directory for app data (replaces homedir() prefix). */
export function setDataBaseDir(dir: string | null): void {
  // 运行期唯一写入口：trim 后为空必须折叠成 null，否则空串会被当成有效根并拼出相对路径。
  _dataBaseDir = dir?.trim() || null;
}

/** Get the current base directory. Priority: setDataBaseDir() > env ZCODE_DATA_BASE_DIR > homedir(). */
// [权衡] 优先级固定为显式设置 > env > homedir，且不做合并：多来源并存会让同一份配置落在两个根下。
export function getDataBaseDir(): string {
  if (_dataBaseDir) return _dataBaseDir;
  if (envDataBaseDir) return envDataBaseDir;
  // 服务实例会启动后台刷新任务；若每次调用都动态读取 HOME，
  // 测试或宿主切换环境变量后，旧实例可能把数据写到新实例目录。
  return defaultDataBaseDir;
}

/** {dataBaseDir}/.zcode */
// getZCodeDataRootDir 是所有产品目录的唯一锚点：改动这里的 join 目标，等于迁移已有用户的落盘位置。
export function getZCodeDataRootDir(): string {
  // 用 join 而不是字符串拼接：分隔符由平台决定，手写 / 在 Windows 上会让后续 win32.normalize 多一步。
  return join(getDataBaseDir(), ".zcode");
}

/** 非项目对话共享的真实工作目录；默认 ~/.zcode/workspace/default。 */
export function getConversationWorkspaceDir(): string {
  // 非项目对话共用 workspace/default 这一个目录，不能按会话 id 再分支，旧记录里的相对路径都基于它。
  return join(getZCodeDataRootDir(), "workspace", "default");
}

/** {dataBaseDir}/.zcode/v2 */
export function getAppConfigDir(): string {
  // v2 是配置版本段：tasks-index.sqlite 与 sessions 都经它拼接，换段名等于让旧索引与旧会话同时失联。
  return join(getZCodeDataRootDir(), "v2");
}

function readEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  // 先精确匹配并 trim：进程环境的键名就是标准大小写，这一步覆盖绝大多数调用，避免无谓全表扫描。
  const direct = env[key]?.trim();
  // 非空才返回，空串继续往下找：注入对象可能把 ProgramFiles 设成空串却另存了大小写变体。
  if (direct) {
    return direct;
  }

  const lowerKey = key.toLowerCase();
// [权衡] Windows 环境变量名大小写不敏感，而注入的 env 是普通 Record：先精确匹配，
// 再退化为大小写不敏感扫描，避免 ProcessEnv 与测试注入对象行为不一致。
  for (const [candidateKey, value] of Object.entries(env)) {
    // 比较前双方都转小写：测试与 JSON 注入的键名可能是 programfiles，Windows 上它等价于 ProgramFiles。
    if (candidateKey.toLowerCase() !== lowerKey) {
      continue;
    }
    // 命中同名键后仍要 trim 判空：空串必须继续扫描下一项，否则会把「已配置」当成有效目录。
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  // 全部候选都空时返回 undefined 而不是空串：调用方用真值判断，空串会被误认为已配置。
  return undefined;
}

// 比较键必须与 isWindowsPathEqualOrInside 的拼接方式配套：去尾分隔符后统一补反斜杠，
// 否则 C:\ZCode 会误匹配 C:\ZCodeBeta（字符串前缀包含而非目录包含）。
function normalizeWindowsComparablePath(pathValue: string): string | null {
  // 先 trim 再判空：配置值常带首尾空格，直接 normalize 会把空格当成路径字符带进比较键。
  const trimmed = pathValue.trim();
  // 空串返回 null 让调用方跳过该候选；win32.normalize("") 会返回 "."，不拦就会被当成当前目录。
  if (!trimmed) {
    return null;
  }

  // 显式指定 win32 语义：在 Linux 上跑测试时 process 平台不是 win32，用默认 normalize 不会把 / 收敛成反斜杠。
  const normalized = win32.normalize(trimmed).replace(/[\\/]+$/, "");
// resolve 会展开相对路径以及 . 和 ..：不 resolve 就能用 ProgramFiles\ZCode\..\ZCode 之类的写法绕过校验（INV-03）。
  // 纯分隔符归一后可能变成空串，此时返回 null，避免用空串构造比较键后与任何路径都不相等。
  if (!normalized) {
    return null;
  }

  return win32
    .resolve(normalized)
    .replace(/[\\/]+$/, "")
    // 最后统一小写：Windows 文件系统大小写不敏感，比较键必须大小写无关才能拦住 C:\ZCode 与 c:\zcode。
    .toLowerCase();
}

// 判定目录包含而不是字符串前缀：尾分隔符由归一化统一补齐，C:\ZCode 与 C:\ZCode\x 才算包含。
function isWindowsPathEqualOrInside(pathValue: string, rootValue: string): boolean {
  const normalizedPath = normalizeWindowsComparablePath(pathValue);
  // 根同样要归一：调用方传入带尾分隔符的安装目录时，不归一会让 startsWith 少一个反斜杠而漏判。
  const normalizedRoot = normalizeWindowsComparablePath(rootValue);
  // 任一侧归一化失败都返回 false：无法比较时按「不包含」处理，宁可漏拦也不误拒合法数据目录。
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

// 相等分支不能省：目标恰好等于安装目录时 startsWith 为 false，会漏掉最危险的一种配置。
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

// 候选集合覆盖「显式传入、ZCode 自己的环境变量、三个 ProgramFiles 变体、per-user 安装」，
// 统一按 win32 语义归一后去重，避免同一目录被反复检查。
function collectWindowsForbiddenAppInstallDirs(
  options: Required<Pick<DataBaseDirTargetValidationOptions, "env">> &
    Pick<DataBaseDirTargetValidationOptions, "appInstallDir">,
): string[] {
  const env = options.env;
  // ProgramFiles 只是 64 位默认目录，32 位进程与 per-user 安装各有别的变量，下面三行必须一起覆盖。
  const programFiles = readEnvValue(env, "ProgramFiles");
  const programFilesX86 = readEnvValue(env, "ProgramFiles(x86)");
  const programW6432 = readEnvValue(env, "ProgramW6432");
  // LOCALAPPDATA 对应 per-user 安装（Programs\ZCode），这是非提权安装最常见的位置。
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  // 候选顺序即报错优先级：显式传入的 appInstallDir 排第一，命中时错误信息最贴近调用方。
  const candidates = [
    options.appInstallDir,
    // ZCode 专用环境变量优先于按 ProgramFiles 推断：安装到非标准目录时只有它能命中。
    readEnvValue(env, ZCODE_WINDOWS_APP_INSTALL_DIR_ENV),
    programFiles ? win32.join(programFiles, "ZCode") : null,
    programFilesX86 ? win32.join(programFilesX86, "ZCode") : null,
    programW6432 ? win32.join(programW6432, "ZCode") : null,
    localAppData ? win32.join(localAppData, "Programs", "ZCode") : null,
  ];
  // seen 以归一化后的路径为键：ProgramFiles 与 ProgramW6432 常指向同一目录，不去重会重复校验。
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" ? normalizeWindowsComparablePath(candidate) : null;
    // 一个 continue 同时跳过空候选、归一化失败与重复项，避免下方拿 null 去比较。
    if (!candidate || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    // 入列的是原始 candidate 而不是 normalized：错误提示要回显用户能认出的安装目录写法。
    result.push(candidate);
  }

  return result;
}

// 只拦截 Windows 安装目录：其他平台不存在「程序文件与用户数据混放、升级时被覆盖」的问题。
export function validateDataBaseDirTarget(
  targetBaseDir: string,
  options: DataBaseDirTargetValidationOptions = {},
): DataBaseDirTargetValidationResult {
// [失败路径] 非 win32 直接放行且不读 env：避免在 Linux 上把 HOME 之类的路径误判成安装目录。
  if ((options.platform ?? process.platform) !== "win32") {
    return { ok: true };
  }

// 返回第一个命中的禁止目录而不是布尔值：错误提示要指出具体是哪个安装位置，用户才改得对。
  // 顺序约束：targetBaseDir 不在循环前统一归一，比较函数内部会 resolve + 小写；两处各做一套会让口径分叉。
  for (const forbiddenDir of collectWindowsForbiddenAppInstallDirs({
    // 未注入 env 时读 process.env；不能为空对象兜底，否则真实安装目录会全部漏检。
    env: options.env ?? process.env,
    appInstallDir: options.appInstallDir ?? null,
  })) {
// 包含关系双向都危险：目标在安装目录内会被升级覆盖，目标等于安装目录则可能被卸载清理删掉。
    if (isWindowsPathEqualOrInside(targetBaseDir, forbiddenDir)) {
      return {
        ok: false,
        code: DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
        forbiddenDir,
      };
    }
  }

  // 所有候选都不包含才放行：早退只允许发生在命中分支，这个 return 必须留在循环之后。
  return { ok: true };
}

// 下面几个目录 getter 都只做 getZCodeDataRootDir 的 join，不得再加分支；改动子目录名会让已有用户的落盘位置失配。
export function getExportLogStageDir(): string {
  // exportLogs 把它当 stageRootDir：暂存产物与正式 export-log 分开，用户才不会把半成品当导出结果。
  return join(getZCodeDataRootDir(), "export-log-stage");
}

export function getExportLogDir(): string {
  // 每次导出都在此目录下 mkdtemp 建子目录，因此它只负责存在，不能预建与导出基名同名的目录。
  return join(getZCodeDataRootDir(), "export-log");
}

export function getFeedbackRootDir(): string {
  // feedback 根不参与数据目录清理：清理扫描只认 storageCatalog 的类别目录，避免误删用户反馈。
  return join(getZCodeDataRootDir(), "feedback");
}

export function getFeedbackAttachmentDir(): string {
  // 附件根被 feedbackService 用 startsWith 校验，改层级会让所有历史附件路径失配。
  return join(getFeedbackRootDir(), "attachments");
}

export function getFeedbackLogArchiveDir(): string {
  // 归档目录与附件目录同级：feedbackService 用根路径前缀校验，改层级会让历史归档路径失配。
  return join(getFeedbackRootDir(), "logs");
}

export function getGitCheckpointIndexRootDir(): string {
  // checkpoint 临时 index 落在独立目录，避免污染用户仓库的 .git/index 或产生可见分支。
  return join(getZCodeDataRootDir(), "git-checkpoint-index");
}

/** ~/.zcode/v2/tasks-index.sqlite */
export function getTasksIndexDatabasePath(): string {
  // 文件名 tasks-index.sqlite 是迁移逻辑的定位锚点，改名等于让服务新建一个空库。
  return join(getAppConfigDir(), "tasks-index.sqlite");
}

/** workspace 级身份键：远程优先使用 workspaceIdentity，本地回退 workspacePath。 */
// [权衡] 远程 workspace 的 workspacePath 只是本地占位路径，必须优先用 workspaceIdentity；
// 反过来会让同一远程工作区在不同机器上算出不同 hash，会话目录无法复用。
function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  // 前置条件：workspaceIdentity 必须来自可信的远端会话信息；这里只 trim 不校验，传错等于给同一工作区换了一个会话目录。
  return workspaceIdentity?.trim() || workspacePath;
}

/** 与 ZCode session 持久化一致：使用 workspaceKey 的 SHA-256 前 12 位 */
// 截断到 12 位 hex 是目录名长度与碰撞概率的折中：单机工作区量级下 48 bit 碰撞可忽略。
export function getWorkspaceHash(workspacePath: string, workspaceIdentity?: string): string {
  return createHash("sha256")
  // 哈希输入必须与 getWorkspaceKey 完全一致：换分隔符或加盐都会让已落盘的 sessions 目录失联（INV-04）。
    .update(getWorkspaceKey(workspacePath, workspaceIdentity))
    .digest("hex")
    .slice(0, 12);
}

/** ~/.zcode/v2/sessions/{workspaceHash} */
function getTaskSessionDir(workspacePath: string, workspaceIdentity?: string): string {
  // 不按 provider 或 task 再分叉：会话目录只由 workspace hash 决定，多一层会让旧快照路径全部失配。
  return join(getAppConfigDir(), "sessions", getWorkspaceHash(workspacePath, workspaceIdentity));
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json */
export function getLegacyTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  // 前置条件：taskId 原样拼进文件名，调用方必须保证它不含路径分隔符与 ..；本函数不做越界校验。
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.json`);
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.deleted.json */
export function getLegacyDeletedTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  // 与正常快照同目录同命名规则：删除态必须能被旧版本按同一算法找到，改名等于让删除记录失效。
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.deleted.json`);
}

/**
 * GLM（唯一 agent provider）的配置目录：~/.zcode/cli。
 * Bugfix：GLM 配置改为直接读写新版 zcode-cli 的全局配置目录，不做 workspace 隔离，
 * 避免同机不同工作区配置漂移。
 */
export function getProviderWorkspaceConfigDir(): string {
// [权衡] 刻意不做 workspace 隔离：provider 全局配置按机器共享，否则同机多工作区会各自漂移。
  // 前置条件：nativeConfigDir 必须是相对段；join 遇到绝对路径会丢弃前面的数据根，配置会写到盘符根。
  return ZCODE_AGENT_RUNTIME.nativeConfigDir
    ? join(getDataBaseDir(), ZCODE_AGENT_RUNTIME.nativeConfigDir)
    : join(getDataBaseDir(), ".zcode", "cli");
}

/**
 * Copy the .zcode/v2 data directory from one base dir to another.
 * Excludes setting.json and its transient atomic-write siblings — bootstrap
 * state must only live at the default homedir location.
 */
// [事务] 迁移不是原子的：cp 期间新旧两个根同时存在，调用方必须先复制完成再切换 getDataBaseDir，
// 中途崩溃只会留下「新根已部分写入」，反过来先切换则会丢掉尚未复制的配置。
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  // 源与目标都只迁移 v2 段：.zcode 下的 workspace 与 cli 目录各有独立生命周期，不能跟着搬。
  const oldDir = join(oldBaseDir, ".zcode", "v2");
  const newDir = join(newBaseDir, ".zcode", "v2");
  // force:false 保证不覆盖目标已有文件：迁移冲突要显式失败，而不是静默丢掉新根上的数据。
  await cp(oldDir, newDir, {
    recursive: true,
    force: false,
    filter: (source) => {
// 过滤按 basename 而不是完整路径：fs.cp 传入的 source 在不同 Node 版本里可能是相对或绝对形式。
      const sourceName = basename(source);
      if (sourceName === "setting.json" || sourceName.startsWith("setting.json.")) {
        // setting.json.lock 和 setting.json.*.tmp 由原子写入短暂创建/删除，
        // 复制过程中扫描到已消失的 lock 会触发 ENOENT，并让数据目录迁移失败。
        // 这些文件都属于 bootstrap 写入中间态，不能迁移到新数据根。
        return false;
      }
      // Windows 非提权环境下 fs.cp 无法复制符号链接（EPERM）。
      // 跳过符号链接可避免 Windows 非提权环境下 fs.cp 报 EPERM。
      try {
// [失败路径] lstat 在复制窗口内失败（文件已被并发删除）时放行，让 cp 自己报 ENOENT，
// 而不是在这里把它当成「跳过」，否则会静默漏迁真实配置。
        if (lstatSync(source).isSymbolicLink()) return false;
      } catch {
        // lstat 失败时放行，让 cp 自行处理
      }
      return true;
    },
  });
}
