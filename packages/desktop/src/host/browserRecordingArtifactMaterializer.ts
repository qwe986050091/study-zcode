// 浏览器录制产物（WebM）的落盘 / 上传。
//
// 职责：把 main 进程产出的短期 WebM 按「当前 workspace authority」落到最终位置：
// 本地走同目录 staging + rename，远端走 backend.upload，避免让远端 Agent 依赖 Desktop 临时路径。
// 输入输出：输入 artifact、localPath、outputPath、workspacePath、可选 remoteSessionId/backend；
// 输出新的 artifact（path 替换为最终绝对路径 / 远端 posix 路径）。
// 副作用：本地会 mkdir / copy / rm / rename；远端会上传文件。
// 失败语义：路径逃逸 workspace、非 .webm 后缀、远端缺 backend 均抛错；本地失败时 finally
// 清理 staging，不留半成品；远端失败不清理源临时文件（由上传方负责）。

import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { IRemoteBackend } from "@zcode/server/remote";
import type { BrowserRecordingArtifact } from "@zcode/shared";

// 本地 workspace 内的输出路径校验：必须是 root 之下、且不以目录本身为终点。
// 用 relative 而非字符串前缀判断，可拦住 workspace-evil 之类的同前缀逃逸；
// resolve(root, relation) !== target 再兜一层符号/大小写归一后的偏差。
// 拒绝空 relation（即 outputPath 指向 workspace 根目录本身）和 .webm 之外的后缀。
// 失败语义：抛错，调用方按录制失败处理。
function resolveWorkspaceRecordingPath(workspacePath: string, outputPath: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, outputPath);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || resolve(root, relation) !== target) {
    throw new Error("recording outputPath must stay inside the workspace");
  }
  if (!target.toLowerCase().endsWith(".webm")) {
    throw new Error("recording outputPath must end with .webm");
  }
  return target;
}

// 落盘 / 上传录制产物，返回更新 path 后的 artifact。
// 远端分支先把 outputPath 反斜杠统一成 /，再按 segment 级别拒绝 ".."/"."/空段与绝对路径，
// 因为 posix.normalize 会削弱 .. 的检测（normalize 后再判 ../ 只能拦住部分形式）。
// 本地分支先写 staging 再 rm 目标再 rename：Windows 上 rename 无法原子覆盖已存在文件，
// 因此必须显式删除旧 WebM（force 容忍不存在）。
// 维护的不变量：返回的 artifact 路径始终位于 workspace 内；失败时 staging 不残留。
/**
 * main 只返回短期 WebM；Host 按当前 workspace authority 落盘。本地使用同目录 rename，远端
 * 复用已有 backend.upload，避免让远端 Agent 依赖 Desktop 临时路径。
 */
export async function materializeBrowserRecordingArtifact(input: {
  artifact: BrowserRecordingArtifact;
  localPath: string;
  outputPath: string;
  workspacePath: string;
  remoteSessionId?: string;
  remoteBackend?: Pick<IRemoteBackend, "upload">;
}): Promise<BrowserRecordingArtifact> {
  if (input.remoteSessionId) {
    if (!input.remoteBackend) {
      throw new Error("remote Browser recording materialization is unavailable for this session");
    }
    const normalizedWorkspace = posix.normalize(input.workspacePath.replace(/\\/gu, "/"));
    const rawOutputSegments = input.outputPath.split(/[\\/]+/u);
    const normalizedOutput = posix.normalize(input.outputPath.replace(/\\/gu, "/"));
    if (
      rawOutputSegments.some((segment) => segment === ".." || segment === "." || !segment) ||
      normalizedOutput === ".." ||
      normalizedOutput.startsWith("../") ||
      posix.isAbsolute(normalizedOutput)
    ) {
      throw new Error("recording outputPath must stay inside the remote workspace");
    }
    if (!normalizedOutput.toLowerCase().endsWith(".webm")) {
      throw new Error("recording outputPath must end with .webm");
    }
    const remoteTargetPath = posix.join(normalizedWorkspace, normalizedOutput);
    await input.remoteBackend.upload(input.localPath, remoteTargetPath);
    return { ...input.artifact, path: remoteTargetPath };
  }

  const targetPath = resolveWorkspaceRecordingPath(input.workspacePath, input.outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const stagingPath = `${targetPath}.zcode-recording-${randomUUID()}.tmp`;
  try {
    await copyFile(input.localPath, stagingPath);
    // Windows 不能用 rename 原子覆盖已有文件；先移除明确的目标 WebM，再提交 staging 文件。
    await rm(targetPath, { force: true });
    await rename(stagingPath, targetPath);
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
  return { ...input.artifact, path: targetPath };
}
