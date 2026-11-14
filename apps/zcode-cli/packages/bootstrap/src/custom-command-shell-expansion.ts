// INV-01 只做语法提取不执行：守住位置 模块边界；改错故障 审批与沙箱职责被绕过。
// INV-02 片段顺序替换：守住位置 主循环；改错故障 多个片段的输出顺序错乱。
// INV-03 片段之间不重叠：守住位置 游标推进；改错故障 嵌套片段被重复执行。
// INV-04 前一片段失败即中断：守住位置 循环内 await；改错故障 失败后继续执行后续片段。
// INV-05 空命令展开为空串：守住位置 早退；改错故障 产生一次无意义子进程。
// INV-06 片段外原文逐字保留：守住位置 拼接；改错故障 换行与缩进被改写。
// INV-07 行内与围栏双正则：守住位置 采集；改错故障 只支持一种语法形态。
// INV-08 同位置围栏优先：守住位置 比较符；改错故障 围栏被误判成行内片段。
// INV-09 扫描后重置 lastIndex：守住位置 函数末尾；改错故障 跨调用漏匹配。
// INV-10 围栏命令先去首尾换行：守住位置 归一化；改错故障 命令带多余换行。
// INV-11 固定超时：守住位置 执行参数；改错故障 片段长期挂起。
// INV-12 输出上限固定：守住位置 预算字段；改错故障 大输出撑爆上下文。
// INV-13 展开结果不落产物：守住位置 persistOutput；改错故障 中间文件残留。
// INV-14 环境变量只注入白名单：守住位置 env 构造；改错故障 CLI 密钥泄露给子进程。
// INV-15 新旧前缀双写：守住位置 赋值；改错故障 旧命令读不到项目目录。
// INV-16 缺上下文先报错再执行：守住位置 校验顺序；改错故障 执行出半成品再失败。
// INV-17 成功条件含退出码：守住位置 判定；改错故障 非零退出被当成成功。
// INV-18 失败错误带命令与详情：守住位置 格式化；改错故障 用户看不到失败原因。
//
// 模块职责：展开自定义命令里的 shell 片段并拼接输出。
// 状态所有权：无状态；正则游标在调用内局部维护。
// 阅读顺序：先看主展开循环，再看片段采集，最后看执行与环境构造。
// 自定义命令里的 shell 片段展开（`!`cmd`` 与 ```! 围栏）。
//
// 信任边界：命令 markdown 来自用户/项目/插件目录，其中的 shell 由 executionPort 执行；
// 审批与沙箱由 executionPort/权限层负责，本模块只做语法提取、上下文变量校验与结果拼接。
// 约束：
// - 固定 30s 超时、128KiB 输出上限、persistOutput=none（展开结果只进 prompt，不落产物）；
// - 只注入显式白名单环境变量（不继承整个 process.env），避免把 CLI 的密钥带进子进程；
// - 非零退出/未完成一律抛错，不把失败静默替换为空串，防止命令语义被悄悄改变。
import { basename, dirname } from "node:path";
import {
  type CustomCommandContent,
  type HookPluginContext,
  type ExecutionPort,
  type ExecutionResult,
  type TraceContext,
} from "@zcode/contracts";

const DEFAULT_SHELL_EXPANSION_TIMEOUT_MS = 30_000;
const DEFAULT_SHELL_EXPANSION_OUTPUT_BYTES = 128 * 1024;

const INLINE_SHELL_PATTERN = /!`([^`]*)`/gu;
const FENCED_SHELL_PATTERN = /```!\s*\r?\n?([\s\S]*?)```/gu;
const SHELL_CONTEXT_VARIABLE_PATTERN =
  /\$\{(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)\}/gu;

interface ShellExpansionMatch {
  command: string;
  end: number;
  start: number;
  type: "fenced" | "inline";
}

/**
 * 把正文里的所有 shell 片段顺序替换为执行输出（stdout 去尾部空白）。
 *
 * - 从左到右扫描，片段之间不重叠；每个片段各自一次 executionPort.run，前一个失败即中断，
 *   不会执行后续片段；
 * - 空命令（``!``）直接展开为空串，不产生一次无意义执行；
 * - 除片段外的原文（含换行/缩进）逐字保留，保证模型看到的结构不被展开改变。
 */
// cursor 之前的原文用 slice(cursor, match.start) 原样拼回。
// runShellExpansion 每个片段 await 一次，串行不并发。
// 结果直接 += 到 output，不做二次转义。
// cursor 推进到 match.end，片段之间不重叠。
// 循环后 slice(cursor) 补齐尾部原文。
export async function expandCustomCommandShellSyntax(input: {
  command: CustomCommandContent;
  content: string;
  executionPort: ExecutionPort;
  sessionId?: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  workingDirectory: string;
}): Promise<string> {
  let cursor = 0;
  let output = "";

  for (const match of collectShellExpansionMatches(input.content)) {
    output += input.content.slice(cursor, match.start);
    output += await runShellExpansion({
      ...input,
      shellCommand: match.command,
      type: match.type,
    });
    cursor = match.end;
  }

  output += input.content.slice(cursor);
  return output;
}

// 双正则（行内/围栏）同时推进，取更靠前的一个；游标移到片段末尾，天然避免嵌套与重叠。
// 扫描结束重置 lastIndex，因为这两个正则带 g 标志，跨调用共享状态会造成漏匹配。
// INLINE_SHELL_PATTERN 与 FENCED_SHELL_PATTERN 都从 cursor 起扫。
// pickNextMatch 取 index 更靠前的匹配。
// next 为空即 break 结束扫描。
// 命中后 cursor 跳到 next.end。
// 返回前把两个正则的 lastIndex 归零。
function collectShellExpansionMatches(content: string): ShellExpansionMatch[] {
  const matches: ShellExpansionMatch[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    INLINE_SHELL_PATTERN.lastIndex = cursor;
    FENCED_SHELL_PATTERN.lastIndex = cursor;

    const inline = INLINE_SHELL_PATTERN.exec(content);
    const fenced = FENCED_SHELL_PATTERN.exec(content);
    const next = pickNextMatch(inline, fenced);
    if (!next) break;

    matches.push(next);
    cursor = next.end;
  }

  INLINE_SHELL_PATTERN.lastIndex = 0;
  FENCED_SHELL_PATTERN.lastIndex = 0;
  return matches;
}

// 同位置时围栏优先（<=），避免 ```! 被误判成行内片段；两种形态分别记录，供 trace 标注。
function pickNextMatch(
  inline: RegExpExecArray | null,
  fenced: RegExpExecArray | null,
): ShellExpansionMatch | null {
  if (!inline && !fenced) return null;
  if (fenced && (!inline || fenced.index <= inline.index)) {
    return {
      command: normalizeFencedShellCommand(fenced[1] ?? ""),
      end: fenced.index + fenced[0].length,
      start: fenced.index,
      type: "fenced",
    };
  }
  if (!inline) return null;
  return {
    command: (inline[1] ?? "").trim(),
    end: inline.index + inline[0].length,
    start: inline.index,
    type: "inline",
  };
}

function normalizeFencedShellCommand(command: string): string {
  return command.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "").trim();
}

/**
 * 执行单个片段并返回替换文本。
 *
 * 顺序很重要：先判空，再确定插件上下文并校验 `$VAR` 是否具备对应上下文，最后才执行；
 * 这样缺上下文时在产生任何子进程之前就以清晰错误失败（而不是执行出半成品）。
 * 成功条件 = status completed 且 exitCode 0；其余（含 aborted/超时/截断）都抛带详情的错误。
 */
// shellCommand 为空时提前返回空串。
// 插件上下文可由 input.plugin 给出或推导。
// 变量校验先于 executionPort.run。
// 执行参数固定，只有 shellCommand 与 env 变化。
// trace 属性区分片段形态。
async function runShellExpansion(input: {
  command: CustomCommandContent;
  env?: NodeJS.ProcessEnv;
  executionPort: ExecutionPort;
  sessionId?: string;
  shellCommand: string;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  type: "fenced" | "inline";
  workingDirectory: string;
}): Promise<string> {
  if (input.shellCommand.length === 0) return "";
  const plugin = input.command.metadata.plugin ?? inferPluginContext(input.command);
  assertShellExpansionContextAvailable({
    command: input.command,
    plugin,
    sessionId: input.sessionId,
    shellCommand: input.shellCommand,
  });

  const result = await input.executionPort.run(
    {
      command: {
        mode: "shell",
        command: input.shellCommand,
      },
      cwd: input.workingDirectory,
      env: createShellExpansionEnv({
        plugin,
        sessionId: input.sessionId,
        workingDirectory: input.workingDirectory,
      }),
      outputLimit: {
        maxBufferBytes: DEFAULT_SHELL_EXPANSION_OUTPUT_BYTES,
        maxInlineBytes: DEFAULT_SHELL_EXPANSION_OUTPUT_BYTES,
        persistOutput: "none",
      },
      timeoutMs: DEFAULT_SHELL_EXPANSION_TIMEOUT_MS,
      ...(input.traceContext
        ? {
            trace: {
              ...input.traceContext,
              attributes: {
                ...input.traceContext.attributes,
                customCommandName: input.command.metadata.name,
                customCommandShellExpansion: input.type,
              },
            },
          }
        : {}),
    },
    { signal: input.signal },
  );

  if (result.status === "completed" && (result.exitCode ?? 0) === 0) {
    return result.stdout.text.trimEnd();
  }

  throw new Error(formatShellExpansionError(input.command, input.shellCommand, result));
}

// 只构造 env.set 补丁（CLAUDE_* 与 ZCODE_* 双写，兼容旧命令）；不传 base env，
// 因此子进程看不到 process.env 中的密钥。无任何变量时返回 undefined，保持调用参数简洁。
// 只构造 env.set 增量补丁。
// 不传 base env，子进程看不到 process.env 密钥。
// CLAUDE_PROJECT_DIR 与 ZCODE_PROJECT_DIR 总是写入。
// sessionId 与 plugin 变量按需写入。
function createShellExpansionEnv(input: {
  plugin: HookPluginContext | undefined;
  sessionId: string | undefined;
  workingDirectory: string;
}) {
  const set: Record<string, string> = {};
  set.CLAUDE_PROJECT_DIR = input.workingDirectory;
  set.ZCODE_PROJECT_DIR = input.workingDirectory;
  if (input.sessionId) {
    set.CLAUDE_CODE_SESSION_ID = input.sessionId;
    set.CLAUDE_SESSION_ID = input.sessionId;
    set.ZCODE_SESSION_ID = input.sessionId;
  }
  if (input.plugin) {
    set.CLAUDE_PLUGIN_DATA = input.plugin.dataPath;
    set.CLAUDE_PLUGIN_ROOT = input.plugin.rootPath;
    set.ZCODE_PLUGIN_DATA = input.plugin.dataPath;
    set.ZCODE_PLUGIN_ID = input.plugin.id;
    set.ZCODE_PLUGIN_NAME = input.plugin.name;
    set.ZCODE_PLUGIN_ROOT = input.plugin.rootPath;
  }
  return Object.keys(set).length > 0 ? { set } : undefined;
}

// 静态校验片段引用的上下文变量：skill 目录变量在自定义命令中永远不可用；
// session/plugin 类变量分别要求真实 sessionId 与插件来源，错误信息带命令名便于定位。
function assertShellExpansionContextAvailable(input: {
  command: CustomCommandContent;
  plugin: HookPluginContext | undefined;
  sessionId: string | undefined;
  shellCommand: string;
}): void {
  for (const match of input.shellCommand.matchAll(SHELL_CONTEXT_VARIABLE_PATTERN)) {
    const name = match[1];
    if (!name) continue;
    if (name === "CLAUDE_SKILL_DIR" || name === "ZCODE_SKILL_DIR") {
      throw new Error(
        `Custom command /${input.command.metadata.name} variable requires a skill context: ${name}`,
      );
    }
    if (
      !input.sessionId &&
      (name === "CLAUDE_CODE_SESSION_ID" ||
        name === "CLAUDE_SESSION_ID" ||
        name === "ZCODE_SESSION_ID")
    ) {
      throw new Error(
        `Custom command /${input.command.metadata.name} variable requires a runtime session context: ${name}`,
      );
    }
    if (
      !input.plugin &&
      (name === "CLAUDE_PLUGIN_DATA" ||
        name === "CLAUDE_PLUGIN_ROOT" ||
        name === "ZCODE_PLUGIN_DATA" ||
        name === "ZCODE_PLUGIN_ROOT")
    ) {
      throw new Error(
        `Custom command /${input.command.metadata.name} variable requires a plugin context: ${name}`,
      );
    }
  }
  SHELL_CONTEXT_VARIABLE_PATTERN.lastIndex = 0;
}

// 仅当命令来源是插件且 rootPath 形如 <plugin>/commands 时推导插件上下文；
// 其余（用户/项目命令）返回 undefined，从而让 PLUGIN_* 变量校验失败而不是填错目录。
function inferPluginContext(command: CustomCommandContent): HookPluginContext | undefined {
  if (command.metadata.source !== "plugin") return undefined;
  if (basename(command.metadata.rootPath) !== "commands") return undefined;
  const rootPath = dirname(command.metadata.rootPath);
  return {
    dataPath: rootPath,
    id: basename(rootPath),
    name: basename(rootPath),
    rootPath,
  };
}

function formatShellExpansionError(
  command: CustomCommandContent,
  shellCommand: string,
  result: ExecutionResult,
): string {
  const details =
    result.error?.message ||
    trimPreview(result.stderr.text) ||
    trimPreview(result.stdout.text) ||
    `status=${result.status}`;
  return [
    `Custom command /${command.metadata.name} shell expansion failed.`,
    `Command: ${shellCommand}`,
    `Exit: ${result.exitCode ?? result.status}`,
    `Details: ${details}`,
  ].join("\n");
}

function trimPreview(value: string): string {
  return value.trim().slice(0, 2_000);
}
