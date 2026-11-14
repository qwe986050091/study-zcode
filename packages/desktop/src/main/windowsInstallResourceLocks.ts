// Windows 安装资源锁：定位仍持有随包资源句柄的进程，并在升级前完成终止与交接。
// 纯函数加可注入依赖，扫描、终止、延时都由调用方提供，main 与测试共享同一语义。
// 失败不阻断升级：任何阶段异常都收敛为 errors 条目，由 main 记录后继续 NSIS 交接。
// 下列 INV 编号用于评审对齐，改动行为前必须先更新清单再动实现。
// INV-01 扫描结果必须按资源标记再过滤，不信任扫描实现的返回范围；守住位置：runWindowsUpdateProcessCleanup 的 initialLockProcesses 赋值；改错故障：taskkill /T /F 误杀用户自己的进程树。
// INV-02 PID 不是进程身份，Windows 会在退出屏障与专项清理之间复用；守住位置：过滤分支与 terminationPids 去重；改错故障：向无关的新进程发送强杀。
// INV-03 终止列表先去重再校验为正的安全整数；守住位置：terminationPids 构造；改错故障：pid 0 或非法值导致整批 taskkill 失败。
// INV-04 无候选进程时立即返回空结果，不得执行延时或二次扫描；守住位置：terminationPids 长度为 0 的提前返回；改错故障：升级在无锁场景白等 750ms。
// INV-05 扫描异常降级为空集而非抛出；守住位置：initial-scan 的 catch 分支；改错故障：辅助扫描不可用就直接阻断 NSIS 交接。
// INV-06 终止异常只记录，不能改写 terminationPids；守住位置：terminate 的 catch 分支；改错故障：报告与实际发出的强杀集合不一致，排障失真。
// INV-07 终止后必须等待 lockReleaseGraceMs 再复扫；守住位置：release-grace 的 delay 调用；改错故障：复扫读到尚未释放的句柄，误判清理失败。
// INV-08 延时异常不得跳过复扫；守住位置：release-grace 与 rescan 的先后顺序；改错故障：remainingLockProcesses 永远为空，锁残留被掩盖。
// INV-09 复扫异常保留空剩余列表并把错误交给调用方；守住位置：rescan 的 catch 分支；改错故障：main 无法区分无残留与查不到。
// INV-10 所有错误以 stage 前缀归一为字符串；守住位置：stringifyCleanupError 及各 catch；改错故障：多阶段错误无法定位到具体环节。
// INV-11 扫描脚本必须排除自身 PID；守住位置：buildWindowsProcessQueryScript 的 ownPid 判断；改错故障：清理进程把自己当作持锁者并自杀。
// INV-12 路径匹配统一反斜杠并小写后再比较；守住位置：normalizeForWindowsCommandLineMatch 与脚本内 ToLowerInvariant；改错故障：正斜杠写法漏匹配，锁进程被放过，安装失败。
// INV-13 空标记集必须判定为不匹配；守住位置：isWindowsProcessReferencingResourceMarkers 的空集分支；改错故障：空字符串被 includes 命中，任何进程都算持锁。
// INV-14 PowerShell 字面量单引号需成对转义；守住位置：toPowerShellSingleQuotedString；改错故障：含引号的安装路径引发脚本语法错误，扫描整体失败。
// INV-15 子进程查询必须设置超时与输出上限；守住位置：execFileAsync 的 timeout 与 maxBuffer；改错故障：CIM 查询挂起拖死主进程，或大量输出被截断后解析失败。
// INV-16 解析结果兼容单对象与数组两种形状；守住位置：parseWindowsProcessRows；改错故障：仅一个匹配进程时输出是对象，扫描结果被丢弃。
// INV-17 解析后过滤掉非法 PID；守住位置：findWindowsProcessesReferencingResourceMarkers 的末尾 filter；改错故障：缺字段的行以 pid 0 混入终止列表。
// INV-18 可写性探针必须清理 sentinel 与 renamed 两个临时文件；守住位置：probeWindowsPackagedResourceWritable 的 try 与 catch；改错故障：残留探针文件随包发布，并干扰下次快照。
// INV-19 探针清理失败不得覆盖原始可写性错误；守住位置：removeResourceProbeSentinel 的静默 catch；改错故障：真实写盘失败原因被清理异常顶替。
// INV-20 资源快照只读，且目录缺失时返回空条目；守住位置：snapshotWindowsPackagedResources 与 listResourceEntries；改错故障：诊断报告与磁盘实际状态不一致。
import { execFile } from "node:child_process";
import {
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// 3s 上限覆盖单次 CIM 全量枚举，超时即视为扫描失败，不做重试
// 拉长只会拖慢升级卡顿，缩短会在进程多的机器上误报无锁
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000;
const WINDOWS_PACKAGED_RESOURCE_DIRS = ["glm", "tools"];
// taskkill 返回不代表 Windows 已完成文件句柄释放；沿用已验证的 750ms
// 交接窗口。
// taskkill 返回只是信号送达，句柄释放由目标进程的退出流程异步完成
// 750ms 是已验证的交接窗口，改小会让复扫读到尚未关闭的句柄
// WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS 对外导出，测试与调用方必须共用同一节奏，避免各自写死
export const WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS = 750;

// WindowsInstallResourceLockProcess 只能认 pid 与命令行、可执行路径的组合作身份，不引入无据的启动时间
// 字段可选是因为 CIM 查询在权限不足时会返回空列
export interface WindowsInstallResourceLockProcess {
  pid: number;
  commandLine?: string;
  executablePath?: string;
}

export interface WindowsUpdateProcessCleanupResult<TTerminationResult> {
  initialLockProcesses: WindowsInstallResourceLockProcess[];
  terminationPids: number[];
  terminationResults: TTerminationResult[];
  remainingLockProcesses: WindowsInstallResourceLockProcess[];
  errors: string[];
}

// WindowsUpdateProcessCleanupOptions 把扫描、终止、延时全部注入，本模块不直接触碰系统状态，所以时序可回放
// lockReleaseGraceMs 由调用方给定，生产值与测试值不共享同一常量
// 泛型让终止结果原样透传，main 侧无需再解析一次
interface WindowsUpdateProcessCleanupOptions<TTerminationResult> {
  resourceLockMarkers: readonly string[];
  lockReleaseGraceMs: number;
  scan: (
    markers: readonly string[],
  ) => Promise<WindowsInstallResourceLockProcess[]>;
  terminate: (pids: number[]) => Promise<TTerminationResult[]>;
  delay: (ms: number) => Promise<void>;
}

// 统一成 stage 前缀加原文，避免各 catch 各写一套格式
// 非 Error 抛出物走 String 兜底，格式化本身不能再抛一次
function stringifyCleanupError(stage: string, error: unknown): string {
  return `${stage}: ${error instanceof Error ? error.message : String(error)}`;
}

// runWindowsUpdateProcessCleanup 把扫描、过滤、终止、等待、复扫合并成单次事务，中途异常不回滚
// 每一步失败只追加 errors，函数始终返回完整的结果四元组
// 调用方据 remainingLockProcesses 判断是否二次清理，本函数不自行重试
export async function runWindowsUpdateProcessCleanup<TTerminationResult>(
  options: WindowsUpdateProcessCleanupOptions<TTerminationResult>,
): Promise<WindowsUpdateProcessCleanupResult<TTerminationResult>> {
  const errors: string[] = [];
  let initialLockProcesses: WindowsInstallResourceLockProcess[] = [];
  try {
    // 扫描结果只是候选，真正的持锁判定交给 isWindowsProcessReferencingResourceMarkers
    // 扫描放在 try 内，异常降级为空集后继续走后续流程
    const scannedProcesses = await options.scan(options.resourceLockMarkers);
    // PID 会在退出屏障与专项清理之间被 Windows 复用，历史 Host/Agent PID
    // 不能作为进程身份。即使扫描实现异常返回了额外行，也只保留清理时刻仍引用随包
    // 资源的进程，避免 taskkill /T /F 终止无关进程树。
    initialLockProcesses = scannedProcesses.filter((processInfo) =>
      isWindowsProcessReferencingResourceMarkers(
        processInfo,
        options.resourceLockMarkers,
      ),
    );
  } catch (error) {
    // 辅助扫描不可用不能阻断升级，错误返回给 main 记录后继续 NSIS 交接。
    errors.push(stringifyCleanupError("initial-scan", error));
  }

  // 先按 pid 去重再校验，避免同一进程因多行输出被重复终止
  // Number.isSafeInteger 与 pid > 0 一起过滤掉 0、负数与非安全整数，否则整批参数的容错比单条更差
  // 去重顺序保留首次出现，便于把结果与 initialLockProcesses 对齐
  const terminationPids = [
    ...new Set(
      initialLockProcesses
        .map((processInfo) => processInfo.pid)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ),
  ];
  if (terminationPids.length === 0) {
    return {
      initialLockProcesses,
      terminationPids,
      terminationResults: [],
      remainingLockProcesses: [],
      errors,
    };
  }

  // 初值保持空数组，终止失败时调用方看到的是未尝试而不是旧值
  // 结果长度与 terminationPids 一一对应，由 terminate 实现负责保证
  let terminationResults: TTerminationResult[] = [];
  try {
    terminationResults = await options.terminate(terminationPids);
  } catch (error) {
    errors.push(stringifyCleanupError("terminate", error));
  }
  try {
    await options.delay(options.lockReleaseGraceMs);
  } catch (error) {
    errors.push(stringifyCleanupError("release-grace", error));
  }

  // remainingLockProcesses 只在复扫成功时覆盖，异常时保持空集以免伪造已清空
  // 空集有两种含义，调用方需结合 errors 的 rescan 条目区分
  let remainingLockProcesses: WindowsInstallResourceLockProcess[] = [];
  try {
    remainingLockProcesses = await options.scan(options.resourceLockMarkers);
  } catch (error) {
    errors.push(stringifyCleanupError("rescan", error));
  }

  return {
    initialLockProcesses,
    terminationPids,
    terminationResults,
    remainingLockProcesses,
    errors,
  };
}

interface WindowsPackagedResourceSnapshotEntry {
  dir: string;
  path: string;
  exists: boolean;
  entries: string[];
}

// writable 与 error 互斥：只有不可写时才带原因字符串
// exists 单独保留，用于区分不存在与存在但只读
interface WindowsPackagedResourceWritableProbe {
  dir: string;
  path: string;
  exists: boolean;
  writable: boolean;
  error?: string;
}

interface WindowsProcessRow {
  ProcessId?: number;
  CommandLine?: string | null;
  ExecutablePath?: string | null;
}

function normalizeForWindowsCommandLineMatch(value: string): string {
  return value.trim().replaceAll("/", "\\").toLowerCase();
}

// 标记固定为随包资源目录，不接受外部传入的任意路径
// 顺序与 WINDOWS_PACKAGED_RESOURCE_DIRS 一致，诊断输出可直接对照
export function resolveWindowsPackagedResourceLockMarkers(
  resourcesPath: string,
): string[] {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => join(resourcesPath, dir));
}

// listResourceEntries 只取前 20 个条目，诊断用途不需要完整目录清单
// 目录不可读时返回空数组，不让快照因权限问题整体失败
function listResourceEntries(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .slice(0, 20)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

function removeResourceProbeSentinel(path: string) {
  try {
    rmSync(path, { force: true });
  } catch {
    // sentinel 只是安装前诊断探针，清理失败不应覆盖原始可写性错误。
  }
}

// 只读快照，不写入也不创建，可用于安装前后对比
// 目录不存在时 exists 为假且条目为空，不接受半真半假的状态
export function snapshotWindowsPackagedResources(
  resourcesPath: string,
): WindowsPackagedResourceSnapshotEntry[] {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => {
    const path = join(resourcesPath, dir);
    const exists = existsSync(path);
    return {
      dir,
      path,
      exists,
      entries: exists ? listResourceEntries(path) : [],
    };
  });
}

// probeWindowsPackagedResourceWritable 的判定标准是写入、改名、改回三步都成功，单步成功不足以证明可写
// 两次改名覆盖能建新文件但不能替换已有文件的权限组合
// 目录不存在时必须直接判不可写，不能顺手创建它
export function probeWindowsPackagedResourceWritable(
  resourcesPath: string,
): WindowsPackagedResourceWritableProbe[] {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => {
    const path = join(resourcesPath, dir);
    const exists = existsSync(path);
    if (!exists) {
      return { dir, path, exists, writable: false };
    }
    const sentinelPath = join(
      path,
      `.zcode_resource_probe_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    );
    const renamedSentinelPath = `${sentinelPath}.renamed`;
    try {
      writeFileSync(sentinelPath, "probe\n", "utf8");
      // renameSync 两步往返验证的是目录项替换权限，而不只是内容写入权限
      // 同名覆盖在 Windows 上会失败，因此必须走两步改名
      renameSync(sentinelPath, renamedSentinelPath);
      renameSync(renamedSentinelPath, sentinelPath);
      removeResourceProbeSentinel(sentinelPath);
      removeResourceProbeSentinel(renamedSentinelPath);
      return { dir, path, exists, writable: true };
    } catch (error) {
      removeResourceProbeSentinel(sentinelPath);
      removeResourceProbeSentinel(renamedSentinelPath);
      return {
        dir,
        path,
        exists,
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

// 标记与命令行都过 normalizeForWindowsCommandLineMatch 再匹配，抹平大小写与分隔符差异
// 归一化后为空时必须判定为不匹配任何进程，防止空串恒真
export function isWindowsProcessReferencingResourceMarkers(
  processInfo: WindowsInstallResourceLockProcess,
  markers: readonly string[],
): boolean {
  const normalizedMarkers = markers
    .map((marker) => normalizeForWindowsCommandLineMatch(marker))
    .filter(Boolean);
  if (normalizedMarkers.length === 0) {
    return false;
  }

  const searchable = normalizeForWindowsCommandLineMatch(
    `${processInfo.commandLine ?? ""} ${processInfo.executablePath ?? ""}`,
  );
  return normalizedMarkers.some((marker) => searchable.includes(marker));
}

// parseWindowsProcessRows 必须吃下单结果对象与多结果数组两种形状，只按数组解析会丢掉仅一个匹配进程的结果
// 空输出直接返回空数组，不把解析异常抛给调用方
function parseWindowsProcessRows(raw: string): WindowsProcessRow[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as WindowsProcessRow | WindowsProcessRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function toPowerShellSingleQuotedString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// 脚本内排除自身 PID，避免清理者把自己当成持锁者
// 标记先转成单引号字面量再拼数组，路径里的引号不会破坏语法
// 比较前统一反斜杠与小写，与 TypeScript 侧归一化保持一致
function buildWindowsProcessQueryScript(markers: readonly string[]): string {
  const markerLiterals = markers.map(toPowerShellSingleQuotedString).join(", ");
  return `
$ErrorActionPreference = 'SilentlyContinue'
$markers = @(${markerLiterals})
$ownPid = $PID
$rows = Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine, ExecutablePath
$matches = @()
foreach ($row in $rows) {
  if ($row.ProcessId -eq $ownPid) { continue }
  $haystack = (([string]$row.CommandLine) + ' ' + ([string]$row.ExecutablePath)).Replace('/', '\\').ToLowerInvariant()
  foreach ($marker in $markers) {
    $needle = ([string]$marker).Replace('/', '\\').ToLowerInvariant()
    if ($needle.Length -gt 0 -and $haystack.Contains($needle)) {
      $matches += $row
      break
    }
  }
}
$matches | ConvertTo-Json -Compress
`;
}

// findWindowsProcessesReferencingResourceMarkers 只负责拼参数、超时与解析，进程枚举由 PowerShell 完成
// 隐藏窗口与 2MB 输出上限在此固定；超时只由 queryTimeoutMs 参数覆盖，默认值即 3s
// 返回前过滤非法 pid，下游可以信任每个元素都能直接用于 taskkill
export async function findWindowsProcessesReferencingResourceMarkers(
  markers: readonly string[],
  queryTimeoutMs = WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
): Promise<WindowsInstallResourceLockProcess[]> {
  // 空标记集直接短路，不启动 PowerShell 子进程
  // markers.length === 0 的捷径同时保护空数组拼接出的无意义脚本
  if (markers.length === 0) {
    return [];
  }

  // 非零退出与超时都由 execFile 拒绝，异常上抛当作扫描失败处理
  // maxBuffer 留 2MB，足够容纳上千进程的命令行 JSON
  // shell 关闭并走参数数组，标记内容不会被解释成命令
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      buildWindowsProcessQueryScript(markers),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: queryTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  return parseWindowsProcessRows(stdout)
    .map((row) => ({
      pid: row.ProcessId ?? 0,
      commandLine: row.CommandLine ?? undefined,
      executablePath: row.ExecutablePath ?? undefined,
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}
