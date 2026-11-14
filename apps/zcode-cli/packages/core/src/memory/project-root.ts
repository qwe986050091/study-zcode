// ============================================================
// memory/project-root —— 按 workspace 身份解析 project Memory 根目录
// ============================================================
//
// 【定位】把 cliStorageRoot + workspace 身份映射成稳定目录：
//   <cliStorageRoot>/memories/projects/<slug>-<hash16>/memory
//   同一 workspace 的所有会话共享一份记忆，不同 workspace 互不串扰。
//
// 【键口径】有 workspaceIdentity 时优先用它（身份隔离/远程链路）；否则用规范化
//   后的 workspacePath，Windows 下再转小写，抵消大小写不敏感差异。
//
// 【读写边界】纯路径计算，不创建目录；建目录由 ensureMemoryDirectoryExists 负责。
// 【失败语义】不抛错：slug 清洗后为空时回退 "project"。
// 【失效/过期口径】hash 由身份原文决定，身份变化即换目录，旧目录不自动迁移。
// ============================================================
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

/**
 * 路径解析输入。
 * cliStorageRoot：CLI 自有存储根（来自 memory 配置，必须已配置）。
 * workspaceIdentity：可选身份 key；提供时优先于路径参与 hash 与命名。
 * workspacePath：文件系统路径；identity 缺失时作为身份来源。
 */
interface ProjectMemoryRootInput {
  cliStorageRoot: string;
  workspaceIdentity?: string;
  workspacePath: string;
}

/**
 * 解析某个 workspace 的 project Memory 根目录（绝对路径）。
 * 输入：cliStorageRoot、可选 workspaceIdentity、workspacePath。
 * 输出：`<cliStorageRoot>/memories/projects/<slug>-<hash16>/memory`。
 * 副作用：无。
 * 失败语义：不抛错；path 非法时由 Node 的 resolve 抛 TypeScript 层错误（调用方输入契约）。
 * 不变量：hash 取 sha256 前 16 位，既避免同名目录碰撞，又不把原始路径暴露在目录名里；
 *   slug 只用于可读性，身份判定的唯一依据是 hash。
 */
export function resolveProjectMemoryRoot(input: ProjectMemoryRootInput): string {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const normalizedWorkspacePath = resolve(input.workspacePath);
  const keySource =
    workspaceIdentity ||
    // Windows 路径大小写不敏感：转小写确保同一目录不同写法命中同一记忆。
    (process.platform === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  // 有身份 key 时统一用 "project"，避免把 identity 原文（可能含敏感信息）写进目录名。
  const slug = workspaceIdentity
    ? "project"
    : sanitizeProjectSlug(basename(normalizedWorkspacePath) || "project");

  return join(input.cliStorageRoot, "memories", "projects", `${slug}-${hash}`, "memory");
}

/**
 * 把目录名清洗成可读 slug：小写、非字母数字替换为连字符、去首尾连字符、
 * 截断 48 字符；结果为空时回退 "project"。
 * 仅影响可读性，不参与身份唯一性（唯一性由 hash 承担）。
 */
function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
