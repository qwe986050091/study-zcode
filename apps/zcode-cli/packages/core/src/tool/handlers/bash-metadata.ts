/**
 * Bash 工具的展示/分类元数据：描述、用户可见名、工具摘要、活动描述与自动分类输入。
 * 被 bash.ts 的 toolEntry 与 UI 层调用；只读取 input 的字符串字段，不参与权限或只读判定。
 * sed -i 这类"命令名不变但实际在改文件"的情况会显示为 Update，避免 UI 把它标成只读 Bash。
 */

import { isSedInPlaceBashCommand } from "./bash-semantics.js";

export function getBashDescription(input: unknown): string {
  // 没有 description 时用固定文案，保证 UI 不出现空活动行。
  const description = readStringProperty(input, "description");
  return description && description.length > 0 ? description : "Run shell command";
}

export function getBashUserFacingName(input?: unknown): string {
  const command = readStringProperty(input, "command");
  // sed -i 实际是编辑文件，展示成 Update 更符合用户预期，也避免被误当成只读命令。
  if (command && isSedInPlaceBashCommand(command)) return "Update";
  return "Bash";
}

export function getBashToolUseSummary(input?: unknown): string | null {
  const command = readStringProperty(input, "command");
  if (!command) return null;
  // 摘要优先用模型给出的 description，没有才退回原始命令。
  const description = readStringProperty(input, "description");
  return description && description.length > 0 ? description : command;
}

export function getBashActivityDescription(input?: unknown): string {
  const command = readStringProperty(input, "command");
  if (!command) return "Running command";
  // 活动行统一加 "Running " 前缀；命令缺失时用兜底文案。
  const description = readStringProperty(input, "description");
  return `Running ${description && description.length > 0 ? description : command}`;
}

export function getBashAutoClassifierInput(input: unknown): string | undefined {
  return readStringProperty(input, "command");
}

export function readStringProperty(input: unknown, key: string): string | undefined {
  // 输入是 unknown（可能来自模型 JSON），只接受字符串字段，其它类型一律返回 undefined。
  if (!input || typeof input !== "object" || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
