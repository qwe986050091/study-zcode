// `zcode hooks trust ...` 子命令实现：查看/授予/撤销工作区 Hook 声明的信任状态。
// 信任存储的读写、摘要校验与损坏恢复全部由 @zcode/bootstrap 负责；本层只做参数解析与呈现。
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type {
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "@zcode/bootstrap";
import type { RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

// 帮助文本；与 parseTrustArgs 的选项集合必须保持一致，新增选项时同步改这里。
const USAGE = `Usage:
  zcode hooks trust status [--workspace <path-or-identity>] [--json]
  zcode hooks trust review [--workspace <path-or-identity>] [--json]
  zcode hooks trust grant --workspace <path-or-identity> --hook-digest <sha256> [--hook-digest <sha256> ...]
  zcode hooks trust grant --workspace <path-or-identity> --all-current --bundle-digest <sha256>
  zcode hooks trust revoke --workspace <path-or-identity> [--hook-digest <sha256> ... | --all]
`;

// 三个服务的签名别名，供依赖注入点复用，避免在接口里重复书写 typeof import 表达式。
type Inspect = typeof inspectWorkspaceHookTrust;
type Grant = typeof grantWorkspaceHookTrust;
type Revoke = typeof revokeWorkspaceHookTrustCli;

// 本命令的可注入依赖：未提供时懒加载 @zcode/bootstrap，前提是 RunDependencies 的 cwd 等基础依赖已就绪。
type HooksCommandDependencies = RunDependencies & {
  loadBootstrapModule?: () => Promise<typeof import("@zcode/bootstrap")>;
  inspectWorkspaceHookTrust?: Inspect;
  grantWorkspaceHookTrust?: Grant;
  revokeWorkspaceHookTrustCli?: Revoke;
};

// 执行 hooks 命令。
// 输入：ctx.argv 已去掉可执行文件名，argv[1] 必须是 `trust`；version 写入信任记录的 appVersion 字段。
// 输出：退出码 0 成功（含 status/review 的只读展示），1 表示参数错误或服务端拒绝。
// 副作用：grant/revoke 会持久化信任存储；所有路径都会向 stdout 或 stderr 写内容。
// 输出口径：--json 时只写一份结构化对象（失败也写 JSON，便于脚本消费）；人类可读时错误写 stderr。
// 失败语义：解析与服务异常都被捕获转成文本，不向上抛；未捕获异常才视为 bug。
export async function runHooksCommand(
  ctx: RunContext,
  deps: HooksCommandDependencies,
  version: string,
): Promise<number> {
  // argv[1] 缺失（只输入 `zcode hooks`）也走错误分支，提示里用空串而非 undefined。
  if (ctx.argv[1] !== "trust") return fail(ctx, `Unknown hooks command: ${ctx.argv[1] ?? ""}`);
  let parsed: ReturnType<typeof parseTrustArgs>;
  // parseArgs 对未知选项/缺值直接抛错，需在此转成用户可读消息并附带 USAGE。
  try {
    parsed = parseTrustArgs(ctx.argv.slice(2));
  } catch (error) {
    return fail(ctx, error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) {
    ctx.stdout.write(USAGE);
    return 0;
  }
  // 无位置参数时默认 status：只读动作最适合作为缺省，避免误触发授权变更。
  const action = parsed.positionals[0] ?? "status";
  if (!isAction(action) || parsed.positionals.length > 1) {
    return fail(ctx, `Unknown hooks trust command: ${action}`);
  }
  const target = resolveTarget(
    parsed.values.workspace as string | undefined,
    (deps.cwd ?? process.cwd)(),
    deps.userConfigPath,
  );
  const bootstrap = deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap"));
  try {
    let status: WorkspaceHookTrustCliStatus;
    if (action === "status" || action === "review") {
      const inspect =
        deps.inspectWorkspaceHookTrust ?? (await bootstrap()).inspectWorkspaceHookTrust;
      status = await inspect(target);
    } else if (action === "grant") {
      // grant 支持两种粒度：逐个摘要（可多次 --hook-digest）或整包当前声明（--all-current + bundle 摘要）。
      const grant = deps.grantWorkspaceHookTrust ?? (await bootstrap()).grantWorkspaceHookTrust;
      status = await grant({
        ...target,
        hookDeclarationDigests: parsed.values["hook-digest"] as string[] | undefined,
        allCurrent: parsed.values["all-current"] === true,
        bundleDigest: parsed.values["bundle-digest"] as string | undefined,
        appVersion: version,
      });
    } else {
      const revoke =
        deps.revokeWorkspaceHookTrustCli ?? (await bootstrap()).revokeWorkspaceHookTrustCli;
      status = await revoke({
        ...target,
        hookDeclarationDigests: parsed.values["hook-digest"] as string[] | undefined,
        all: parsed.values.all === true,
      });
    }
    ctx.stdout.write(
      parsed.values.json ? `${JSON.stringify(status, null, 2)}\n` : formatHuman(status, action),
    );
    return 0;
  } catch (error) {
    // 服务层把拒绝原因放在 message 里（稳定 reasonCode 字符串），直接透传给用户，不在此翻译。
    const reasonCode = error instanceof Error ? error.message : String(error);
    if (parsed.values.json) {
      ctx.stdout.write(`${JSON.stringify({ accepted: false, reasonCode }, null, 2)}\n`);
    } else {
      ctx.stderr.write(`Error: ${reasonCode}\n`);
    }
    return 1;
  }
}

// 解析 `trust` 之后的参数。
// 输入：已去掉子命令前缀的参数数组；位置参数允许出现（首个为动作名）。
// 输出：parseArgs 结果；`--hook-digest` 支持多次出现，收集为数组。
// 失败语义：未知选项或字符串选项缺少值会抛 TypeError，由调用方转成 usage 提示。
function parseTrustArgs(args: string[]) {
  return parseArgs({
    allowPositionals: true,
    args,
    options: {
      workspace: { type: "string" },
      "hook-digest": { type: "string", multiple: true },
      "all-current": { type: "boolean" },
      "bundle-digest": { type: "string" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

// 把 `--workspace` 的原始值解析成服务层要的 target。
// 输入：value 可为 undefined（未指定）、工作区 identity（`local:`/`remote:` 等前缀）或普通路径。
// 输出：workspacePath 恒为绝对路径；workspaceIdentity 仅在识别为 identity 时出现；userConfigPath 仅在提供时出现。
// 口径：identity 形态下无法反推出真实路径，workspacePath 退化为当前 cwd，只用于展示与日志。
function resolveTarget(
  value: string | undefined,
  cwd: string,
  userConfigPath: string | undefined,
): WorkspaceHookTrustCliTarget {
  const selected = value?.trim();
  // 前缀命中即按 identity 处理，否则按路径相对 cwd 解析；trim 后的空串按"未指定"对待。
  const identity = selected && looksLikeWorkspaceIdentity(selected) ? selected : undefined;
  return {
    workspacePath: identity ? resolve(cwd) : selected ? resolve(cwd, selected) : resolve(cwd),
    ...(identity ? { workspaceIdentity: identity } : {}),
    ...(userConfigPath ? { userConfigPath } : {}),
  };
}

// 识别 `scheme:` 形式的工作区 identity；只认已知 scheme，避免把 Windows 盘符 `C:` 误判为 identity。
function looksLikeWorkspaceIdentity(value: string): boolean {
  return /^(?:local|remote|ssh|container|wsl):/u.test(value);
}

// 生成人类可读的信任状态报告。
// 输入：status 为服务层返回的完整快照（items 可能为空集合），action 仅用于标题。
// 输出：多行文本，已带结尾换行；包含每条声明的 trusted 状态、启用态、来源与摘要。
// 副作用：无；纯格式化函数。
function formatHuman(status: WorkspaceHookTrustCliStatus, action: string): string {
  const lines = [
    `Workspace Hook Trust (${action})`,
    `workspace: ${status.workspaceIdentity}`,
    `path: ${status.workspacePath}`,
    `bundle: ${status.bundleDigest ?? "none"}`,
    `state: ${status.reasonCode}`,
  ];
  if (status.items.length === 0) lines.push("No Workspace Hook declarations found.");
  for (const [index, item] of status.items.entries()) {
    lines.push(
      `${index + 1}. [${item.trustState}] [${item.configuredEnabled ? "enabled" : "disabled"}] ${item.event}${item.matcher ? ` / ${item.matcher}` : ""}`,
      `   ${item.displayCommand}`,
      `   source: ${item.sourcePath}`,
      `   digest: ${item.hookDeclarationDigest}`,
    );
  }
  if (status.reasonCode === "workspace_hooks_pending_trust" && status.bundleDigest) {
    lines.push(
      "Pretrust exact declarations with:",
      `  zcode hooks trust grant --workspace ${quote(status.workspaceIdentity)} --hook-digest <sha256>`,
      "Or trust every currently enabled declaration in this exact bundle with:",
      `  zcode hooks trust grant --workspace ${quote(status.workspaceIdentity)} --all-current --bundle-digest ${status.bundleDigest}`,
    );
  }
  if (status.reasonCode === "workspace_hooks_trust_store_corrupt") {
    // 损坏 store 下 grant/revoke 都会被拒绝；恢复指引必须是修复文件本身。
    lines.push(
      "The persistent trust store is corrupt; grant/revoke are rejected until it is fixed.",
      "The corrupted file was moved aside as workspace-hook-trust-v1.json.corrupt-<timestamp>.",
      "Recovery: restore it from backup, or remove the leftover *.corrupt-* file so a fresh store is created, then re-run grant.",
    );
  }
  return `${lines.join("\n")}\n`;
}

// 用 JSON 字符串字面量包裹 workspace，保证路径含空格或特殊字符时复制出来的命令仍可执行。
function quote(value: string): string {
  return JSON.stringify(value);
}

// 动作白名单的类型守卫；同时充当唯一合法的四个取值来源。
function isAction(value: string): value is "status" | "review" | "grant" | "revoke" {
  return value === "status" || value === "review" || value === "grant" || value === "revoke";
}

// 统一的用法错误出口：错误信息与 USAGE 一起写 stderr，并固定返回 1。
function fail(ctx: RunContext, message: string): number {
  ctx.stderr.write(`${message}\n${USAGE}`);
  return 1;
}
