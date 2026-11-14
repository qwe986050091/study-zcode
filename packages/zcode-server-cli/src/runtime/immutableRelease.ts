// INV-01 归档摘要必须是六十四位十六进制：守住位置 入参校验；改错故障 非法摘要进入发布目录名。
// INV-02 摘要统一转小写：守住位置 归一赋值；改错故障 大小写不同被判为不同发布。
// INV-03 内容摘要覆盖整棵目录：守住位置 哈希遍历；改错故障 文件被换掉仍能复用。
// INV-04 完整性文件自身不参与哈希：守住位置 跳过判断；改错故障 写入完整性后摘要自变。
// INV-05 遍历顺序稳定：守住位置 排序比较；改错故障 同内容算出不同摘要。
// INV-06 目录项参与哈希：守住位置 更新调用；改错故障 空目录被忽略导致碰撞。
// INV-07 文件权限位参与哈希：守住位置 更新内容；改错故障 放宽权限后仍判为一致。
// INV-08 非普通文件直接拒绝：守住位置 类型判断；改错故障 设备文件混入发布目录。
// INV-09 路径分隔符统一为正斜杠：守住位置 替换调用；改错故障 跨平台摘要不一致。
// INV-10 完整性文件以独占权限写入：守住位置 写入选项；改错故障 其他用户可篡改记录。
// INV-11 目标已存在时逐项比对：守住位置 复用分支；改错故障 内容不同的发布被静默复用。
// INV-12 目标不是目录时报冲突：守住位置 类型分支；改错故障 覆盖同名普通文件。
// INV-13 清单也要校验目标与版本：守住位置 交叉比较；改错故障 张冠李戴的发布被接受。
// INV-14 冲突错误保留底层原因：守住位置 错误构造；改错故障 排查时看不到具体不一致项。
// INV-15 并发发布只在确实命中时复用：守住位置 二次判断；改错故障 权限错误被当作已存在。
// INV-16 未晋升的临时目录统一清理：守住位置 收尾分支；改错故障 每次重试残留整份发布。
// INV-17 晋升标记只在改名成功后置位：守住位置 赋值时机；改错故障 复用路径误删目标目录。
// INV-18 对外只暴露晋升入口：守住位置 导出清单；改错故障 调用方可跳过完整性校验。
//
// 模块职责：把临时发布的目录校验完整性后晋升为不可变发布目录。
// 状态所有权：无模块级状态；完整性记录与临时目录都局限在单次调用内。
// 阅读顺序：先看目录哈希，再看既有发布校验，最后看晋升流程。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serverRuntimeManifestSchema, type ServerTarget } from "./manifest.js";

export interface ReleaseIdentity {
  archiveSha256: string;
  target: ServerTarget;
  version: string;
}

interface ReleaseIntegrity extends ReleaseIdentity {
  contentSha256: string;
}

export const RELEASE_INTEGRITY_FILE = ".release-integrity.json";

// readdir 结果按 entry.name 排序，保证哈希遍历顺序稳定
// relativePath === RELEASE_INTEGRITY_FILE 时 continue，自身不参与哈希
// directory 写路径、file 写路径加 stat.mode & 0o777
// entry.isFile() 为假即抛 Unsupported release entry
async function hashReleaseTree(root: string, relativeRoot = ""): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (relativeDirectory: string): Promise<void> => {
    const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = join(relativeDirectory, entry.name);
      if (relativePath === RELEASE_INTEGRITY_FILE) continue;
      const normalizedPath = relativePath.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        hash.update(`directory\0${normalizedPath}\0`);
        await visit(relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported release entry: ${normalizedPath}`);
      const fileStat = await stat(join(root, relativePath));
      hash.update(`file\0${normalizedPath}\0${fileStat.mode & 0o777}\0`);
      for await (const chunk of createReadStream(join(root, relativePath))) hash.update(chunk);
    }
  };
  await visit(relativeRoot);
  return hash.digest("hex");
}

// 先读 .release-integrity.json 与 manifest.json
// hashReleaseTree(releaseDir) 重算 contentSha256
// integrity 与 expected 逐字段比对，含 contentSha256
// 冲突包成 Error 时保留 error.message 作为原因
async function assertExistingReleaseMatches(
  releaseDir: string,
  expected: ReleaseIntegrity,
): Promise<void> {
  try {
    const integrity = JSON.parse(
      await readFile(join(releaseDir, RELEASE_INTEGRITY_FILE), "utf8"),
    ) as Partial<ReleaseIntegrity>;
    const runtimeManifest = serverRuntimeManifestSchema.parse(
      JSON.parse(await readFile(join(releaseDir, "manifest.json"), "utf8")),
    );
    const actualContentSha256 = await hashReleaseTree(releaseDir);
    if (
      integrity.archiveSha256 !== expected.archiveSha256 ||
      integrity.contentSha256 !== expected.contentSha256 ||
      integrity.contentSha256 !== actualContentSha256 ||
      integrity.target !== expected.target ||
      integrity.version !== expected.version ||
      runtimeManifest.target !== expected.target ||
      runtimeManifest.appVersion !== expected.version
    ) {
      throw new Error("identity mismatch");
    }
  } catch (error) {
    throw new Error(
      `Existing immutable release conflict at ${releaseDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function existingPathKind(path: string): Promise<"directory" | "other" | null> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// 先按归档摘要格式校验 archiveSha256
// 未晋升的 incomingDir 在失败路径统一清理
// 并发发布仅在 identity 命中已有 release 时复用
export async function promoteImmutableReleaseDirectory(options: {
  incomingDir: string;
  targetDir: string;
  identity: ReleaseIdentity;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/iu.test(options.identity.archiveSha256)) {
    throw new Error(`Invalid release archive SHA-256: ${options.identity.archiveSha256}`);
  }
  const integrity: ReleaseIntegrity = {
    ...options.identity,
    archiveSha256: options.identity.archiveSha256.toLowerCase(),
    contentSha256: await hashReleaseTree(options.incomingDir),
  };
  await writeFile(
    join(options.incomingDir, RELEASE_INTEGRITY_FILE),
    `${JSON.stringify(integrity, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  let promoted = false;
  try {
    const existingKind = await existingPathKind(options.targetDir);
    if (existingKind !== null) {
      if (existingKind !== "directory") {
        throw new Error(`Existing immutable release conflict at ${options.targetDir}: target is not a directory`);
      }
      await assertExistingReleaseMatches(options.targetDir, integrity);
      return;
    }
    try {
      await rename(options.incomingDir, options.targetDir);
      promoted = true;
    } catch (error) {
      // 并发发布可能都先看到目标不存在。rename 失败后仅当目标确实已由
      // 另一发布者创建时才进入校验复用；Windows 的普通 EPERM 不能伪装成命中。
      const racedKind = await existingPathKind(options.targetDir);
      if (racedKind !== "directory") throw error;
      await assertExistingReleaseMatches(options.targetDir, integrity);
    }
  } finally {
    // 复用和失败都不会消费 incoming，必须统一清理，避免每次重试留下完整 release。
    if (!promoted) await rm(options.incomingDir, { recursive: true, force: true });
  }
}
