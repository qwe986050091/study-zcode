/* eslint-disable max-lines */
// 安全说明：签名锁定、进程启动与协议解析必须保留在同一审计边界，避免拆分后重新引入校验/执行间隙。
// 职责边界：本文件只负责 Windows 上 Chromium 系浏览器的 App-Bound 密钥读取编排——
// 从 userDataDir 的 “Local State” 必须取出 os_crypt.app_bound_encrypted_key，定位并锁定 zcode 导入 helper，
// 再把 APPB 之后的密文与 chromeExecutablePath 交给 helper，换回 32 字节密钥。
// 它不能解密 cookie、不能写回 Local State、不选 profile，也不处理 macOS Keychain 或旧版 DPAPI 路径。
// 对外只暴露一个读取函数，失败必须收敛为 WindowsChromeAppBoundImportError 的三个稳定码。
// 审计边界：签名校验、环境清洗、进程启动、协议解析必须留在同一文件内，拆分会重新引入校验与执行之间的间隙。
//
// INV 表（任一失守都意味着静默错解或信任绕过，重构前逐条对照）：
// INV-01 断言：只有前 4 字节为 ASCII 的 APPB 且总长大于 4 的载荷才可解密 —— 守住它的位置：readWindowsChromeAppBoundKey 中的前缀与长度判定 —— 改错故障：旧版 DPAPI 密文被当作 App-Bound 载荷送进 helper，返回长度不符的缓冲，cookie 静默解成乱码。
// INV-02 断言：送进 helper 的必须是剥掉 4 字节前缀后的 subarray(4) —— 守住它的位置：encryptedKey 的取值处 —— 改错故障：前缀字节混入密文，CNG 解密整体偏移 4 字节，错误码只会显示 decryption_failed。
// INV-03 断言：helper 必须 realpath 后仍位于受信根内且不是符号链接 —— 守住它的位置：verifyHelper 的 lstat 与 relative 越界判定 —— 改错故障：junction 或符号链接可把执行点指向任意目录，签名与哈希校验的全是替身文件。
// INV-04 断言：打包态要求 helper 与 app 的 Authenticode 签名均有效且 thumbprint 完全相同 —— 守住它的位置：verifyAuthenticodePair 的 SignerCertificate 比对 —— 改错故障：只校验“有签名”会让任何第三方签名者替换 helper 后仍然通过。
// INV-05 断言：版本回包必须正好五段且协议、版本、架构、appVersion、buildCommit 全匹配 —— 守住它的位置：verifyHelper 的 fields 判定 —— 改错故障：错配的 helper 能启动但拿不到密钥，最终表现成所有用户都解密失败。
// INV-06 断言：helper 哈希要在签名前、签名后、版本握手后、写入 stdin 前分别复核 —— 守住它的位置：hashHelperFile 的四处调用 —— 改错故障：只校验一次就留下“验完再替换”的竞态窗口。
// INV-07 断言：打包态禁止直接启动 helper，只能由已锁定的 PowerShell 运行同一文件实例 —— 守住它的位置：runLockedPackagedHelper 的调用分支 —— 改错故障：绕过句柄锁后，哈希校验与进程创建之间重新出现可替换间隙。
// INV-08 断言：子进程环境只有 12 个系统白名单变量且 PATHEXT 固定为 .EXE —— 守住它的位置：createSanitizedHelperEnvironment —— 改错故障：继承外部 PATHEXT 后，脚本扩展可能先于真 exe 被解析，握手静默返回空输出。
// INV-09 断言：stdout 累计超过 HELPER_MAX_OUTPUT_BYTES 必须杀掉进程 —— 守住它的位置：runHelperProcess 的 data 回调 —— 改错故障：被替换的 helper 可以无限输出，把 main 的内存与事件循环拖死。
// INV-10 断言：单次 helper 调用上限 HELPER_TIMEOUT_MS（90 秒）且超时必须 kill —— 守住它的位置：runHelperProcess 的 setTimeout —— 改错故障：helper 卡在等用户确认提权时，导入会永久挂住渲染层的等待。
// INV-11 断言：回包必须三段制表符分隔且首段等于 HELPER_PROTOCOL —— 守住它的位置：parseHelperResponse 的段数与首段判定 —— 改错故障：把 helper 的调试输出当协议行解析，会得到看似合法的假密钥。
// INV-12 断言：base64 解出的密钥必须正好 32 字节，否则先清零再报错 —— 守住它的位置：parseHelperResponse 的长度判定 —— 改错故障：截断密钥流入 cookie 解密，表现为部分 cookie 失败而非明确错误。
// INV-13 断言：日志只允许白名单 reason 与错误 name/code —— 守住它的位置：throwAppBoundDecryptionFailure 与两处 warn —— 改错故障：原始响应进日志后，密钥材料或用户路径会随崩溃报告外泄。
// INV-14 断言：appBoundKey 与 stdout 缓冲必须在所有出口清零 —— 守住它的位置：主流程 finally 与 runHelperProcess 的 close 回调 —— 改错故障：敏感缓冲长期驻留 main 堆，被后续 profile 复用或转储带走。
// INV-15 断言：已归类的 WindowsChromeAppBoundImportError 不得被二次包装 —— 守住它的位置：主流程 catch 的首个分支 —— 改错故障：elevation_cancelled 被吞成 decryption_failed，调用方无法区分用户取消与真失败。
//
// 阅读顺序：协议常量 → 错误收敛 → helper 定位 → 环境清洗 → 进程执行 → 签名校验 → 句柄锁定 → 版本握手 → 回包解析 → 主流程。
// 执行模型：全部必须在 main 进程内以 Promise 串行推进，没有全局可变状态，缓存只有单次调用内的 verifiedHelperHash。
// 平台前提：仅 win32 有意义，架构必须只接受 x64 与 arm64，其余在 getTargetKey 直接判失败。
// 协议形态：字段一律用制表符分隔，任一端改成空格或逗号都会让段数断言整体失效。
// 常量联动：HELPER_TIMEOUT_MS 与 HELPER_MAX_OUTPUT_BYTES 必须与 helper 侧同步，否则表现为随机解密失败。
// 日志红线：必须只允许错误 name/code 与白名单 reason，路径、密钥材料、base64 密文一律不得落盘。
// 改动前先跑相关单测：签名失败、版本错配、超时、输出超限、回包畸形五类场景都已有对应用例。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ZCODE_COMMIT, ZCODE_VERSION } from "@zcode/shared";
import {
  createEncodedPowerShellArgs,
  createWindowsPowerShellSecurityArgs,
} from "../../scripts/powershell-command.mjs";
import { isElectronAppPackaged } from "./desktopElectronApp.js";

// HELPER_VERSION_PROTOCOL 必须走 --version 通道，HELPER_VERSION 为 2 表示五段布局：协议、版本、架构、appVersion、buildCommit。
// [权衡] 版本号硬编码而不从 package.json 读：握手两侧要能独立演进，读包版本会让 fork 后的桌面端自证通过。
// [失败路径] 改协议时先升版本再动字段顺序，否则旧 helper 被归成 invalid_response，真正的升级缺口被日志吞掉。
//
const HELPER_PROTOCOL = "ZCODE_BROWSER_IMPORT_V1";
const HELPER_VERSION_PROTOCOL = "ZCODE_BROWSER_IMPORT_HELPER";
const HELPER_VERSION = "2";
const HELPER_TIMEOUT_MS = 90_000;
const HELPER_MAX_OUTPUT_BYTES = 128 * 1024;
const HELPER_FILENAME = "zcode-browser-import-helper.exe";
// [资源] 这是日志白名单而非错误码枚举，集合外的 reason 一律降级成 invalid_response，防止 helper 回传的原始字符串落盘。
// [契约] 新增 reason 需两侧同步：helper 负责产生，这里负责放行；只改一半会让最需要定位的失败变成未知原因。
// [权衡] 不建 reason 到错误码的映射表：多数 reason 对外都是同一个 chrome_cookie_app_bound_decryption_failed，多一层映射只会造出第二套真相。
//
const APP_BOUND_HELPER_FAILURE_REASONS = new Set([
  "helper_failed",
  "broker_initialization_failed",
  "controller_handshake_failed",
  "service_channel_failed",
  "elevation_failed",
  "timeout",
  "peer_verification_failed",
  "service_failed",
  "validation_failed",
  "unsupported_key",
  "cng_failed",
  "decryption_failed",
  "service_cleanup_failed",
]);
const TRUSTED_WINDOWS_POWERSHELL_ALIAS =
  "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export type WindowsChromeAppBoundImportErrorCode =
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed";

// [契约] 三个错误码是跨进程契约：渲染层据此决定静默放弃、提示重装还是提示解密失败，新增码必须同步所有消费方。
// [权衡] 用 class 而不是裸字符串错误，是为了让主流程 catch 能可靠区分已归类与未预期，避免二次包装。
//
export class WindowsChromeAppBoundImportError extends Error {
  constructor(readonly code: WindowsChromeAppBoundImportErrorCode) {
    super(code);
    this.name = "WindowsChromeAppBoundImportError";
  }
}

// [失败路径] 这是解密类失败的唯一收敛点，凡是回包结构正确但语义失败的路径都必须走这里。
// [权衡] 只记录白名单 reason 而不抛原始字符串：响应里可能含密钥材料或用户路径，异常消息会进崩溃报告。
// [并发] 无共享状态，可在任意调用栈深度抛出；主流程的 catch 会原样透传已归类的错误码。
//
function throwAppBoundDecryptionFailure(logger: BrowserDataLogger, reason: string): never {
  // helper 原本返回了稳定子错误码，但通用映射会丢失根因；这里只记录白名单值，禁止记录可能含密钥或路径的原始响应。
  logger.warn("[browser-data] Windows Chrome App-Bound helper 返回失败", {
    reason: APP_BOUND_HELPER_FAILURE_REASONS.has(reason) ? reason : "invalid_response",
  });
  throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
}

export type WindowsChromeAppBoundKeyReader = (options: {
  chromeExecutablePath: string;
  expectedAppVersion?: string;
  expectedBuildCommit?: string;
  logger: BrowserDataLogger;
  userDataDir: string;
}) => Promise<Buffer>;

interface HelperProcessResult {
  exitCode: number | null;
  stdout: string;
}

interface ReadAppBoundKeyOptions {
  appExecutablePath?: string;
  chromeExecutablePath: string;
  expectedAppVersion?: string;
  expectedBuildCommit?: string;
  helperPath?: string;
  isPackaged?: boolean;
  logger: BrowserDataLogger;
  processArch?: string;
  resourcesPath?: string;
  runHelper?: (
    executablePath: string,
    args: string[],
    input?: string,
    beforeInput?: () => Promise<void>,
  ) => Promise<HelperProcessResult>;
  userDataDir: string;
  trustedPowerShellPath?: string;
  verifySignature?: (
    helperPath: string,
    appExecutablePath: string,
  ) => Promise<boolean | string>;
}

function toSafeProcessError(error: unknown): { code?: string; name: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

// [契约] 目标键形如 win32-x64 或 win32-arm64，直接拼进 bundled-tools 的目录名，因此必须只认这两个值。
// [失败路径] 架构不匹配沿用 chrome_cookie_helper_verification_failed 而非新增码：拿不到 helper 对调用方就等于校验失败。
// [权衡] 默认参数取 process.arch 是为测试注入；生产不要传自算值，否则声明架构与实际 exe 架构会脱节。
//
function getTargetKey(processArch: string = process.arch): string {
  if (processArch !== "x64" && processArch !== "arm64") {
    throw new WindowsChromeAppBoundImportError("chrome_cookie_helper_verification_failed");
  }
  return `win32-${processArch}`;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// [契约] 显式 helperPath 优先并做 resolve，测试与定制安装走这条；打包态固定 resourcesPath 下的导入子目录，不读 cwd。
// [平台] 开发态依次尝试 cwd 下的 bundled-tools 与 packages/desktop/bundled-tools，两者都不存在时返回第一个候选而不是抛错。
// [失败路径] 回退到不存在的路径是刻意的：把文件缺失和路径越界都并进 verifyHelper 的同一个 catch，对外只暴露一种错误码。
// [资源] HELPER_FILENAME 只在这一处与打包配置绑定，改产物名必须同步打包脚本，否则运行时会静默落到 cwd 候选。
//
async function resolveHelperPath(options: ReadAppBoundKeyOptions): Promise<string> {
  if (options.helperPath) return resolve(options.helperPath);
  const targetKey = getTargetKey(options.processArch);
  if (options.isPackaged ?? isElectronAppPackaged()) {
    return join(options.resourcesPath ?? process.resourcesPath, "browser-import", HELPER_FILENAME);
  }

  // [平台] 两个候选分别对应仓库根启动与 packages/desktop 内启动，顺序不能颠倒，先命中的才是当前工作树产物。
  // [权衡] 只在开发态探测存在性，打包态必须用固定路径，避免把 cwd 变成可被外部控制的搜索路径。
  //
  const candidates = [
    join(process.cwd(), "bundled-tools", targetKey, "browser-import", HELPER_FILENAME),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-tools",
      targetKey,
      "browser-import",
      HELPER_FILENAME,
    ),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[0]!;
}

// [契约] 只透传 12 个系统必需变量，NODE_OPTIONS、PSModulePath 等可注入项一律丢弃，子进程不该继承父进程的调试旋钮。
// [平台] 白名单保留 PROGRAMFILES(X86) 与 SYSTEMDRIVE，是因为 32 位 PowerShell 与非 C 系统盘会用到，删掉会让部分环境静默拿到空输出。
// [权衡] PATHEXT 固定成 .EXE 而非继承：Windows PowerShell 按完整路径启动 .exe 时仍查 PATHEXT，继承外部值会让脚本扩展被优先解析。
// [失败路径] 变量值为空时不写入而不是写空串，空值在某些 Windows API 下等价于存在但无效，比缺失更难排查。
//
export function createSanitizedHelperEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // [契约] 白名单按名字逐个取值，顺序无关；新增变量前先确认 helper 与 PowerShell 真的需要，而不是顺手带上。
  //
  const allowed = [
    "COMSPEC",
    "LOCALAPPDATA",
    "PATH",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  // Windows PowerShell 即使按完整路径调用 .exe 也依赖 PATHEXT；省略时 helper 版本握手会静默返回空输出。
  // 固定只允许 .EXE，既满足受信 helper 启动，又不继承外部可注入的脚本扩展。
  const env: NodeJS.ProcessEnv = { PATHEXT: ".EXE" };
  for (const name of allowed) {
    const value = sourceEnv[name];
    if (value) env[name] = value;
  }
  return env;
}

// [资源] 三个 stdio 必须都显式指定：stdin 传请求，stdout 收协议回包，stderr 直接 ignore，避免 helper 的调试输出污染协议或撑爆父进程缓冲。
// [失败路径] 超时、超量、进程错误、写入请求异常四条路径都先 kill 再结算，并用 settled 标志保证 Promise 只结算一次。
// [并发] beforeInput 在写入请求前执行，给非打包路径留出最后一次哈希复核窗口；它抛错时必须 kill，否则子进程会一直等 stdin。
// [资源] stdout 累计到 HELPER_MAX_OUTPUT_BYTES 立即杀掉进程，防止被替换的 helper 无限输出撑死 main。
//
function runHelperProcess(
  executablePath: string,
  args: string[],
  input?: string,
  beforeInput?: () => Promise<void>,
): Promise<HelperProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executablePath, args, {
      env: createSanitizedHelperEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    // [资源] 定时器在 Promise 构造时立即启动，覆盖 spawn、握手与读取全过程，而不是只包住某一段。
    // [失败路径] 超时必须用 ETIMEDOUT 与固定文案，不携带命令行参数，避免把 helper 路径写进上层日志。
    //
    const timeout = setTimeout(() => {
      child.kill();
      finishReject(
        Object.assign(new Error("browser_import_helper_timeout"), { code: "ETIMEDOUT" }),
      );
    }, HELPER_TIMEOUT_MS);

    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const finishResolve = (result: HelperProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };

    child.once("error", finishReject);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      // [失败路径] 计数在 push 之前累加，超限直接 kill 并拒绝，不保留已收内容，避免半截协议被误判。
      //
      if (stdoutBytes > HELPER_MAX_OUTPUT_BYTES) {
        child.kill();
        finishReject(new Error("browser_import_helper_output_too_large"));
        return;
      }
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.once("close", (exitCode) => {
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      const stdout = stdoutBuffer.toString("utf8").trim();
      stdoutBuffer.fill(0);
      for (const chunk of stdoutChunks) chunk.fill(0);
      finishResolve({
        exitCode,
        stdout,
      });
    });
    void (async () => {
      try {
        await beforeInput?.();
        if (!settled) child.stdin.end(input);
      } catch (error) {
        child.kill();
        finishReject(error);
      }
    })();
  });
}

// [资源] 整文件必须读入做 sha256，读完立刻把字节缓冲清零，避免 helper 镜像内容长期驻留 main 堆。
// [权衡] 不做流式哈希：helper 体积可控，一次读取换实现简单，也避免流式期间文件被替换造成的自相矛盾读数。
//
async function hashHelperFile(helperPath: string): Promise<string> {
  const bytes = await readFile(helperPath);
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

// [契约] 用 Get-AuthenticodeSignature 分别校验 helper 与 app 可执行文件，要求两者 Status 均为 Valid 且 SignerCertificate.Thumbprint 完全相等。
// [平台] 信任根必须走 GLOBALROOT 形式的系统路径再 realpath，SYSTEMROOT 与 WINDIR 都能被父进程覆盖，不能当作校验器起点。
// [事务] 先用 FileShare.Read 打开 helper 并持有只读句柄，签名与哈希基于同一文件流，最后在 finally 释放。
// [失败路径] 脚本异常只会表现为非零退出或空 stdout，调用方仅在退出码为 0 且匹配 64 位小写十六进制时采信。
//
async function verifyAuthenticodePair(
  helperPath: string,
  appExecutablePath: string,
): Promise<string | false> {
  // SYSTEMROOT/WINDIR 都能被启动方覆盖，不能作为发布态签名校验器的信任根。
  // GLOBALROOT\\SystemRoot 由 Windows 内核解析到真实系统目录，再转成 CreateProcess 可执行的 DOS 路径。
  const powershellPath = await realpath(TRUSTED_WINDOWS_POWERSHELL_ALIAS);
  const script = [
    "$stream=[IO.File]::Open($zcodeArg0,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);",
    "try{",
    "$helper=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
    "$app=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg1;",
    "if($helper.Status -ne 'Valid' -or $app.Status -ne 'Valid'){throw 'invalid_signature'};",
    "if($null -eq $helper.SignerCertificate -or $null -eq $app.SignerCertificate){throw 'missing_signer'};",
    "if($helper.SignerCertificate.Thumbprint -ne $app.SignerCertificate.Thumbprint){throw 'signer_mismatch'};",
    "$sha=[Security.Cryptography.SHA256]::Create();",
    "try{$stream.Position=0;$hash=$sha.ComputeHash($stream);",
    "[Console]::Out.WriteLine(([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant())}",
    "finally{$sha.Dispose()}",
    "}finally{$stream.Dispose()}",
  ].join("");
  // Windows PowerShell 5.1 的 `-Command` 会拼接尾随 argv 而不会填充 `$args`，
  // 直接传路径会让签名校验拿到空路径并固定 fail closed。统一编码脚本和值，并从当前
  // powershell.exe 的 PSHOME 显式加载 Security 模块，兼容带空格路径和被污染的 PSModulePath。
  const result = await runHelperProcess(
    powershellPath,
    createWindowsPowerShellSecurityArgs(script, [helperPath, appExecutablePath]),
  );
  return result.exitCode === 0 && /^[0-9a-f]{64}$/.test(result.stdout) ? result.stdout : false;
}

// [事务] 核心是句柄锁：可信 PowerShell 在整个运行期持有 helper 的只读且禁止写入删除的句柄，版本握手与 broker 只能执行同一文件实例。
// [契约] 打包态不允许直接启动 helper，只能经锁定后的 PowerShell 调用，参数走编码传递，绕开 5.1 版 -Command 拼接尾随参数却不填 $args 的坑。
// [失败路径] 哈希不符时 broker 模式输出 ERR helper_verification_failed 让上层映射成校验失败，version 模式空返回让五段判定失败。
// [平台] 第三个参数是父进程 pid，helper 用它做父进程存活校验；改成固定值或省略会让 --parent-pid 协议失效。
//
async function runLockedPackagedHelper(options: {
  helperPath: string;
  input?: string;
  mode: "broker" | "version";
  runHelper: NonNullable<ReadAppBoundKeyOptions["runHelper"]>;
  trustedPowerShellPath?: string;
  verifiedHelperHash: string;
}): Promise<HelperProcessResult> {
  const powershellPath =
    options.trustedPowerShellPath ?? (await realpath(TRUSTED_WINDOWS_POWERSHELL_ALIAS));
  const hashMismatchResponse =
    options.mode === "broker"
      ? `[Console]::Out.WriteLine('${HELPER_PROTOCOL}\tERR\thelper_verification_failed');return`
      : "return";
  const invocation =
    options.mode === "broker"
      ? "$request=[Console]::In.ReadToEnd();$response=$request | & $zcodeArg0 --broker --parent-pid $zcodeArg2;"
      : "$response=& $zcodeArg0 --version;";
  const script = [
    "$stream=[IO.File]::Open($zcodeArg0,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);",
    "try{",
    "$sha=[Security.Cryptography.SHA256]::Create();",
    "try{$stream.Position=0;$hash=$sha.ComputeHash($stream);",
    "$digest=([BitConverter]::ToString($hash)).Replace('-','').ToLowerInvariant()}",
    "finally{$sha.Dispose()};",
    `if($digest -ne $zcodeArg1){${hashMismatchResponse}};`,
    invocation,
    "if($null -ne $response){[Console]::Out.WriteLine(($response -join [Environment]::NewLine))}",
    "}finally{$stream.Dispose()}",
  ].join("");
  // 可信 PowerShell 在 helper 整个生命周期持有禁止写入/删除的句柄；版本握手和 broker
  // 都只能执行同一已验证文件实例，不存在“恶意镜像先 spawn，再靠路径哈希补验”的窗口。
  return options.runHelper(
    powershellPath,
    createEncodedPowerShellArgs(script, [
      options.helperPath,
      options.verifiedHelperHash,
      String(process.pid),
    ]),
    options.input,
  );
}

// [契约] 校验顺序固定：lstat 判普通文件且非符号链接 → realpath 结果仍在受信根内 → 计算哈希 → 打包态双签名比对 → 版本握手 → 收尾再复核哈希。
// [平台] 受信根在打包态是 resourcesPath 下的导入子目录，开发态是 helper 自身所在目录；越界判定同时禁止 .. 前缀与盘符冒号。
// [事务] 签名前后各算一次哈希，两次都相等才返回，中间任何一次变化都视为竞争替换。
// [失败路径] 整个函数必须只有一个 catch，所有异常都记 name/code 后统一抛 chrome_cookie_helper_verification_failed，绝不透传底层消息。
// [契约] 版本握手要求五段且架构段等于 processArch，打包态还要求 appVersion 与 buildCommit 一致，防止 helper 与主程序错配。
async function verifyHelper(helperPath: string, options: ReadAppBoundKeyOptions): Promise<string> {
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const expectedRoot = packaged
    ? join(options.resourcesPath ?? process.resourcesPath, "browser-import")
    : resolve(helperPath, "..");
  // [事务] try 起点选在 helper 解析之后：Local State 读取与 APPB 校验保持原生错误语义，进入 try 之后才统一收敛。
  // [失败路径] 已带 WindowsChromeAppBoundImportError 的错误原样透传，特别是 elevation_cancelled 与 helper_verification_failed。
  //
  try {
    const [helperInfo, resolvedHelper, resolvedRoot] = await Promise.all([
      lstat(helperPath),
      realpath(helperPath),
      realpath(expectedRoot),
    ]);
    if (!helperInfo.isFile() || helperInfo.isSymbolicLink()) throw new Error("invalid_helper_file");
    const relativePath = relative(resolvedRoot, resolvedHelper);
    if (relativePath.startsWith("..") || relativePath.includes(":")) {
      throw new Error("helper_outside_trusted_root");
    }

    const verifiedHash = await hashHelperFile(helperPath);

    if (packaged) {
      const verifySignature = options.verifySignature ?? verifyAuthenticodePair;
      const signatureResult = await verifySignature(
        helperPath,
        options.appExecutablePath ?? process.execPath,
      );
      if (!signatureResult) {
        throw new Error("helper_signature_mismatch");
      }
      if (typeof signatureResult === "string" && signatureResult !== verifiedHash) {
        throw new Error("helper_signature_file_mismatch");
      }
      if ((await hashHelperFile(helperPath)) !== verifiedHash) {
        throw new Error("helper_changed_during_signature_verification");
      }
    }

    const runHelper = options.runHelper ?? runHelperProcess;
    const version = packaged
      ? await runLockedPackagedHelper({
          helperPath,
          mode: "version",
          runHelper,
          trustedPowerShellPath: options.trustedPowerShellPath,
          verifiedHelperHash: verifiedHash,
        })
      : await runHelper(helperPath, ["--version"]);
    const fields = version.stdout.split("\t");
    const expectedAppVersion = options.expectedAppVersion ?? ZCODE_VERSION;
    const expectedBuildCommit = options.expectedBuildCommit ?? ZCODE_COMMIT;
    if (
      version.exitCode !== 0 ||
      fields.length !== 5 ||
      fields[0] !== HELPER_VERSION_PROTOCOL ||
      fields[1] !== HELPER_VERSION ||
      fields[2] !== (options.processArch ?? process.arch) ||
      (packaged && (fields[3] !== expectedAppVersion || fields[4] !== expectedBuildCommit))
    ) {
      throw new Error("helper_version_or_arch_mismatch");
    }
    if ((await hashHelperFile(helperPath)) !== verifiedHash) {
      throw new Error("helper_changed_during_version_verification");
    }
    return verifiedHash;
  } catch (error) {
    options.logger.warn(
      "[browser-data] Windows Chrome App-Bound helper 校验失败",
      toSafeProcessError(error),
    );
    throw new WindowsChromeAppBoundImportError("chrome_cookie_helper_verification_failed");
  }
}

// [契约] 回包必须三段制表符分隔：协议标识、状态、载荷；段数不对直接判 invalid_response，不做宽松补救。
// [失败路径] ERR 中必须让 elevation_cancelled 与 helper_verification_failed 有独立错误码，前者调用方静默放弃，后者提示重装或重签。
// [契约] OK 分支还要求退出码为 0 且 base64 解出正好 32 字节，长度不符先清零再抛，避免半成品密钥外流。
//
function parseHelperResponse(response: HelperProcessResult, logger: BrowserDataLogger): Buffer {
  const fields = response.stdout.split("\t");
  if (fields.length !== 3 || fields[0] !== HELPER_PROTOCOL) {
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  if (fields[1] === "ERR") {
    if (fields[2] === "elevation_cancelled") {
      throw new WindowsChromeAppBoundImportError("chrome_cookie_elevation_cancelled");
    }
    if (fields[2] === "helper_verification_failed") {
      throw new WindowsChromeAppBoundImportError("chrome_cookie_helper_verification_failed");
    }
    throwAppBoundDecryptionFailure(logger, fields[2]!);
  }
  if (fields[1] !== "OK" || response.exitCode !== 0) {
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  const encodedKey = fields[2];
  if (!encodedKey) {
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    key.fill(0);
    throwAppBoundDecryptionFailure(logger, "invalid_response");
  }
  return key;
}

// [契约] 主流程必须只做四件事：读 Local State、校验 APPB 前缀、解析 helper、清理解析结果；任何新增步骤都要放进同一个 try 或明确标注错误码归属。
// [并发] 同一 userDataDir 可能被多个窗口并发导入，本函数不持有跨调用状态，因此并发安全完全依赖 helper 侧的无状态解密。
// [资源] 进入函数即开始持有密文缓冲，直到 finally 才清零，中间任何提前返回都必须走同一个出口。
//
export async function readWindowsChromeAppBoundKey(
  options: ReadAppBoundKeyOptions,
): Promise<Buffer> {
  // [失败路径] Local State 读取或 JSON 解析失败会抛原生异常，由外层 catch 归成 chrome_cookie_app_bound_decryption_failed；这里刻意不包 try。
  // [平台] 文件名 Local State 带空格，Windows 上大小写不敏感但不能改成 local-state.json 之类的整理名，Chrome 只认原名。
  // [契约] userDataDir 由调用方按 profile 传入，本文件不拼 Default 目录，路径拼接全部走 node:path 的 join。
  //
  const localState = JSON.parse(
    await readFile(join(options.userDataDir, "Local State"), "utf8"),
  ) as {
    os_crypt?: { app_bound_encrypted_key?: string };
  };
  const encodedKey = localState.os_crypt?.app_bound_encrypted_key;
  // [失败路径] 缺少 app_bound_encrypted_key 说明该 profile 是旧版 v10 或 DPAPI 加密，直接解密失败返回，不回退到 DPAPI 路径。
  // [契约] 只读 os_crypt 这一层，不碰 encrypted_key，两者不是同一套密钥体系，混用会拿到看似成功却全错的数据。
  //
  if (!encodedKey) {
    throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
  }
  const appBoundKey = Buffer.from(encodedKey, "base64");
  // [契约] 前 4 字节必须是 ASCII 的 APPB，这是 Chromium 给 App-Bound 载荷打的版本前缀，长度必须大于 4。
  // [失败路径] 长度或前缀不符时先清零整段缓冲再抛错，防止垃圾数据留在堆上，也不新增调用方无法处理的第四种码。
  // [平台] Buffer.from 对非法 base64 字符是宽容的，真正的格式校验全靠这条前缀断言。
  //
  if (appBoundKey.length <= 4 || appBoundKey.subarray(0, 4).toString("ascii") !== "APPB") {
    appBoundKey.fill(0);
    throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
  }

  try {
    const helperPath = await resolveHelperPath(options);
    const verifiedHelperHash = await verifyHelper(helperPath, options);
    const encryptedKey = appBoundKey.subarray(4);
    // [契约] 请求行是三段制表符拼接：协议标识、剥掉 APPB 前缀后的密文 base64、chromeExecutablePath 的 utf8 再 base64。
    // [平台] 路径必须 base64，因为 Windows 路径可能含空格、盘符冒号与中文，直接进制表符分隔的协议行会被截断。
    // [并发] 非打包路径把哈希复核放进 beforeInput，写入 stdin 前最后确认文件没被换掉；打包路径由 PowerShell 句柄锁负责。
    //
    const request = [
      HELPER_PROTOCOL,
      encryptedKey.toString("base64"),
      Buffer.from(options.chromeExecutablePath, "utf8").toString("base64"),
    ].join("\t");
    const runHelper = options.runHelper ?? runHelperProcess;
    const packaged = options.isPackaged ?? isElectronAppPackaged();
    const response = packaged
      ? await runLockedPackagedHelper({
          helperPath,
          input: `${request}\n`,
          mode: "broker",
          runHelper,
          trustedPowerShellPath: options.trustedPowerShellPath,
          verifiedHelperHash,
        })
      : await runHelper(
          helperPath,
          ["--broker", "--parent-pid", String(process.pid)],
          `${request}\n`,
          async () => {
            if ((await hashHelperFile(helperPath)) !== verifiedHelperHash) {
              throw new WindowsChromeAppBoundImportError(
                "chrome_cookie_helper_verification_failed",
              );
            }
          },
        );
    // [契约] 解析放在 try 内，让 helper 回包错误也走同一套日志与错误码收敛，不会漏成未知异常。
    // [资源] 返回的 32 字节密钥由调用方负责清零，本层不复制、不缓存、不写日志。
    // [权衡] 不做并发去重：每次导入都重新走签名与握手，保证密钥不跨调用复用，代价是多几百毫秒。
    //
    return parseHelperResponse(response, options.logger);
  } catch (error) {
    if (error instanceof WindowsChromeAppBoundImportError) throw error;
    options.logger.warn(
      "[browser-data] Windows Chrome App-Bound helper 运行失败",
      toSafeProcessError(error),
    );
    throw new WindowsChromeAppBoundImportError("chrome_cookie_app_bound_decryption_failed");
  // [资源] finally 清零整段 appBoundKey（含 APPB 前缀），密文虽非明文密钥但仍是可重放的敏感材料。
  // [失败路径] 清零不能放在 catch 之后：提前抛错、超时、调用方取消都会跳到 finally，只有这里覆盖所有出口。
  // [资源] subarray 出的 encryptedKey 与 appBoundKey 共享底层内存，清父缓冲即可，不要再单独清子视图。
  //
  } finally {
    // APPB 密文虽不是明文密钥，也不应在导入结束后继续挂在 main 的可复用 Buffer 中。
    appBoundKey.fill(0);
  }
}
