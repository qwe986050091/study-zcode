// 文件头 · packages/desktop/src/main/exportLogs.ts —— 诊断日志的收集 / 脱敏 / 归档
// 职责边界：把 ~/.zcode 下的日志类文件按白名单收集、流式脱敏后打包成 zip 或目录。
// 不负责：日志产生（由各模块 logger 负责）、上传、保留期清理；也不负责凭据本身的读写。
// 安全前提：导出包会被用户转发给第三方，因此「默认拒绝」优先于「事后过滤」。
//
// 不变式（INV-01 … INV-24）：断言 ｜ 守住它的位置 ｜ 改错后的故障
// INV-01 断言 文本日志必须脱敏后落包，禁止原样拷贝 ｜ 位置 sanitizeTextLogFileToDestination ｜ 改错 token/apiKey 随反馈包外泄
// INV-02 断言 只有无法识别编码的二进制才 copyFile ｜ 位置 copyLogArchiveFilesToDirectory 的 !textEncodingInfo 分支 ｜ 改错 文本被原样复制，脱敏整体失效
// INV-03 断言 敏感键名 = 子串族 + 白名单例外 ｜ 位置 isSensitiveKeyName 先判 NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX ｜ 改错 误脱 max_tokens/author，排障上下文丢失
// INV-04 断言 白名单不得放宽到任意 *_tokens ｜ 位置 NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX 的显式枚举 ｜ 改错 access_tokens/session_tokens 被原样导出
// INV-05 断言 连接串按值形态脱敏并保留 scheme/host ｜ 位置 CONNECTION_STRING_CREDENTIALS_REGEX + redactConnectionStringCredentials ｜ 改错 自定义键名的数据库口令泄露
// INV-06 断言 凭据文件名在收集阶段就跳过 ｜ 位置 isExcludedRelativePath 的 isSensitiveCredentialArchivePath ｜ 改错 credentials.json 本体进包，内容脱敏无法覆盖非日志结构
// INV-07 断言 运行目录只按文件名白名单单层收集 ｜ 位置 collectLogArchiveFilesByName + isCuaHelperDiagnosticFileName ｜ 改错 .tokens broker 凭据被递归带入
// INV-08 断言 保留窗口只作用于 logs/ 与 .zcode/cli/log/ ｜ 位置 shouldApplyLogExportRetention ｜ 改错 settings 等久未修改的排障配置被过滤掉
// INV-09 断言 lookbackDays<=0 表示不过滤 ｜ 位置 filterRecentLogArchiveFiles 早返回 ｜ 改错 排查旧问题时历史日志全被裁掉
// INV-10 断言 stat 失败的文件不进入归档 ｜ 位置 filterRecentLogArchiveFiles 的 fileStats?.isFile() ｜ 改错 把已被删除的路径写进包，导出中途失败
// INV-11 断言 递归必须用 realpath 去重防环 ｜ 位置 walkLogArchiveDirectory 的 visitedDirs ｜ 改错 软链成环导致无限递归/重复打包
// INV-12 断言 单个目录 readdir 失败只跳过该目录 ｜ 位置 walkLogArchiveDirectory 的 catch 返回 null ｜ 改错 一次 EACCES 让整个导出失败
// INV-13 断言 软链按目标类型分别处理目录/文件 ｜ 位置 dirent.isSymbolicLink 分支的 targetStats ｜ 改错 软链被当普通文件写入，产出空文件或 EISDIR
// INV-14 断言 收集结果按 archivePath 排序 ｜ 位置 collectLogArchiveFiles / createLogArchiveArtifacts 的 sort ｜ 改错 包内顺序随 readdir 抖动，diff 无法比较
// INV-15 断言 archivePath 一律使用正斜杠 ｜ 位置 normalizeArchivePath（所有判定入口） ｜ 改错 Windows 反斜杠使排除规则全部失效
// INV-16 断言 压缩前必须先落到 staging 目录 ｜ 位置 writeLogArchiveZip 的 writeLogArchiveDirectory ｜ 改错 yazl 遭遇轮转中的文件抛未监听 error，进程崩溃
// INV-17 断言 staging 目录必须在 finally 删除 ｜ 位置 writeLogArchiveZip 的 finally rm ｜ 改错 每次导出遗留一份与日志包等大的临时副本
// INV-18 断言 zip 失败必须回退目录导出 ｜ 位置 exportLogs 的 catch zipError ｜ 改错 杀软/磁盘策略打断后用户拿不到任何日志
// INV-19 断言 单个文件不可读时跳过并继续 ｜ 位置 copyLogArchiveFilesToDirectory 的 skippedFiles ｜ 改错 一个 ENOENT 让整包导出失败
// INV-20 断言 复制失败后必须复核源是否仍可读 ｜ 位置 copyLogArchiveFilesToDirectory 的 sourceReadableAfterFailure ｜ 改错 真实 IO 错误被当成「文件已轮转」吞掉
// INV-21 断言 BOM 必须原样写回目标文件 ｜ 位置 sanitizeTextLogFileToDestination 的 bomBytes 写入 ｜ 改错 UTF-16 文件失去 BOM，下游识别成乱码
// INV-22 断言 编码识别顺序固定为 BOM → UTF-8 → 三种 UTF-16 探针 → 兜底 ｜ 位置 detectTextFileEncoding ｜ 改错 纯 CJK 无 BOM 文本被判成二进制而漏脱敏
// INV-23 断言 对外导出入口永不抛错 ｜ 位置 exportLogs 的外层 try/catch ｜ 改错 IPC 调用方收到 rejection，UI 无错误文案
// INV-24 断言 about.txt 必须随目录导出 ｜ 位置 writeLogArchiveDirectory ｜ 改错 反馈包缺少版本/构建信息，无法定位环境
/* eslint-disable max-lines -- 导出日志流程涉及文件收集、脱敏与打包，集中维护便于排查与一致性 */
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";

import {
  createFeedbackDiagnosticArchive,
  getAppConfigDir,
  getExportLogDir as getDefaultExportLogDir,
  getExportLogStageDir as getDefaultExportLogStageDir,
  getFeedbackLogArchiveDir as getDefaultFeedbackLogArchiveDir,
} from "@zcode/services/node";
import { createAboutSnapshot, formatAboutDetail, readBuildMetadata } from "./about.js";
import { logger } from "./logger.js";

// [契约] 应用主数据目录的唯一取值点，导出源目录默认就是它。
// [失败路径] 直接在别处拼 ~/.zcode/v2，会绕过测试注入点，导致测试读真实用户目录。
// [契约] 该函数只读不建目录，目录是否存在由 collect 阶段容忍。
function getZCodeDataDir() {
  return getAppConfigDir();
}

function getZCodeCliDir() {
  return join(homedir(), ".zcode", "cli");
}

function getZCodeCliLogDir() {
  return join(getZCodeCliDir(), "log");
}

/**
 * Computer Use Helper 的运行目录。macOS 上 Helper 由 LaunchServices 启动，stderr 被系统丢弃，
 * 所以它把生命周期与后台输入诊断 tee 到 `<socket>.exit.log`（见 zcode-cua
 * helperExitLogPathFor）。同目录下还有 `.tokens` broker 凭据，收集时必须按文件名白名单。
 */
// [契约] Computer Use Helper 的 @迁移后运行目录，同目录混放 .exit.log 与 .tokens。
// [失败路径] 递归收集该目录会把 broker 凭据打进用户会转发的日志包。
// [契约] 因此只能配合 isCuaHelperDiagnosticFileName 做单层白名单收集。
// [契约] 路径固定为 ~/.zcode/computer-use/run，不随平台变化。
function getCuaHelperRunDir() {
  return join(homedir(), ".zcode", "computer-use", "run");
}

function isCuaHelperDiagnosticFileName(fileName: string): boolean {
  return fileName.endsWith(".exit.log");
}

interface LogArchiveFileEntry {
  absolutePath: string;
  archivePath: string;
}

interface LogArchiveArtifacts {
  files: LogArchiveFileEntry[];
  aboutContent: string;
}

interface CreateLogArchiveArtifactsOptions {
  now?: () => Date;
  lookbackDays?: number;
}

interface LogArchiveSkippedFileEntry {
  absolutePath: string;
  archivePath: string;
  error: string;
}

interface ExportLogsDependencies {
  now?: () => Date;
  getZCodeDataDir?: () => string;
  getExportLogStageDir?: () => string;
  getExportLogDir?: () => string;
  createLogArchiveArtifacts?: (
    sourceDir: string,
    options?: CreateLogArchiveArtifactsOptions,
  ) => Promise<LogArchiveArtifacts>;
  writeLogArchiveZip?: (
    outputPath: string,
    artifacts: LogArchiveArtifacts,
    options?: WriteLogArchiveZipOptions,
  ) => Promise<void>;
  writeLogArchiveDirectory?: (outputPath: string, artifacts: LogArchiveArtifacts) => Promise<void>;
  showItemInFolder?: (path: string) => Promise<void> | void;
}

interface WriteLogArchiveZipOptions {
  stageRootDir?: string;
}

interface CreateFeedbackLogArchiveFromExportLogsOptions {
  now?: () => Date;
  outputRootDir?: string;
  stageRootDir?: string;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

// [契约] 导出目录名使用本地时间 yyyyMMdd-HHmmss，不含分隔符冒号（Windows 非法）。
// [失败路径] 用 toISOString 会产生冒号，Windows 上 mkdtemp 直接 EINVAL。
// [契约] 所有段都 padStart(2)，保证名字可按字典序排序。
// [契约] 注入 now 仅为测试可预期，生产调用不传参。
function formatTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// [契约] 所有排除规则、去重、排序都必须先经过本函数。
// [失败路径] 漏调用会让 Windows 的 `Library\Caches` 绕过 `Library/Caches` 前缀判断。
// [契约] 只替换反斜杠，不做 resolve：archivePath 是相对路径，不能吃掉 `..`。
// [契约] normalizeArchivePath 保持纯函数，不做大小写归一化：大小写由各判定自行决定（如 isExcludedDirectoryArchivePath 先 toLowerCase）。
function normalizeArchivePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegExp(path: string): string {
  return path.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

// [契约] globPatternToRegExp 只支持 `*` 通配，转义其余正则元字符后锚定整串。
// [失败路径] 不锚定会让 `dev` 规则误伤 `dev-tools` 这类前缀相同的目录。
// [契约] 先把反斜杠归一化成正斜杠，保证 Windows 模式也能匹配。
// [权衡] 不引入完整 glob 语义（`**`/`?`），保持规则可审计。
function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeArchivePath(pattern);
  return new RegExp(`^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`);
}

/**
 * Glob patterns to exclude from the exported log archive.
 * Each pattern is relative to the source directory being archived.
 */
// [契约] ZIP_EXCLUDE_PATTERNS 默认空数组：当前所有排除都由 isExcludedRelativePath 里的显式判定函数完成。
// [失败路径] 往这里加宽泛模式（如 `*.log`）会误删排障所需的核心日志。
// [契约] 该常量在模块加载时被编译成正则，运行期不可变。
// [契约] 新增规则优先写成独立判定函数（如 isDocshotArchivePath），便于单测与注释理由。
const ZIP_EXCLUDE_PATTERNS: string[] = [];

// [契约] ZIP_EXCLUDE_REGEXES 模块级预编译，避免每个文件都重新构造正则。
// [失败路径] 改成在 isExcludedRelativePath 内 map 会让 O(n) 次遍历变成 O(n*m) 次编译。
// [契约] 与 ZIP_EXCLUDE_PATTERNS 必须同源，不能各自维护一份。
const ZIP_EXCLUDE_REGEXES = ZIP_EXCLUDE_PATTERNS.map(globPatternToRegExp);
const RETIRED_ACP_RUNTIME_ARCHIVE_PATHS = [
  "acp-auth",
  "acp-config",
  "acp-stream-diagnostics",
  "acp-traffic-proxy",
] as const;
const HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS = ["dev"] as const;
const DOCSHOT_ARCHIVE_PATH_PREFIXES = ["docshot-backup-"] as const;
const DOCSHOT_ARCHIVE_PATHS = ["docshot-assets"] as const;
const NON_LOG_STATE_ARCHIVE_PATHS = [
  "agent-config",
  "certs",
  "repo-snapshots",
  "repo-wiki",
  "sessions",
  "session-bindings",
  "checkpoints",
] as const;
const SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES = new Set(["credentials.json", ".credentials.json"]);
const EXCLUDED_ARCHIVE_DIRECTORY_NAMES = new Set(["debug"]);
const DEFAULT_LOG_EXPORT_LOOKBACK_DAYS = 3;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const REDACTED_PLACEHOLDER = "***REDACTED***";
// 敏感键名“族”：只要键名里包含这些子串就视为敏感（兜底通配），
// 从而覆盖自定义命名（如 db_password、my_secret、x-conn-string 等）而不必逐个精确列举。
// 注意：`token` / `auth` 等是宽松子串，配合下方白名单排除误伤项（如 input_tokens、author）。
const SENSITIVE_KEY_SUBSTRING_PATTERN = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "credential",
  "api(?:_|-)?key",
  "access(?:_|-)?key",
  "private(?:_|-)?key",
  "auth",
  "cookie",
  "dsn",
  "conn(?:ection)?(?:_|-)?str(?:ing)?",
  "database(?:_|-)?url",
  "db(?:_|-)?url",
].join("|");
const SENSITIVE_KEY_NAME_REGEX = new RegExp(`(?:${SENSITIVE_KEY_SUBSTRING_PATTERN})`, "i");
// 白名单：命中敏感子串但实际并非密钥的常见键名，避免脱掉排障需要的上下文。
// 不能把任意 "*_tokens" 都白名单化，否则 access_tokens/session_tokens 会被原样导出；
// max_tokens/budget_tokens 是模型输出与思考预算，不是凭据，需保留用于判断 provider 请求是否撞限；
// 因此这里只放行明确的 LLM token 计数/预算字段，以及 author/authority 这类含 "auth" 的普通词。
const NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX =
  /^(?:public(?:_|-)?key|keywords?|tokenizer|token(?:_|-)?count|(?:prompt|completion|total|input|output|cached|reasoning|max|budget|accepted(?:_|-)?prediction|rejected(?:_|-)?prediction|tool(?:_|-)?use(?:_|-)?prompt)(?:_|-)?tokens|author(?:s|ity|ed)?)$/i;

// [契约] 先判白名单再判黑名单：白名单是硬豁免，顺序不可交换。
// [失败路径] 反序会让 max_tokens 先命中 token 子串，被误脱成占位符。
// [契约] 黑名单是子串匹配（不锚定），能覆盖 db_password 这类自定义命名。
// [失败路径] 改成整词匹配会漏掉 mySecretKey、x-conn-string 等变体。
// [契约] 大小写不敏感，HTTP 头与 JSON 键共用同一规则。
function isSensitiveKeyName(keyName: string): boolean {
  if (NON_SENSITIVE_KEY_NAME_ALLOWLIST_REGEX.test(keyName)) {
    return false;
  }
  return SENSITIVE_KEY_NAME_REGEX.test(keyName);
}

// 以下正则先宽松捕获“键名 + 值”，再由 isSensitiveKeyName 决定是否脱敏，
// 这样键名黑名单不再是硬编码列表，而是“敏感族 + 通配 + 白名单例外”。
// [契约] 该正则只负责「切出键名 + 值」，是否脱敏交给 isSensitiveKeyName。
// [失败路径] 在正则里硬编码键名黑名单，会与白名单例外形成两套互相打架的规则。
// [契约] JSON_STYLE_SENSITIVE_VALUE_REGEX 的值分支覆盖双引号/单引号/裸值三种形态，裸值截到分隔符为止。
// [失败路径] 裸值分支若不排除 `}`/`]`，会把后续 JSON 结构一起吞掉。
// [契约] 使用全局标志，replace 会遍历整段文本。
const JSON_STYLE_SENSITIVE_VALUE_REGEX =
  /(["'])([A-Za-z0-9_.-]+)\1(\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\r\n}\]]+)/g;
const ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)([^\r\n#]+)/g;
const HEADER_STYLE_SENSITIVE_VALUE_REGEX =
  /((?:^|\n)[ \t]*)([A-Za-z0-9-]+)([ \t]*:[ \t]*)([^\r\n]+)/g;
const BEARER_TOKEN_REGEX = /(Bearer\s+)([^\s"']+)/g;
const QUERY_TOKEN_REGEX =
  /([?&](?:key|api(?:_|-)?key|access(?:_|-)?token|refresh(?:_|-)?token|token|password|passwd|pwd|secret|client(?:_|-)?secret|auth(?:_|-)?token|session(?:_|-)?token)=)([^&#\s]+)/gi;
// 按“值形态”脱敏：连接串 scheme://user:pass@host 里的凭据部分，
// 不依赖键名即可覆盖 postgres/mysql/mongodb/redis/amqp 等数据库连接信息。保留 scheme 与 host 便于排障。
// 用户名段允许为空以覆盖 redis://:password@host；口令段贪婪匹配到最后一个 @（host 段不含 @），
// 这样口令里含裸 @（如 P@ssw0rd）也能整段脱敏，不残留片段。
// [契约] 按值形态识别 `scheme://user:pass@host`，不依赖键名。
// [失败路径] 只靠键名脱敏会漏掉写在 message 正文里的 DSN。
// [契约] scheme 与 host 保留，便于判断连的是哪个数据库而不泄露口令。
// [失败路径] 连 host 一起脱敏会让排障无法确认目标实例。
// [契约] 口令段贪婪到最后一个 @，覆盖 P@ssw0rd 这类含 @ 的口令。
// [失败路径] 非贪婪会在第一个 @ 截断，残留口令尾部。
const CONNECTION_STRING_CREDENTIALS_REGEX =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s]*):([^/\s]+)@(?=[^@/\s])/gi;
const TEXT_DETECTION_SAMPLE_BYTES = 64 * 1024;
const EMPTY_BOM = Buffer.alloc(0);

type SupportedTextEncoding = "utf-8" | "utf-16le" | "utf-16be";

interface TextFileEncodingInfo {
  encoding: SupportedTextEncoding;
  bomLength: number;
  bomBytes: Buffer;
}

interface TextDecodingScore {
  preferredCharRatio: number;
  invalidCharRatio: number;
}

// [契约] redactValue 保留值前后空白与原有引号风格，只替换引号内的核心内容。
// [失败路径] 直接整体替换会破坏 YAML/JSON 的对齐与缩进结构。
// [契约] redactValue 只在引号成对时保留原引号，单边引号按裸值处理。
// [失败路径] 单边引号也补引号会产出语法非法的行。
// [契约] 占位符固定 ***REDACTED***，便于用 grep 验证脱敏是否生效。
function redactValue(rawValue: string): string {
  const leadingSpaces = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingSpaces = rawValue.match(/\s*$/)?.[0] ?? "";
  const core = rawValue.trim();
  const quote =
    core.startsWith('"') && core.endsWith('"')
      ? '"'
      : core.startsWith("'") && core.endsWith("'")
        ? "'"
        : "";
  const redacted = quote ? `${quote}${REDACTED_PLACEHOLDER}${quote}` : REDACTED_PLACEHOLDER;
  return `${leadingSpaces}${redacted}${trailingSpaces}`;
}

// [契约] Bearer 头保留 `Bearer ` 前缀，只替换凭据本体。
// [失败路径] 整体替换会让日志无法区分「本就没有凭据」与「凭据已脱敏」。
// [契约] 其它 HTTP 头一律整体替换为占位符。
// [契约] 前缀匹配大小写不敏感，但输出统一为 `Bearer`。
function redactHeaderValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+.+$/i, `Bearer ${REDACTED_PLACEHOLDER}`);
  }
  return REDACTED_PLACEHOLDER;
}

// [契约] 必须作为脱敏链的第一步：先处理 DSN，再处理键值对。
// [失败路径] 放在后面会让键值规则先改写片段，打破 DSN 的完整形态。
// [契约] redactConnectionStringCredentials 把用户名与口令都替换为同一个 REDACTED_PLACEHOLDER，不区分是否存在用户名。
// [契约] replace 只替换 CONNECTION_STRING_CREDENTIALS_REGEX 的匹配段，其余文本原样保留（含换行与缩进）。
function redactConnectionStringCredentials(rawContent: string): string {
  // postgres://admin:secret@host → postgres://***REDACTED***:***REDACTED***@host
  return rawContent.replace(
    CONNECTION_STRING_CREDENTIALS_REGEX,
    (_match, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}:${REDACTED_PLACEHOLDER}@`,
  );
}

// [契约] 脱敏顺序固定：DSN → JSON 风格 → 赋值风格 → 头风格 → Bearer → 查询串。
// [失败路径] 调换顺序会让前一步改写后的文本不再匹配后一步的模式。
// [契约] sanitizeSensitiveLogContent 的六步都是纯字符串替换，不改行数与文件结构。
// [失败路径] 若顺手压缩空行或裁剪超长行，排障上下文会错位。
// [契约] 该函数无 IO、无状态，因此只能由 createSensitiveContentSanitizerTransform 在流式 transform 中逐块调用。
// [契约] 新增规则必须追加到链尾或明确理由插入，不能删既有步骤。
function sanitizeSensitiveLogContent(rawContent: string): string {
  // 导出日志不能按文件原样拷贝：会把用户配置和协议日志里的 token/apiKey 一并带出。
  // 线上排障需要“保留文件结构和上下文”，但不应该泄露密钥本体；
  // 这里在导出阶段统一对常见敏感值做脱敏，字段和日志行仍完整保留，支持继续定位问题。
  // 键名不再是硬编码黑名单，而是“敏感键名族 + 子串通配 + 白名单例外”（isSensitiveKeyName），
  // 并叠加按值形态的连接串脱敏，以覆盖数据库连接串等自定义命名的敏感信息。
  return redactConnectionStringCredentials(rawContent)
    .replace(
      JSON_STYLE_SENSITIVE_VALUE_REGEX,
      (match, quote: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${quote}${keyName}${quote}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      ASSIGNMENT_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, keyName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(keyName)
          ? `${prefix}${keyName}${separator}${redactValue(rawValue)}`
          : match,
    )
    .replace(
      HEADER_STYLE_SENSITIVE_VALUE_REGEX,
      (match, prefix: string, headerName: string, separator: string, rawValue: string) =>
        isSensitiveKeyName(headerName)
          ? `${prefix}${headerName}${separator}${redactHeaderValue(rawValue)}`
          : match,
    )
    .replace(BEARER_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`)
    .replace(QUERY_TOKEN_REGEX, `$1${REDACTED_PLACEHOLDER}`);
}

// [契约] detectUtf16EncodingByNullPattern 通过奇偶字节的零字节比例推断字节序，阈值 likelyUtf16Ratio 0.3 与 noiseThreshold 0.1 不可随意调。
// [失败路径] 降低 noiseThreshold 会把带少量控制字符的正常文本误判成 UTF-16。
// [契约] 样本小于 4 字节直接返回 null，交给上层兜底。
// [契约] 两个方向都不满足时返回 null，表示「无法确定」而不是「不是文本」。
// [权衡] 纯 CJK UTF-16 零字节很少，因此还需要 ASCII 对与解码评分两条兜底。
function detectUtf16EncodingByNullPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let evenByteCount = 0;
  let oddByteCount = 0;
  let evenNullCount = 0;
  let oddNullCount = 0;

  for (let index = 0; index < sample.length; index += 1) {
    if (index % 2 === 0) {
      evenByteCount += 1;
      if (sample[index] === 0) {
        evenNullCount += 1;
      }
      continue;
    }

    oddByteCount += 1;
    if (sample[index] === 0) {
      oddNullCount += 1;
    }
  }

  const evenNullRatio = evenNullCount / Math.max(evenByteCount, 1);
  const oddNullRatio = oddNullCount / Math.max(oddByteCount, 1);
  const likelyUtf16Ratio = 0.3;
  const noiseThreshold = 0.1;
  if (oddNullRatio >= likelyUtf16Ratio && evenNullRatio <= noiseThreshold) {
    return "utf-16le";
  }
  if (evenNullRatio >= likelyUtf16Ratio && oddNullRatio <= noiseThreshold) {
    return "utf-16be";
  }
  return null;
}

function isLikelyAsciiTextByte(byteValue: number): boolean {
  return (
    byteValue === 0x09 ||
    byteValue === 0x0a ||
    byteValue === 0x0d ||
    (byteValue >= 0x20 && byteValue <= 0x7e)
  );
}

// [契约] isPreferredTextCodePoint 只把 ASCII 可见字符、CJK、假名、谚文与全角标点视为「像文本」，因此控制字符不会抬高 preferred 比例。
// [失败路径] 放宽到全部 BMP 会让二进制样本叠出很高的命中率。
// [契约] 控制字符（除 \t\n\r）不算 preferred，仍由调用方计为 invalid。
// [契约] isPreferredTextCodePoint 的区间划分来自实际日志语料，调整需同步更新 scoreDecodedTextForEncodingDetection 的评分阈值。
// [权衡] 不引入 ICU 等重依赖，用有限区间换取可预测性。
function isPreferredTextCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20) {
    return true;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
    return true;
  }
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
    return true;
  }
  if (codePoint >= 0x3000 && codePoint <= 0x303f) {
    return true;
  }
  if (codePoint >= 0xff00 && codePoint <= 0xffef) {
    return true;
  }
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
    return true;
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return true;
  }
  return false;
}

// [契约] scoreDecodedTextForEncodingDetection 输出 preferredCharRatio 与 invalidCharRatio 两个比例，分母是码点总数（至少 1，否则除零）。
// [失败路径] 用字节数当分母会让 UTF-16 评分系统性偏低。
// [契约] scoreDecodedTextForEncodingDetection 把 U+FFFD、NUL、DEL、代理项与多数控制字符都计为 invalid，因此解码结果里一旦残留它们就会说明字节序判错了。
// [失败路径] 漏掉 U+FFFD 会让错误字节序解码结果仍显得「可读」。
// [契约] 逐码点迭代（for...of）而不是逐 UTF-16 单元，避免代理对重复计数。
function scoreDecodedTextForEncodingDetection(decodedText: string): TextDecodingScore {
  let totalCodePointCount = 0;
  let preferredCodePointCount = 0;
  let invalidCodePointCount = 0;

  for (const character of decodedText) {
    totalCodePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      codePoint === 0xfffd ||
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      invalidCodePointCount += 1;
      continue;
    }
    if (isPreferredTextCodePoint(codePoint)) {
      preferredCodePointCount += 1;
    }
  }

  const denominator = Math.max(totalCodePointCount, 1);
  return {
    preferredCharRatio: preferredCodePointCount / denominator,
    invalidCharRatio: invalidCodePointCount / denominator,
  };
}

// [契约] 先把 normalizedSampleLength 截到偶数，避免尾部半字符污染两种解码结果。
// [失败路径] 不截断会让 LE/BE 各有一个 U+FFFD，评分对两者同时失真。
// [契约] 只有单侧合格时才直接判定；双侧合格时比较 preferred 比例差。
// [失败路径] 双侧合格时随便选一侧，会把 BE 文本按 LE 解密成乱码。
// [契约] 差距不足 0.08 时退化为比较 invalid 比例，仍相同则默认 LE。
// [契约] minimumPreferredCharRatio 0.55 / maximumInvalidCharRatio 0.2 / minimumPreferredCharRatioGap 0.08 是经验值，改动需回归混合语料样本。
function detectUtf16EncodingByDecodedTextScore(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  const normalizedSampleLength = sample.length - (sample.length % 2);
  if (normalizedSampleLength < 4) {
    return null;
  }
  const normalizedSample = sample.subarray(0, normalizedSampleLength);

  const utf16LeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16le").decode(normalizedSample),
  );
  const utf16BeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16be").decode(normalizedSample),
  );

  const minimumPreferredCharRatio = 0.55;
  const maximumInvalidCharRatio = 0.2;
  const minimumPreferredCharRatioGap = 0.08;

  const utf16LeQualified =
    utf16LeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16LeScore.invalidCharRatio <= maximumInvalidCharRatio;
  const utf16BeQualified =
    utf16BeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16BeScore.invalidCharRatio <= maximumInvalidCharRatio;

  if (utf16LeQualified && !utf16BeQualified) {
    return "utf-16le";
  }
  if (utf16BeQualified && !utf16LeQualified) {
    return "utf-16be";
  }
  if (!utf16LeQualified && !utf16BeQualified) {
    return null;
  }

  const preferredRatioGap = Math.abs(
    utf16LeScore.preferredCharRatio - utf16BeScore.preferredCharRatio,
  );
  if (preferredRatioGap >= minimumPreferredCharRatioGap) {
    return utf16LeScore.preferredCharRatio > utf16BeScore.preferredCharRatio
      ? "utf-16le"
      : "utf-16be";
  }

  return utf16LeScore.invalidCharRatio <= utf16BeScore.invalidCharRatio ? "utf-16le" : "utf-16be";
}

// [契约] fatal:true 才是严格的合法性判断；默认解码会用 U+FFFD 掩盖非法字节。
// [失败路径] 去掉 fatal 会让任意二进制都被判为合法 UTF-8，脱敏链直接跳过。
// [契约] isValidUtf8Sample 只判 TEXT_DETECTION_SAMPLE_BYTES 采样窗口，不代表整文件合法。
// [失败路径] 把采样结论当整文件结论，会在超长文件的后续块里出现乱码。
function isValidUtf8Sample(sample: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

// [契约] 只统计「连续 ASCII-零字节 run」，run 长度 >= 3 才计分。
// [失败路径] 逐对统计会把 CJK 里偶发的零低字节累加成假信号。
// [契约] 反向 run 出现时必须结算对方的 run 分数并清零。
// [失败路径] 忘记结算会让长 run 的分数在文本后半段才被计入，甚至丢失。
// [契约] 主导比 1.5 且最低分 6，避免极短英文 token 就翻转字节序判断。
// [契约] 循环条件 index+1 < length，天然跳过尾部奇数字节。
function detectUtf16EncodingByAsciiPairPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let utf16LeRunLength = 0;
  let utf16BeRunLength = 0;
  let utf16LeAsciiRunScore = 0;
  let utf16BeAsciiRunScore = 0;

  // CJK 文本里会出现“单个码元低字节刚好是 0”的情况（如 U+4E00），
  // 直接统计 `0x00 + ASCII` 配对会把这些离散噪声误判成另一端字节序。
  // 这里改为统计“连续 ASCII-零字节 run”，只把成段英文 token（api key/header）作为有效信号。
  const flushRunScore = (runLength: number): number => (runLength >= 3 ? runLength : 0);

  for (let index = 0; index + 1 < sample.length; index += 2) {
    const leftByte = sample[index] ?? 0;
    const rightByte = sample[index + 1] ?? 0;

    if (rightByte === 0 && isLikelyAsciiTextByte(leftByte)) {
      utf16LeRunLength += 1;
      utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
      utf16BeRunLength = 0;
      continue;
    }
    if (leftByte === 0 && isLikelyAsciiTextByte(rightByte)) {
      utf16BeRunLength += 1;
      utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
      utf16LeRunLength = 0;
      continue;
    }

    utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
    utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
    utf16LeRunLength = 0;
    utf16BeRunLength = 0;
  }

  utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
  utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);

  const minimumAsciiRunScore = 6;
  const dominanceRatio = 1.5;
  if (
    utf16LeAsciiRunScore >= minimumAsciiRunScore &&
    utf16LeAsciiRunScore >= utf16BeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16le";
  }
  if (
    utf16BeAsciiRunScore >= minimumAsciiRunScore &&
    utf16BeAsciiRunScore >= utf16LeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16be";
  }
  return null;
}

// [契约] 空文件按无 BOM 的 UTF-8 处理，而不是判成二进制。
// [失败路径] 返回 null 会让空文件走 copyFile，虽无害但语义错误。
// [契约] BOM 优先级最高：utf-8 / utf-16le / utf-16be 三种都要识别并回传长度。
// [失败路径] 漏掉 UTF-16BE BOM 会让文件按 LE 解码成乱码。
// [契约] 无 NUL 且 UTF-8 合法即判 UTF-8，这是最快的常见路径。
// [契约] 三种 UTF-16 探针有固定顺序：ASCII 对 → 零字节比例 → 解码评分。
function detectTextFileEncoding(sample: Buffer): TextFileEncodingInfo | null {
  if (sample.length === 0) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return {
      encoding: "utf-8",
      bomLength: 3,
      bomBytes: Buffer.from([0xef, 0xbb, 0xbf]),
    };
  }

  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return {
      encoding: "utf-16le",
      bomLength: 2,
      bomBytes: Buffer.from([0xff, 0xfe]),
    };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return {
      encoding: "utf-16be",
      bomLength: 2,
      bomBytes: Buffer.from([0xfe, 0xff]),
    };
  }

  if (!sample.includes(0) && isValidUtf8Sample(sample)) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  // CJK 占比高的 UTF-16 无 BOM 文本，空字节比例可能很低，
  // 仅靠 null-ratio 会被误判为“非文本”并走原样复制，导致敏感字段漏脱敏。
  // 这里增加“ASCII-零字节对”兜底检测（例如 `OPENAI_API_KEY=\r\n`），覆盖真实日志中的混合文本场景。
  const utf16Encoding =
    detectUtf16EncodingByAsciiPairPattern(sample) ??
    detectUtf16EncodingByNullPattern(sample) ??
    detectUtf16EncodingByDecodedTextScore(sample);
  if (!utf16Encoding) {
    // 无 BOM 且不含空字节的 UTF-16 文本，在纯 CJK 内容里经常出现。
    // 这类样本 UTF-8 fatal decode 会失败；此时按 UTF-8 处理会产生乱码并漏掉敏感字段匹配。
    // 兜底策略：UTF-8 合法则按 UTF-8，非法且无法识别成 UTF-16 时才视为二进制。
    if (isValidUtf8Sample(sample)) {
      return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
    }
    return null;
  }
  return { encoding: utf16Encoding, bomLength: 0, bomBytes: EMPTY_BOM };
}

// [契约] 只读前 64KB 采样，不把整文件读进内存。
// [失败路径] 改成 readFile 会在 GB 级日志上直接 OOM。
// [契约] 必须用 try/finally 关闭句柄，避免 Windows 上文件被占用无法轮转。
// [失败路径] 漏 close 会让后续 copyFile 报 EBUSY。
// [契约] 返回 subarray 而不是拷贝，调用方不得修改缓冲区。
async function readFileSample(
  absolutePath: string,
  sampleBytes = TEXT_DETECTION_SAMPLE_BYTES,
): Promise<Buffer> {
  const fileHandle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(sampleBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, sampleBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fileHandle.close();
  }
}

// [契约] Node 没有 utf16be 编码器，因此用 utf16le 编码后 swap16 得到 BE。
// [失败路径] 直接 Buffer.from(text, "utf16be") 会抛 Unknown encoding。
// [契约] swap16 会原地修改，必须作用在本次新建的 Buffer 上。
// [失败路径] 对共享 Buffer 调用 swap16 会破坏其它数据。
// [契约] 输出的字节序必须与 detectTextFileEncoding 判定一致，否则乱码。
function encodeTextWithEncoding(text: string, encoding: SupportedTextEncoding): Buffer {
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf-8");
  }
  if (encoding === "utf-16le") {
    return Buffer.from(text, "utf16le");
  }
  const encodedBuffer = Buffer.from(text, "utf16le");
  encodedBuffer.swap16();
  return encodedBuffer;
}

// [契约] 只按完整行切分：最后一个 \n 之前为 complete，之后为 pending。
// [失败路径] 不切行会让一个 token 被拆到两个 chunk，脱敏正则匹配不到。
// [契约] 无 \n 时退回找 \r，但要求 \r 不在末尾（否则可能是 CRLF 的前半）。
// [失败路径] 把末尾 \r 当作完整行会输出一个孤立 \r，破坏 CRLF 配对。
// [契约] 都不满足时整块留待下一次拼接，保证不丢数据。
function splitByCompleteLine(content: string): {
  completeChunk: string;
  pendingChunk: string;
} {
  const lastLineFeedIndex = content.lastIndexOf("\n");
  if (lastLineFeedIndex >= 0) {
    return {
      completeChunk: content.slice(0, lastLineFeedIndex + 1),
      pendingChunk: content.slice(lastLineFeedIndex + 1),
    };
  }

  const lastCarriageReturnIndex = content.lastIndexOf("\r");
  if (lastCarriageReturnIndex >= 0 && lastCarriageReturnIndex < content.length - 1) {
    return {
      completeChunk: content.slice(0, lastCarriageReturnIndex + 1),
      pendingChunk: content.slice(lastCarriageReturnIndex + 1),
    };
  }

  return { completeChunk: "", pendingChunk: content };
}

// [契约] decoder 必须用 stream:true 跨块保持状态，避免多字节字符被截断。
// [失败路径] 每个 chunk 新建 decoder 会让跨块的 CJK 字符变成 U+FFFD。
// [契约] pendingChunk 只保留最后一个不完整行，其余立即脱敏输出。
// [失败路径] 不保留 pending 会让跨块的敏感键值对漏脱敏。
// [契约] flush 时必须 decoder.decode() 收尾并处理剩余 pending。
// [失败路径] 漏 flush 会丢掉文件最后一行（通常正是报错行）。
function createSensitiveContentSanitizerTransform(encoding: SupportedTextEncoding): Transform {
  const decoder = new TextDecoder(encoding);
  let pendingChunk = "";

  return new Transform({
    transform(chunk, _chunkEncoding, callback) {
      try {
        const rawChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const decodedChunk = decoder.decode(rawChunk, { stream: true });
        const mergedChunk = `${pendingChunk}${decodedChunk}`;
        const { completeChunk, pendingChunk: nextPendingChunk } = splitByCompleteLine(mergedChunk);
        pendingChunk = nextPendingChunk;

        if (completeChunk.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(completeChunk);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        const remainingContent = `${pendingChunk}${decoder.decode()}`;
        if (remainingContent.length === 0) {
          callback();
          return;
        }
        const sanitizedChunk = sanitizeSensitiveLogContent(remainingContent);
        callback(null, encodeTextWithEncoding(sanitizedChunk, encoding));
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

// [契约] 从 bomLength 开始读，跳过原 BOM，再由写端重新写入 bomBytes。
// [失败路径] 不跳过 BOM 会让 BOM 字节进入 decoder，产生一个 U+FEFF 字符。
// [契约] 使用 pipeline 串联读写与转换，任一端错误会自动销毁其余流。
// [失败路径] 手写 on(data) 会让错误路径泄漏文件句柄。
// [契约] 该函数不负责 mkdir，调用方已保证目标目录存在。
// [契约] sanitizeTextLogFileToDestination 的输出编码取自 encodingInfo.encoding，与原文件一致，保持日志可被原工具打开。
async function sanitizeTextLogFileToDestination(
  sourcePath: string,
  destinationPath: string,
  encodingInfo: TextFileEncodingInfo,
): Promise<void> {
  const readStream = createReadStream(sourcePath, {
    start: encodingInfo.bomLength,
  });
  const writeStream = createWriteStream(destinationPath);

  if (encodingInfo.bomLength > 0) {
    writeStream.write(encodingInfo.bomBytes);
  }

  await pipeline(
    readStream,
    createSensitiveContentSanitizerTransform(encodingInfo.encoding),
    writeStream,
  );
}

function isExcludedCachePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return (
    normalizedRelativePath === "Library/Caches" ||
    normalizedRelativePath.startsWith("Library/Caches/")
  );
}

function isRetiredAcpRuntimePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return RETIRED_ACP_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isHighVolumeRuntimeArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return HIGH_VOLUME_RUNTIME_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

function isDocshotArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  const firstSegment = normalizedRelativePath.split("/")[0] ?? "";
  if (DOCSHOT_ARCHIVE_PATHS.includes(firstSegment as (typeof DOCSHOT_ARCHIVE_PATHS)[number])) {
    return true;
  }
  return DOCSHOT_ARCHIVE_PATH_PREFIXES.some((prefix) => firstSegment.startsWith(prefix));
}

function isNonLogStateArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  return NON_LOG_STATE_ARCHIVE_PATHS.some(
    (archivePath) =>
      normalizedRelativePath === archivePath ||
      normalizedRelativePath.startsWith(`${archivePath}/`),
  );
}

// [契约] 只按文件名判定，不依赖目录，覆盖任意提供商的同名凭据文件。
// [失败路径] 只排除固定路径会漏掉第三方 CLI 写在别处的 credentials.json。
// [契约] 文件名统一小写后比较，兼容 .Credentials.json 等变体。
// [契约] isSensitiveCredentialArchivePath 在收集阶段生效，早于任何内容脱敏。
function isSensitiveCredentialArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  const fileName = normalizedRelativePath.split("/").at(-1) ?? "";
  return SENSITIVE_CREDENTIAL_ARCHIVE_FILE_NAMES.has(fileName);
}

// [契约] 任一路径段命中 debug 即整棵子树排除。
// [失败路径] 只判断首段会漏掉 `foo/debug/` 这类深层轨迹目录。
// [契约] isExcludedDirectoryArchivePath 把路径与目录名都先小写，兼容大小写不敏感文件系统。
// [契约] 用 Set 常量承载名单，新增目录只改常量。
function isExcludedDirectoryArchivePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath).toLowerCase();
  return normalizedRelativePath
    .split("/")
    .some((segment) => EXCLUDED_ARCHIVE_DIRECTORY_NAMES.has(segment));
}

// [契约] 这是收集阶段的唯一总闸，判定顺序从「安全」到「体积」。
// [失败路径] 任何一个判定被删，都会导致对应类别文件进包。
// [契约] 所有子判定都接收已归一化的路径，避免重复 replace。
// [失败路径] 传入原始路径会让 Windows 反斜杠绕过目录段匹配。
// [契约] 最后才回落到 ZIP_EXCLUDE_REGEXES，保持配置规则的兜底位置。
// [契约] 新规则必须给出「为什么不能靠内容脱敏」的理由注释。
function isExcludedRelativePath(relativePath: string): boolean {
  const normalizedRelativePath = normalizeArchivePath(relativePath);
  // 完整日志导出过去只做内容脱敏，仍会把 credentials.json 文件本身放进包。
  // 凭据存储文件不是排障日志，且不同提供商可能复用同名文件；因此在收集清单阶段按文件名跳过。
  if (isSensitiveCredentialArchivePath(normalizedRelativePath)) {
    return true;
  }
  // debug 目录通常是模型/运行时高频轨迹，不是用户要交付的日志包材料。
  // 过去显式收集 ~/.zcode/cli/debug 会把这类上下文带进手动导出和反馈完整日志，这里按目录段统一跳过。
  if (isExcludedDirectoryArchivePath(normalizedRelativePath)) {
    return true;
  }
  if (isNonLogStateArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ~/.zcode/v2/dev 保存 stdio-traffic 等高频协议流，真实机器上会累计到 GB 级。
  // 远超反馈附件的大小上限，不应随诊断包带出。
  if (isHighVolumeRuntimeArchivePath(normalizedRelativePath)) {
    return true;
  }
  // docshot 历史备份和素材目录体积可达 GB 级，
  // 且不属于用户反馈所需的诊断日志。
  if (isDocshotArchivePath(normalizedRelativePath)) {
    return true;
  }
  // ACP runtime 目录已退役，老用户数据里仍可能残留数百 MB 抓包和旧鉴权文件。
  // 当前运行态配置已经迁到 agent-config；继续导出这些旧目录会让导出长时间无反馈，还可能带出旧代理证书私钥。
  if (isRetiredAcpRuntimePath(normalizedRelativePath)) {
    return true;
  }
  // Library/Caches 是运行时缓存，不是排障所需日志；导出它只会放大日志包。
  if (isExcludedCachePath(normalizedRelativePath)) {
    return true;
  }

  return ZIP_EXCLUDE_REGEXES.some((pattern) => pattern.test(normalizedRelativePath));
}

// [契约] 只对 logs/ 与 .zcode/cli/log/ 两类真正的时间序列日志做保留期过滤。
// [失败路径] 把 settings/config 也纳入过滤，会让久未修改但仍生效的配置丢失。
// [契约] 前缀判断带 `/`，避免 `logs-old` 这类目录被误命中。
// [契约] shouldApplyLogExportRetention 保持纯函数，不读文件系统。
function shouldApplyLogExportRetention(archivePath: string): boolean {
  const normalizedArchivePath = normalizeArchivePath(archivePath);
  if (
    normalizedArchivePath.startsWith("logs/") ||
    normalizedArchivePath.startsWith(".zcode/cli/log/")
  ) {
    return true;
  }

  return false;
}

// [契约] lookbackDays<=0 或未配置时原样返回，表示不启用保留期。
// [失败路径] 把 0 当「保留 0 天」会把所有日志过滤光。
// [契约] cutoff 以注入的 now() 为基准，测试可固定时间。
// [契约] stat 失败（文件已删/无权限）时不加入结果，也不报错。
// [失败路径] 把 stat 失败的文件强行保留，会让后续复制必然失败。
// [契约] 非日志类文件无条件保留，不参与 mtime 比较。
async function filterRecentLogArchiveFiles(
  files: LogArchiveFileEntry[],
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveFileEntry[]> {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOG_EXPORT_LOOKBACK_DAYS;
  if (lookbackDays <= 0) {
    return files;
  }

  const now = options.now ?? (() => new Date());
  const cutoffMs = now().getTime() - lookbackDays * MILLISECONDS_PER_DAY;
  const recentFiles: LogArchiveFileEntry[] = [];

  for (const file of files) {
    if (!shouldApplyLogExportRetention(file.archivePath)) {
      recentFiles.push(file);
      continue;
    }

    const fileStats = await stat(file.absolutePath).catch(() => null);
    // 导出日志过去按目录全量打包，长时间运行后旧 diagnostics 会把日志包放大到数百 MB。
    // 这里仅对“可由时间窗口复现现场”的日志类文件按 mtime 保留近 3 天；
    // settings 等排障配置不参与过滤，避免久未修改但仍影响当前行为的配置丢失。
    if (fileStats?.isFile() && fileStats.mtimeMs >= cutoffMs) {
      recentFiles.push(file);
    }
  }

  return recentFiles;
}

function createAboutContent(): string {
  const snapshot = createAboutSnapshot({ buildMetadata: readBuildMetadata() });
  return formatAboutDetail(snapshot);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSkippedLogArchiveDirectory(
  absolutePath: string,
  archivePath: string,
  error: unknown,
): void {
  logger.warn("[export-logs] 日志目录不可读，已在导出时自动跳过", {
    absolutePath,
    archivePath,
    error: formatErrorMessage(error),
  });
}

// [契约] 先 realpath 再查 visitedDirs，防止软链成环导致无限递归。
// [失败路径] 用绝对路径去重，同目录经不同软链到达时会重复打包。
// [契约] realpath 失败时回落 absoluteDir，保证仍能遍历。
// [契约] readdir 失败只 warn 并返回 null，不中断整体导出。
// [契约] 目录项排序后再遍历，保证收集顺序稳定可复现。
// [契约] 软链先 stat 目标：目录递归、文件收集、其它类型忽略。
async function walkLogArchiveDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const resolvedDir = await realpath(absoluteDir).catch(() => absoluteDir);
  if (visitedDirs.has(resolvedDir)) {
    return;
  }
  visitedDirs.add(resolvedDir);

  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch((error: unknown) => {
    // 用户目录下的日志来源可能包含被系统或第三方 CLI 限制权限的子目录。
    // 单个目录 scandir 失败时跳过该目录，避免一次 EACCES 把整个日志包导出中断。
    logSkippedLogArchiveDirectory(absoluteDir, relativeDir, error);
    return null;
  });
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));

  for (const dirent of dirents) {
    const archivePath = relativeDir ? posix.join(relativeDir, dirent.name) : dirent.name;
    if (isExcludedRelativePath(archivePath)) {
      continue;
    }

    const absolutePath = join(absoluteDir, dirent.name);
    if (dirent.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (dirent.isFile()) {
      files.push({ absolutePath, archivePath });
      continue;
    }

    if (!dirent.isSymbolicLink()) {
      continue;
    }

    const targetStats = await stat(absolutePath).catch(() => null);
    if (!targetStats) {
      continue;
    }

    // 日志目录里存在 provider 共享资源的软链入口。
    // 这里按目标类型处理并配合 realpath 去重，避免递归跟随时把同一份内容重复打进包，甚至形成循环遍历。
    if (targetStats.isDirectory()) {
      await walkLogArchiveDirectory(absolutePath, archivePath, visitedDirs, files);
      continue;
    }

    if (targetStats.isFile()) {
      files.push({ absolutePath, archivePath });
    }
  }
}

// [契约] 入口先 stat 确认是目录，不存在或非目录时静默返回。
// [失败路径] 不检查就让 walk 抛 ENOENT，使可选目录缺失变成致命错误。
// [契约] 只把递归下放给 walk，本函数不做排除判断。
// [契约] visitedDirs 跨多次调用共享，用于跨源目录去重。
async function collectLogArchiveFilesFromDirectory(
  absoluteDir: string,
  relativeDir: string,
  visitedDirs: Set<string>,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const directoryStats = await stat(absoluteDir).catch(() => null);
  if (!directoryStats?.isDirectory()) {
    return;
  }

  await walkLogArchiveDirectory(absoluteDir, relativeDir, visitedDirs, files);
}

/**
 * 按文件名白名单收集单层目录，不递归。用于运行目录这类"诊断文件与凭据同放"的场景：
 * 递归收集会把 .tokens 之类的机密带进用户会转发出去的日志包，而 EXCLUDED 名单是
 * 事后补救、天然滞后。白名单则默认拒绝——目录里以后多出什么都不会跟着漏出去。
 */
// [契约] collectLogArchiveFilesByName 单层、不递归：这是「诊断文件与凭据同放」场景的安全边界。
// [失败路径] 改成递归会立刻把 .tokens 之类机密带进日志包。
// [契约] 白名单默认拒绝：目录里新增任何文件都不会自动进包。
// [失败路径] 改成黑名单（排除已知机密）会随新文件类型持续泄漏。
// [契约] readdir 失败静默返回：运行目录可能因平台差异不存在。
// [契约] 仍逐个走 collectLogArchiveFile，复用统一排除与 stat 校验。
async function collectLogArchiveFilesByName(
  absoluteDir: string,
  relativeDir: string,
  isCollectableFileName: (fileName: string) => boolean,
  files: LogArchiveFileEntry[],
): Promise<void> {
  const dirents = await readdir(absoluteDir, { withFileTypes: true }).catch(() => null);
  if (!dirents) {
    return;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));
  for (const dirent of dirents) {
    if (!dirent.isFile() || !isCollectableFileName(dirent.name)) {
      continue;
    }
    await collectLogArchiveFile(
      join(absoluteDir, dirent.name),
      posix.join(relativeDir, dirent.name),
      files,
    );
  }
}

// [契约] 单文件收集也必须过 isExcludedRelativePath，不能假设调用方已过滤。
// [失败路径] 白名单收集路径若跳过排除，会把同名的 credentials.json 收进来。
// [契约] stat 失败或非普通文件时静默跳过。
// [契约] 只 push 引用，不读取内容，避免收集阶段产生大 IO。
async function collectLogArchiveFile(
  absolutePath: string,
  archivePath: string,
  files: LogArchiveFileEntry[],
): Promise<void> {
  if (isExcludedRelativePath(archivePath)) {
    return;
  }
  const fileStats = await stat(absolutePath).catch(() => null);
  if (!fileStats?.isFile()) {
    return;
  }
  files.push({ absolutePath, archivePath });
}

// [契约] 导出单源目录的收集能力，供 writeLogArchiveZip 处理 staging 目录。
// [失败路径] staging 复用这个入口，能天然继承全部排除规则。
// [契约] 结果按 archivePath 排序，保证 zip 内条目顺序稳定。
// [契约] visitedDirs 每次新建，不复用跨调用状态。
export async function collectLogArchiveFiles(sourceDir: string): Promise<LogArchiveFileEntry[]> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();
  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);
  files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
  return files;
}

// [契约] createLogArchiveArtifacts 的五个来源固定：主数据目录、cli/log、cli/config.json、cli/rollout、cua run，因此漏掉任一项都会缺少对应现场。
// [失败路径] 漏掉 cli/log 会让 agent 启动/协议问题缺少最关键的日志。
// [契约] 每个来源的 archivePrefix 决定包内路径，必须与判定规则一致。
// [失败路径] 前缀写成 `log/` 会让 shouldApplyLogExportRetention 匹配不到。
// [契约] 所有来源共用同一 visitedDirs，避免软链交叉造成重复条目。
// [契约] 最后统一做保留期过滤与排序，再附上 about 内容。
export async function createLogArchiveArtifacts(
  sourceDir: string,
  options: CreateLogArchiveArtifactsOptions = {},
): Promise<LogArchiveArtifacts> {
  const files: LogArchiveFileEntry[] = [];
  const visitedDirs = new Set<string>();

  await collectLogArchiveFilesFromDirectory(sourceDir, "", visitedDirs, files);

  const zcodeCliLogDir = getZCodeCliLogDir();
  // GLM / zcode-cli 的运行日志写在 ~/.zcode/cli/log，不在应用主数据目录 ~/.zcode/v2 下。
  // 如果导出日志只扫描 v2，定位 agent CLI 启动、协议或崩溃问题时会缺少最关键的原生侧日志。
  await collectLogArchiveFilesFromDirectory(
    zcodeCliLogDir,
    posix.join(".zcode", "cli", "log"),
    visitedDirs,
    files,
  );

  const zcodeCliDir = getZCodeCliDir();
  // 排查 agent CLI 问题还需要它的运行配置与模型 IO 轨迹。
  // config.json 是当前生效配置；rollout 是 model-io 调用轨迹，
  // 二者都不在 ~/.zcode/cli/log 下，需要额外收集才能完整还原现场。
  // [缺陷 D-11-2] rollout 递归收集且无体积上限；writeLogArchiveZip 会先整份复制到 staging，大目录下磁盘峰值接近翻倍。
  await collectLogArchiveFile(
    join(zcodeCliDir, "config.json"),
    posix.join(".zcode", "cli", "config.json"),
    files,
  );
  await collectLogArchiveFilesFromDirectory(
    join(zcodeCliDir, "rollout"),
    posix.join(".zcode", "cli", "rollout"),
    visitedDirs,
    files,
  );

  // Computer Use Helper 的结构化诊断必须进日志包：否则反馈包里
  // grep "background keyboard begin rejected" 命中 0，
  // 因为 Helper 由 LaunchServices 启动、stderr 被系统丢弃，它把诊断 tee 到
  // ~/.zcode/computer-use/run/<socket>.exit.log，既不在 app data 也不在 ~/.zcode/cli 下。
  // 同目录下有 .tokens broker 凭据，因此按文件名白名单只收 *.exit.log，不递归该目录。
  await collectLogArchiveFilesByName(
    getCuaHelperRunDir(),
    posix.join(".zcode", "computer-use", "run"),
    isCuaHelperDiagnosticFileName,
    files,
  );

  const recentFiles = await filterRecentLogArchiveFiles(files, options);
  recentFiles.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  return {
    files: recentFiles,
    aboutContent: createAboutContent(),
  };
}

// [契约] 复制前先 mkdir 目标目录的父级，支持任意深度的 archivePath。
// [失败路径] 改为一次 mkdir 根目录会让深层路径写入失败。
// [契约] stat 与 access 的双重校验分别失败都记入 skippedFiles 并继续。
// [失败路径] 直接 copyFile 遇 EACCES 会让整包失败。
// [契约] 文本必须走流式脱敏，二进制才 copyFile；判定依据是 detectTextFileEncoding 能否识别出编码。
// [契约] catch 中复核源可读性：只有源已不可读才跳过，否则重新抛出。
async function copyLogArchiveFilesToDirectory(
  outputPath: string,
  files: LogArchiveFileEntry[],
): Promise<LogArchiveSkippedFileEntry[]> {
  const skippedFiles: LogArchiveSkippedFileEntry[] = [];

  for (const file of files) {
    const destinationPath = join(outputPath, ...file.archivePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true });

    const sourceStats = await stat(file.absolutePath).catch((error: unknown) => {
      skippedFiles.push({
        absolutePath: file.absolutePath,
        archivePath: file.archivePath,
        error: formatErrorMessage(error),
      });
      return null;
    });
    if (!sourceStats?.isFile()) {
      continue;
    }

    const sourceReadable = await access(file.absolutePath, constants.R_OK)
      .then(() => true)
      .catch((error: unknown) => {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        return false;
      });
    if (!sourceReadable) {
      continue;
    }

    try {
      // 这里改为“采样识别编码 + 流式脱敏”，避免全量 readFile 带来的大文件内存峰值。
      // 同时显式支持 UTF-16 文本（含 BOM/无 BOM 常见形态），防止被误判成二进制后原样泄露敏感字段。
      const sourceSample = await readFileSample(file.absolutePath);
      const textEncodingInfo = detectTextFileEncoding(sourceSample);
      if (!textEncodingInfo) {
        await copyFile(file.absolutePath, destinationPath);
      } else {
        await sanitizeTextLogFileToDestination(
          file.absolutePath,
          destinationPath,
          textEncodingInfo,
        );
      }
    } catch (error) {
      const sourceStatsAfterFailure = await stat(file.absolutePath).catch(() => null);
      const sourceReadableAfterFailure = sourceStatsAfterFailure?.isFile()
        ? await access(file.absolutePath, constants.R_OK)
            .then(() => true)
            .catch(() => false)
        : false;
      // telemetry/agent 日志文件可能在“扫描完待导出列表”之后被后台轮转、删除或改权限，
      // 软链目标也可能在这段窗口里失效。复制失败后再核一次源文件可读性；
      // 如果源头已经不可读，就把它当成坏文件跳过，避免单个 ENOENT/EACCES 让导出整体失败。
      if (!sourceReadableAfterFailure) {
        skippedFiles.push({
          absolutePath: file.absolutePath,
          archivePath: file.archivePath,
          error: formatErrorMessage(error),
        });
        continue;
      }
      throw error;
    }
  }

  return skippedFiles;
}

// [契约] 空数组时不打日志，避免每次正常导出都产生 warn 噪声。
// [失败路径] 无条件打 warn 会让真正需要关注的跳过项被淹没。
// [契约] logSkippedLogArchiveFiles 只打印 slice(0, 10) 的前 10 条，防止一次权限问题刷出成百上千行日志。
// [契约] LogArchiveSkippedFileEntry 只记录 absolutePath、archivePath 与错误消息，不写入文件内容。
function logSkippedLogArchiveFiles(skippedFiles: LogArchiveSkippedFileEntry[]): void {
  if (skippedFiles.length === 0) {
    return;
  }

  logger.warn("[export-logs] 检测到不可读日志文件，已在导出时自动跳过", {
    skippedCount: skippedFiles.length,
    skippedFiles: skippedFiles.slice(0, 10),
  });
}

// [契约] 必须先在 staging 目录落一份稳定副本，再从副本压缩。
// [失败路径] 直接 addFile 源文件会对轮转中的 telemetry 文件抛未监听 error。
// [契约] staging 根目录可注入，默认取服务层提供的 stage 目录。
// [契约] mkdtemp 生成唯一子目录，避免并发导出互相覆盖。
// [契约] zipFile 的 error 必须显式转给 outputStream，否则成为 unhandled。
// [契约] pipeline 必须在 zipFile.end() 之前建立，避免丢失尾部数据。
export async function writeLogArchiveZip(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
  options: WriteLogArchiveZipOptions = {},
): Promise<void> {
  const stageRootDir = options.stageRootDir ?? getDefaultExportLogStageDir();
  await mkdir(stageRootDir, { recursive: true });
  const stagingDir = await mkdtemp(join(stageRootDir, "stage-"));
  try {
    // yazl.addFile 内部会再次对源路径执行 fs.stat/createReadStream。
    // 对于软链目标或正在被轮转的 telemetry 文件，这一步仍然可能异步抛错并触发未监听的 error 事件。
    // 这里先把可读文件稳定复制到临时目录，再从临时目录压缩，保证 zip 阶段只面对我们自己控制的常规文件。
    await writeLogArchiveDirectory(stagingDir, artifacts);

    const zipFile = new ZipFile();
    const stageFiles = await collectLogArchiveFiles(stagingDir);
    const outputStream = createWriteStream(outputPath);
    zipFile.once("error", (error) => {
      outputStream.destroy(error instanceof Error ? error : new Error(String(error)));
    });

    for (const file of stageFiles) {
      zipFile.addFile(file.absolutePath, file.archivePath);
    }

    const writePromise = pipeline(zipFile.outputStream, outputStream);
    zipFile.end();
    await writePromise;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

// [契约] 目录导出与 zip 共用同一 artifacts，保证两种形态内容一致。
// [失败路径] 各自重新收集会让 zip 与目录的条目集合不同。
// [契约] 跳过的文件只在汇总处 warn 一次，避免逐文件刷屏。
// [契约] about.txt 最后写入，确保目录导出失败时不会留下「看起来完整」的包。
export async function writeLogArchiveDirectory(
  outputPath: string,
  artifacts: LogArchiveArtifacts,
): Promise<void> {
  await mkdir(outputPath, { recursive: true });
  const skippedFiles = await copyLogArchiveFilesToDirectory(outputPath, artifacts.files);
  logSkippedLogArchiveFiles(skippedFiles);

  await writeFile(join(outputPath, "about.txt"), artifacts.aboutContent, "utf-8");
}

// [契约] 反馈包只保留最小集合，且不含 about 以外的自定义文件。
// [失败路径] 复用完整导出会让反馈包过大，超出上传上限。
// [契约] cli-config 源带 contentPolicy 与 includeFileNames，由服务层做脱敏。
// [契约] cua 源用 exitLogsOnly 等价于本文件的文件名白名单。
// [契约] outputRootDir 默认取反馈目录，可注入用于测试。
export async function createFeedbackLogArchiveFromExportLogs(
  sourceDir: string,
  options: CreateFeedbackLogArchiveFromExportLogsOptions = {},
): Promise<{ path: string; size: number }> {
  return createFeedbackDiagnosticArchive({
    sources: [
      { directory: join(sourceDir, "logs"), archivePrefix: "logs" },
      { directory: getZCodeCliLogDir(), archivePrefix: ".zcode/cli/log" },
      {
        directory: getZCodeCliDir(),
        archivePrefix: ".zcode/cli",
        includeFileNames: ["config.json"],
        onlyCurrentDay: false,
        contentPolicy: "cli-config",
      },
      {
        directory: join(getZCodeCliDir(), "rollout"),
        archivePrefix: ".zcode/cli/rollout",
      },
      {
        directory: getCuaHelperRunDir(),
        archivePrefix: ".zcode/computer-use/run",
        exitLogsOnly: true,
      },
    ],
    outputRootDir: options.outputRootDir ?? getDefaultFeedbackLogArchiveDir(),
    now: options.now,
    onProgress: options.onProgress,
  });
}

// [契约] 该函数永不抛错：所有失败都转成 { success:false, error }。
// [失败路径] 让异常冒泡会让 IPC 调用方收到 rejection，UI 没有文案可显示。
// [契约] 所有依赖可注入，测试无需真实文件系统与 electron。
// [契约] 用 mkdtemp 建独立输出目录，避免同名导出互相覆盖。
// [契约] showItemInFolder 在 zip 成功后才调用，失败回退时再调一次目录；[缺陷 D-11-1] 它与导出同处一个 try，自身抛错会被当作导出失败处理。
// [契约] 日志同时写 info 与 error，便于从主进程日志定位失败阶段。
export async function exportLogs(
  dependencies: ExportLogsDependencies = {},
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const now = dependencies.now ?? (() => new Date());
    const getSourceDir = dependencies.getZCodeDataDir ?? getZCodeDataDir;
    const buildArtifacts = dependencies.createLogArchiveArtifacts ?? createLogArchiveArtifacts;
    const writeZip = dependencies.writeLogArchiveZip ?? writeLogArchiveZip;
    const writeDirectory = dependencies.writeLogArchiveDirectory ?? writeLogArchiveDirectory;
    const showItemInFolder =
      dependencies.showItemInFolder ??
      (async (path: string) => {
        const { shell } = await import("electron");
        shell.showItemInFolder(path);
      });
    const getStageRootDir = dependencies.getExportLogStageDir ?? getDefaultExportLogStageDir;
    const getOutputRootDir = dependencies.getExportLogDir ?? getDefaultExportLogDir;

    const sourceDir = getSourceDir();
    const timestamp = formatTimestamp(now());
    // [契约] zip 名与目录名共用同一基名，便于用户辨识同一次导出。
    // [失败路径] 两者不同名会让回退目录看起来像另一次导出。
    // [契约] 基名不含路径分隔符，可直接交给 join/mkdtemp 后缀。
    // [契约] 时间戳已由 formatTimestamp 处理 Windows 非法字符。
    const exportBaseName = `zcode-logs-${timestamp}`;
    const outputRootDir = getOutputRootDir();
    await mkdir(outputRootDir, { recursive: true });
    const outputDir = await mkdtemp(join(outputRootDir, `${exportBaseName}-`));
    const zipPath = join(outputDir, `${exportBaseName}.zip`);
    const directoryPath = join(outputDir, exportBaseName);

    logger.info("[export-logs] 开始打包日志", {
      source: sourceDir,
      zipDest: zipPath,
      directoryDest: directoryPath,
    });
    const artifacts = await buildArtifacts(sourceDir, { now });

    try {
      await writeZip(zipPath, artifacts, { stageRootDir: getStageRootDir() });
      await showItemInFolder(zipPath);

      logger.info("[export-logs] 日志导出完成", {
        path: zipPath,
        format: "zip",
      });
      return { success: true, path: zipPath };
    // [契约] zip 失败必须回退目录导出，而不是直接报错。
    // [失败路径] 杀软/磁盘策略打断 zip 时，用户仍需拿到可用的原始日志。
    // [契约] 回退前先删除可能残缺的 zip，避免用户误以为导出成功。
    // [契约] 目录导出再失败时抛出新错误，同时携带两条消息供用户判断。
    // [契约] 回退成功仍返回 success:true，但 path 指向目录。
    // [契约] 外层 catch 只处理「连目录都失败」及前置步骤异常。
    } catch (zipError) {
      const zipErrorMessage = zipError instanceof Error ? zipError.message : String(zipError);

      // Windows 的压缩能力不再依赖 PowerShell/.NET，但归档写入仍可能被杀软、磁盘策略等外部因素打断。
      // 这里回退为目录导出，保证用户至少能稳定拿到原始日志，而不是直接报错。
      logger.warn("[export-logs] zip 导出失败，回退到目录导出", {
        error: zipErrorMessage,
        zipPath,
        fallbackPath: directoryPath,
      });
      await rm(zipPath, { force: true }).catch(() => {});

      try {
        await writeDirectory(directoryPath, artifacts);
      } catch (directoryError) {
        const directoryErrorMessage =
          directoryError instanceof Error ? directoryError.message : String(directoryError);
        throw new Error(`zip 导出失败：${zipErrorMessage}；目录导出失败：${directoryErrorMessage}`);
      }

      await showItemInFolder(directoryPath);
      logger.info("[export-logs] 日志导出完成", {
        path: directoryPath,
        format: "directory",
      });
      return { success: true, path: directoryPath };
    }
  } catch (err) {
    const message = formatErrorMessage(err);
    logger.error("[export-logs] 日志导出失败", { error: message });
    return { success: false, error: message };
  }
}
