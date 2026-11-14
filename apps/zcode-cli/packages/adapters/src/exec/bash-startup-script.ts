// ============================================================
// 文件定位：Bash 启动脚本物化与命令前缀注入（把搜索前缀写成 .sh 文件，再在命令前 `. 文件`）。
// 输入输出：输入 ExecutionRequest + rootDir/sessionId/方言；输出可能被替换 command 的新请求。
// 副作用：在 <rootDir>/bash-startup/<session>/ 下 mkdir/writeFile(chmod 0600)，同名同内容复用。
// 失败语义：非 shell/非 posix-bash、不支持方言或内容为空时原样返回入参请求；写文件失败向上抛。
// 不变量：脚本内容按 sha256 前 16 位命名，内容变化必换文件；命令始终在原命令前追加 source 行。
// ============================================================
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowsPathToGitBashPath } from "@zcode/contracts";
import type { ExecutionRequest, ExecutionShellDialect } from "@zcode/contracts";
import { buildEmbeddedSearchPreludeContent } from "./embedded-search-prelude.js";

// legacy-shell 也纳入：此时无法 source .sh，物化阶段会因 supportsBashSourceScripts 返回 undefined。
export type StartupShellDialect = ExecutionShellDialect | "legacy-shell";

export interface BashInternalScriptMaterializeOptions {
  // 会话级根目录（通常是 storage/cli/exec），脚本落在其 bash-startup/<sessionId>/ 下。
  rootDir: string;
  sessionId: string;
  // 决定是否支持 source，以及 git-bash 下路径是否需要转成 /c/... 形式。
  shellDialect?: StartupShellDialect;
}

export interface BashInternalScriptContent {
  // 仅用于文件名前缀，进路径前会被消毒。
  id: string;
  content: string;
}

export interface MaterializedBashSourceScript {
  // 主进程可用的路径（Windows 为反斜杠绝对路径）。
  path: string;
  // Bash 内可 source 的路径：git-bash 下为 /c/...，其余与 path 相同。
  shellPath: string;
}

export interface BashSourceScript {
  path: string;
  shellPath: string;
  // true 时 source 行追加 `2>/dev/null || true`，脚本缺失不阻断主命令。
  optional?: boolean;
}

export interface ApplyBashSourcesOptions {
  // 前置 source 脚本（如用户 hook），按数组顺序排在命令前。
  leadingSources?: BashSourceScript[];
  rootDir: string;
  sessionId: string;
  shellDialect: StartupShellDialect;
}

// 为 Bash 请求物化并注入启动脚本：非 shell / 非 posix-bash 请求原样返回（引用相等）。
// 生成内容为空时不做任何文件写入，命令保持不变，避免无意义的 source 行。
export function applyBashSourcesToExecutionRequest(
  request: ExecutionRequest,
  options: ApplyBashSourcesOptions,
): ExecutionRequest {
  if (
    request.command.mode !== "shell" ||
    request.command.shellProfile !== "posix-bash"
  ) {
    // 只有 Bash 才有“启动脚本”概念；cmd / legacy shell 不做任何改写。
    return request;
  }

  const embeddedPreludeContent = buildEmbeddedSearchPreludeContent(request.bashPrelude, {
    shellDialect: options.shellDialect,
  });
  const internalScript = embeddedPreludeContent
    ? {
        id: "embedded-search-startup",
        content: embeddedPreludeContent,
      }
    : undefined;
  const materialized = materializeBashInternalSourceScript(internalScript, {
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    shellDialect: options.shellDialect,
  });
  const sources = [
    ...(options.leadingSources ?? []),
    ...(materialized ? [materialized] : []),
  ];
  const command = applyBashSourceScripts(request.command.command, sources);
  // 没有可 source 的脚本时返回原请求，保持引用相等以便上层跳过无谓更新。
  if (command === request.command.command) return request;

  return {
    ...request,
    command: {
      ...request.command,
      command,
    },
  };
}

// 把内部脚本写到会话目录并返回 source 所需路径；脚本为空、方言不支持、内容为空时返回 undefined。
// 写盘采用 0600；Windows 忽略 POSIX mode bit 但目录仍属 ZCode storage。
export function materializeBashInternalSourceScript(
  script: BashInternalScriptContent | undefined,
  options: BashInternalScriptMaterializeOptions,
): MaterializedBashSourceScript | undefined {
  if (!script) return undefined;
  if (!supportsBashSourceScripts(options.shellDialect)) return undefined;
  if (script.content.length === 0) return undefined;

  const sessionDir = join(options.rootDir, "bash-startup", sanitizePathSegment(options.sessionId));
  mkdirSync(sessionDir, { recursive: true });

  const hash = hashContent(script.content);
  const fileName = `${sanitizePathSegment(script.id)}-${hash}.sh`;
  const path = join(sessionDir, fileName);

  // 文件已存在且内容一致就复用；内容变化由哈希文件名自然隔离，不覆盖旧文件。
  if (!existsSync(path) || readFileSync(path, "utf8") !== script.content) {
    writeFileSync(path, script.content, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows 可能不保留 POSIX mode bit；文件仍位于 ZCode 自有 storage 下。
    }
  }

  return {
    path,
    shellPath: options.shellDialect === "git-bash" ? windowsPathToGitBashPath(path) : path,
  };
}

// 单脚本注入的便捷重载；undefined 时命令原样返回，便于调用方统一走该路径。
export function applyBashSourceScript(
  command: string,
  materialized: MaterializedBashSourceScript | undefined,
): string {
  return applyBashSourceScripts(command, materialized ? [materialized] : []);
}

// 生成 source 前缀：按顺序逐行 `. <path>`，optional 的追加 `2>/dev/null || true` 以免脚本缺失中断。
// 无 source 时直接返回原命令（引用相等可被调用方用于判等）。
export function applyBashSourceScripts(command: string, sources: BashSourceScript[]): string {
  const sourceLines = sources.map((source) => {
    const sourceCommand = `. ${quoteSourcePath(source)}`;
    return source.optional ? `${sourceCommand} 2>/dev/null || true` : sourceCommand;
  });
  return sourceLines.length === 0 ? command : [...sourceLines, command].join("\n");
}

// 只有 POSIX 语义的 shell（posix / git-bash）才支持 `. file`；cmd 与 legacy 一律不物化。
function supportsBashSourceScripts(shellDialect: StartupShellDialect | undefined): boolean {
  return shellDialect === "posix" || shellDialect === "git-bash";
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellQuoteAlways(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// source 路径引号策略：path==shellPath 时（POSIX）始终单引号；git-bash 转换后含盘符/空格时按需引号。
function quoteSourcePath(materialized: BashSourceScript): string {
  return materialized.path === materialized.shellPath
    ? shellQuoteAlways(materialized.shellPath)
    : shellQuote(materialized.shellPath);
}
