/**
 * Bash 执行后的工作目录边界策略：判定命令结束时 cwd 是否仍位于 workspaceRoot 内。
 * 由 bash.ts 在执行结束后调用 decideBashCwdPolicy，把 nextWorkingDirectory 回填到会话；
 * 越界时重置回 workspaceRoot 并追加 stderr 提示。
 * 仅在 completed + exit 0 + main runtime scope 时生效，其它情况保持原状、不做推断。
 */

import { realpathSync } from "node:fs";
import { platform as currentPlatform } from "node:process";
import type { ExecutionResult } from "@zcode/contracts";
import {
  getToolPathApi,
  normalizeToolPathForComparison,
  type ToolPathApi,
  type ToolPathPlatform,
} from "../path-normalization.js";
import type { ToolRuntimeScope } from "../types.js";

export interface BashCwdPolicyInput {
  resolvedCwd: string | undefined;
  status: ExecutionResult["status"];
  exitCode: number | undefined;
  platform?: ToolPathPlatform;
  workspaceRoot: string;
  runtimeScope?: ToolRuntimeScope;
}

export interface BashCwdPolicyDecision {
  nextWorkingDirectory?: string;
  stderrSuffix?: string;
}

interface NormalizedCwdBoundary {
  pathApi: ToolPathApi;
  resolvedCwd: string;
  workspaceRoot: string;
  equivalentPairs: Array<{ resolvedCwd: string; workspaceRoot: string }>;
}

export function decideBashCwdPolicy(input: BashCwdPolicyInput): BashCwdPolicyDecision {
  // 只有正常完成且退出码为 0 的 main-scope 命令，其最终 cwd 才可信；其余保留原状。
  if (input.status !== "completed") return {};
  if (input.exitCode !== 0) return {};
  if (!input.resolvedCwd) return {};
  if ((input.runtimeScope ?? "main") !== "main") return {};

  const boundary = normalizeCwdBoundaryInput(input);

  if (isResolvedCwdInsideWorkspace(boundary)) {
    return { nextWorkingDirectory: boundary.resolvedCwd };
  }

  return {
    nextWorkingDirectory: boundary.workspaceRoot,
    stderrSuffix: `Shell cwd was reset to ${boundary.workspaceRoot}`,
  };
}

export function appendBashCwdStderrSuffix(stderr: string, suffix: string | undefined): string {
  // 先去掉 stderr 尾部换行再拼接，避免提示前出现空行；stderr 为空时只保留提示本身。
  if (!suffix) return stderr;
  const stderrWithoutTrailingNewlines = stderr.replace(/[\r\n]+$/, "");
  if (!stderrWithoutTrailingNewlines) return suffix;
  return `${stderrWithoutTrailingNewlines}\n${suffix}`;
}

function normalizeCwdBoundaryInput(input: BashCwdPolicyInput): NormalizedCwdBoundary {
  const platform = input.platform ?? currentPlatform;
  const pathApi = getToolPathApi(platform);
  const isWindows = platform === "win32";
  const resolvedCwd = normalizeCwdBoundary(input.resolvedCwd ?? "", isWindows);
  const workspaceRoot = normalizeCwdBoundary(input.workspaceRoot, isWindows);
  const equivalentPairs = [{ resolvedCwd, workspaceRoot }];
  // cwd 捕获使用 pwd -P/realpath 得到物理路径；session root 可能是 symlink。
  // 统一收集等价边界后再判断，避免把项目内物理路径误判成离开项目。
  const realResolvedCwd = realpathCwdBoundary(input.resolvedCwd ?? "", isWindows);
  const realWorkspaceRoot = realpathCwdBoundary(input.workspaceRoot, isWindows);

  if (realResolvedCwd && realWorkspaceRoot) {
    equivalentPairs.push({
      resolvedCwd: realResolvedCwd,
      workspaceRoot: realWorkspaceRoot,
    });
  }

  return {
    pathApi,
    resolvedCwd,
    workspaceRoot,
    equivalentPairs,
  };
}

function isResolvedCwdInsideWorkspace(boundary: NormalizedCwdBoundary): boolean {
  // 物理路径与逻辑路径各算一次，任一组合落在工作区内即视为未越界。
  return boundary.equivalentPairs.some(({ resolvedCwd, workspaceRoot }) =>
    isInsideOrSamePath(resolvedCwd, workspaceRoot, boundary.pathApi),
  );
}

function isInsideOrSamePath(child: string, parent: string, pathApi: ToolPathApi): boolean {
  const relativePath = pathApi.relative(parent, child);
  return relativePath === "" || !isPathOutsideParent(relativePath, pathApi);
}

function isPathOutsideParent(relativePath: string, pathApi: ToolPathApi): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  );
}

function normalizeCwdBoundary(value: string, isWindows: boolean): string {
  let normalized = normalizeToolPathForComparison(value, isWindows ? "win32" : "linux");
  // macOS 上 /private/var 与 /var、/private/tmp 与 /tmp 是同一位置，统一后可避免误判越界。
  if (!isWindows) {
    normalized = normalized
      .replace(/^\/private\/var\//, "/var/")
      .replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
  }
  return normalized;
}

function realpathCwdBoundary(value: string, isWindows: boolean): string | undefined {
  // realpath 失败（路径已删除/无权限）时返回 undefined，只保留逻辑路径比较。
  try {
    return normalizeCwdBoundary(realpathSync.native(value), isWindows);
  } catch {
    return undefined;
  }
}
