// INV-01 无附件直接原样返回：守住位置 空值判断；改错故障 空数组也触发远端连接。
// INV-02 无本地路径的附件原样保留：守住位置 取值判断；改错故障 远端已有引用被清空。
// INV-03 已在根目录下的路径不再上传：守住位置 前缀判断；改错故障 重复上传覆盖同名文件。
// INV-04 已在远端根下的路径直接放行：守住位置 二次判断；改错故障 远端路径被再拼一层。
// INV-05 根目录只解析一次：守住位置 承诺缓存；改错故障 每个附件都起一次远端命令。
// INV-06 远端 HOME 必须是绝对路径：守住位置 起始字符判断；改错故障 相对路径落到未知目录。
// INV-07 目录逐层收紧权限：守住位置 私有目录列表；改错故障 中间目录对他人可读。
// INV-08 文件权限固定为仅属主可读写：守住位置 权限常数；改错故障 剪贴板内容被同机读取。
// INV-09 上传失败尽力回收已落盘文件：守住位置 捕获分支；改错故障 失败重试不断占用空间。
// INV-10 失败错误带文件名：守住位置 错误消息；改错故障 多附件时无法定位是哪个失败。
// INV-11 原始错误保留为原因：守住位置 错误构造；改错故障 底层退出码与堆栈丢失。
// INV-12 新数组只在确有改写时生成：守住位置 变更标记；改错故障 引用变化触发下游重算。
// INV-13 路径替换按长度倒序：守住位置 排序比较；改错故障 短路径是长路径前缀时二次替换。
// INV-14 清理前校验在私有根内：守住位置 根判断；改错故障 误删用户目录文件。
// INV-15 目录非空时忽略删除失败：守住位置 命令尾兜底；改错故障 非空目录导致清理报错。
// INV-16 历史清扫按分钟阈值：守住位置 下限钳制；改错故障 零阈值删掉刚写入的附件。
// INV-17 路径各段做白名单清洗：守住位置 清洗函数；改错故障 异常字符破坏 shell 引号。
// INV-18 文件名只取末段并限长：守住位置 切片与回退；改错故障 超长路径超出文件系统上限。
//
// 模块职责：把 Host 本地附件物化到远端私有目录，并改写正文中的路径引用。
// 状态所有权：无模块级状态；根目录与上传计数都局限在单次调用内。
// 阅读顺序：先看物化主流程，再看清理入口，最后看路径构造与命令封装。
// 远端 prompt 附件的物化（materialize）与清理工具。
//
// 职责边界：
// - 把 Host 侧本地附件上传到远端 HOME 下的私有目录，并把 content 中的本地路径改写为远端路径；
// - 所有远端写路径都限定在附件私有根目录内，清理接口也先做根目录校验，防止误删用户文件；
// - 只做文件层面的物化，不感知 attachment 生命周期（那是 promptAttachmentTransferService 的事）。
//
// 安全口径：
// - 附件可能来自剪贴板/图片/本地文件，一律不落公共 /tmp，目录用 chmod 700、文件用 chmod 600；
// - 远端 HOME 必须是绝对路径，否则拒绝物化；
// - 上传成功但后续步骤失败时，抛错前尽力删除已落盘文件，避免占用远端空间。

import type { IRemoteBackend, RemoteUploadOptions } from "@zcode/server/remote";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";
import type { TraceId, ZCodePromptAttachment } from "@zcode/shared";
import { randomUUID } from "node:crypto";

/** 远端附件根目录的展示口径（相对 HOME）；真实路径由 resolveRemotePromptAttachmentRoot 解析。 */
export const REMOTE_PROMPT_ATTACHMENT_ROOT = "~/.zcode/tmp/prompt-attachments";
// 远端附件私有根目录相对 HOME 的固定位置；与 REMOTE_PROMPT_ATTACHMENT_ROOT 必须保持同一路径。
const REMOTE_PROMPT_ATTACHMENT_RELATIVE_ROOT = ".zcode/tmp/prompt-attachments";

/** 物化输入：content 与 attachments 一起改写；traceId 用于生成远端目录名（可诊断、可隔离）。 */
export interface RemotePromptAttachmentMaterializeInput {
  taskId?: string;
  content: string;
  traceId: TraceId | string;
  attachments?: ZCodePromptAttachment[];
}

/**
 * 物化结果：uploadedCount=0 表示全部附件都已在合法位置（无需上传），此时 attachments 原样返回；
 * 只要有附件被改写，attachments 就换成新数组，未改写的条目仍保留原对象。
 */
export interface RemotePromptAttachmentMaterializeResult {
  content: string;
  attachments?: ZCodePromptAttachment[];
  uploadedCount: number;
}

/**
 * 把 Host 本地附件物化到远端，并同步改写 content 中的路径引用。
 * 输入：附件列表 + uploadOptions（可携带取消信号与进度回调）。
 * 输出：改写后的 content/attachments 与本次实际上传数量。
 * 副作用：远端 mkdir/chmod/upload；会对已落盘文件做权限收紧。
 * 失败语义：任一附件上传或权限设置失败即整体抛错（错误信息带文件名），并尽力删除该附件；
 * 已检查过「无需上传」的附件（本地私有目录或已在远端根目录下）直接放行，不重复上传。
 * 维护的不变量：改写顺序按原路径长度倒序替换，避免短路径是长路径前缀时出现二次替换。
 */
// attachments 为空或长度为 0 时原样返回，uploadedCount 置 0。
// 没有 localPath 的条目原样保留。
// 已在私有根下的路径由 isRemotePromptAttachmentPath() 判定后跳过上传。
// resolveRemotePromptAttachmentRoot() 每次调用只解析一次远端根。
// 失败时先删除本次已落盘文件，再把错误抛出。
export async function materializeRemotePromptAttachments(
  input: RemotePromptAttachmentMaterializeInput,
  options: {
    backend: Pick<IRemoteBackend, "exec" | "upload">;
    uploadOptions?: RemoteUploadOptions;
  },
): Promise<RemotePromptAttachmentMaterializeResult> {
  const attachments = input.attachments;
  if (!attachments || attachments.length === 0) {
    return { ...input, uploadedCount: 0 };
  }

  const replacements = new Map<string, string>();
  const nextAttachments: ZCodePromptAttachment[] = [];
  let remoteRootPromise: Promise<string> | undefined;
  let uploadedCount = 0;
  let changed = false;

  const getRemoteRoot = () => {
    remoteRootPromise ??= resolveRemotePromptAttachmentRoot(options.backend);
    return remoteRootPromise;
  };

  for (const [index, attachment] of attachments.entries()) {
    const localPath = getAttachmentLocalPath(attachment);
    if (!localPath) {
      nextAttachments.push(attachment);
      continue;
    }

    if (isPathInRoot(localPath, REMOTE_PROMPT_ATTACHMENT_ROOT)) {
      nextAttachments.push(attachment);
      continue;
    }

    const remoteRoot = await getRemoteRoot();
    if (isRemotePromptAttachmentPath(localPath, remoteRoot)) {
      nextAttachments.push(attachment);
      continue;
    }

    const remotePath = buildRemotePromptAttachmentPath({
      filename: attachment.filename,
      index,
      root: remoteRoot,
      traceId: input.traceId,
    });

    try {
      await ensureRemotePromptAttachmentDirectory(options.backend, remotePath, remoteRoot);
      if (options.uploadOptions) {
        await options.backend.upload(localPath, remotePath, options.uploadOptions);
      } else {
        await options.backend.upload(localPath, remotePath);
      }
      await lockDownRemotePromptAttachmentFile(options.backend, remotePath);
    } catch (error) {
      // 上传成功但 chmod/后续提交失败时，远端文件已经存在；若只抛错会一直
      // 占用用户空间并绕过 renderer 删除清理。这里在原始失败边界内尽力回收。
      await cleanupRemotePromptAttachment(options.backend, remotePath).catch(() => {});
      throw new Error(`远端附件上传失败：${attachment.filename}`, {
        cause: error,
      });
    }

    // remote workspace 的 agent 只能读取远端文件系统；host localPath 必须先上传并改写。
    nextAttachments.push({
      ...attachment,
      localPath: remotePath,
    } as ZCodePromptAttachment);
    replacements.set(localPath, remotePath);
    uploadedCount += 1;
    changed = true;
  }

  return {
    content: replaceContentPaths(input.content, replacements),
    attachments: changed ? nextAttachments : attachments,
    uploadedCount,
  };
}

// 删除单个远端暂存文件：先校验路径在私有根目录内，再 rm 文件并尽力 rmdir 空目录。
// 失败语义：删除命令本身失败会抛错；目录非空时 rmdir 被忽略（|| true），不影响结果。
/** eager staging 删除入口；只允许操作附件私有根目录下的路径。 */
// cleanupRemotePromptAttachment() 只处理私有根下的路径。
// rm 之后用 rmdir 尝试清理空目录。
// 目录非空时 rmdir 失败被 || true 忽略。
// 清理入口只看路径，不感知会话归属。
export async function cleanupRemotePromptAttachment(
  backend: Pick<IRemoteBackend, "exec">,
  remotePath: string,
): Promise<void> {
  const root = await resolveRemotePromptAttachmentRoot(backend);
  if (!isRemotePromptAttachmentPath(remotePath, root)) return;
  const remoteDir = remoteDirname(remotePath);
  await waitForRemoteCommand(
    backend,
    `rm -f ${quotePosixPathArg(remotePath)} && rmdir ${quotePosixPathArg(remoteDir)} 2>/dev/null || true`,
  );
}

// 清扫无人认领的历史暂存：按文件 mtime 超过 olderThanMinutes（默认 24h）删除，再清理空目录。
// 这是 Host 重建后的兜底路径，因此只看时间不看会话归属；olderThanMinutes 最小按 1 分钟处理。
/** host 重建后回收无 renderer 持有者的历史暂存附件。 */
export async function cleanupStaleRemotePromptAttachments(
  backend: Pick<IRemoteBackend, "exec">,
  olderThanMinutes = 24 * 60,
): Promise<void> {
  const root = await resolveRemotePromptAttachmentRoot(backend);
  await waitForRemoteCommand(
    backend,
    `if [ -d ${quotePosixPathArg(root)} ]; then find ${quotePosixPathArg(root)} -type f -mmin +${Math.max(1, Math.floor(olderThanMinutes))} -delete; find ${quotePosixPathArg(root)} -mindepth 1 -depth -type d -empty -delete; fi`,
  );
}

/**
 * 构造远端附件目标路径：root/trace/nonce/序号-文件名。
 * 各段都做字符白名单清洗并限长，保证路径不会逃出根目录、也不会因异常字符导致 shell 引号问题；
 * index 从 1 开始补齐两位，保证同一 trace 内附件顺序稳定。
 */
// trace 标识作为第一级目录。
// nonce 随机段隔离同一 trace 的不同批次。
// index 从 1 开始 padStart(2, "0") 补齐两位。
// 每一段都过 sanitizePathSegment() 白名单清洗并限长。
export function buildRemotePromptAttachmentPath(params: {
  filename: string;
  index: number;
  nonce?: string;
  root?: string;
  traceId: TraceId | string;
}): string {
  const traceSegment = sanitizePathSegment(String(params.traceId)).slice(0, 80) || "trace";
  const nonceSegment = sanitizePathSegment(params.nonce ?? createAttachmentNonce()).slice(0, 64);
  const filename = sanitizePathSegment(basenameFromPathLike(params.filename)) || "attachment";
  const indexSegment = String(params.index + 1).padStart(2, "0");
  const root = params.root ?? REMOTE_PROMPT_ATTACHMENT_ROOT;
  return `${root}/${traceSegment}/${nonceSegment}/${indexSegment}-${filename.slice(0, 160)}`;
}

async function ensureRemotePromptAttachmentDirectory(
  backend: Pick<IRemoteBackend, "exec">,
  remotePath: string,
  root: string,
): Promise<void> {
  const remoteDir = remoteDirname(remotePath);
  const privateDirs = collectRemotePromptAttachmentPrivateDirs(remoteDir, root);
  // prompt 附件可能包含剪贴板、图片和本地文件内容，不能落在公共 /tmp；远端物化前先创建用户私有目录并收紧权限。
  const command = [
    `mkdir -p ${quotePosixPathArg(remoteDir)}`,
    `command chmod 700 ${privateDirs.map((dir) => quotePosixPathArg(dir)).join(" ")}`,
  ].join(" && ");
  await waitForRemoteCommand(backend, command);
}

async function lockDownRemotePromptAttachmentFile(
  backend: Pick<IRemoteBackend, "exec">,
  remotePath: string,
): Promise<void> {
  await waitForRemoteCommand(backend, `command chmod 600 ${quotePosixPathArg(remotePath)}`);
}

async function resolveRemotePromptAttachmentRoot(
  backend: Pick<IRemoteBackend, "exec">,
): Promise<string> {
  const homeDir = await readRemoteCommandStdout(backend, 'printf %s "$HOME"');
  const normalizedHome = homeDir.trim().replace(/\/+$/u, "");
  if (!normalizedHome.startsWith("/")) {
    throw new Error("remote HOME is not an absolute path");
  }
  return `${normalizedHome}/${REMOTE_PROMPT_ATTACHMENT_RELATIVE_ROOT}`;
}

async function readRemoteCommandStdout(
  backend: Pick<IRemoteBackend, "exec">,
  command: string,
): Promise<string> {
  const stream = await backend.exec(command);
  let stdoutText = "";
  let stderrText = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    stdoutText += chunk.toString();
  });
  stream.stderr.on("data", (chunk: Buffer | string) => {
    stderrText += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    stream.onClose((code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `remote command failed with exit code ${code}: ${command}${
            stderrText ? `: ${stderrText}` : ""
          }`,
        ),
      );
    });
  });
  return stdoutText;
}

async function waitForRemoteCommand(
  backend: Pick<IRemoteBackend, "exec">,
  command: string,
): Promise<void> {
  const stream = await backend.exec(command);
  await new Promise<void>((resolve, reject) => {
    stream.onClose((code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`remote command failed with exit code ${code}: ${command}`));
    });
  });
}

function getAttachmentLocalPath(attachment: ZCodePromptAttachment): string | undefined {
  const localPath = attachment.localPath?.trim();
  return localPath ? attachment.localPath : undefined;
}

function isRemotePromptAttachmentPath(path: string, remoteRoot: string): boolean {
  return isPathInRoot(path, REMOTE_PROMPT_ATTACHMENT_ROOT) || isPathInRoot(path, remoteRoot);
}

function isPathInRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function remoteDirname(remotePath: string): string {
  const slashIndex = remotePath.lastIndexOf("/");
  return slashIndex > 0 ? remotePath.slice(0, slashIndex) : REMOTE_PROMPT_ATTACHMENT_ROOT;
}

function collectRemotePromptAttachmentPrivateDirs(remoteDir: string, root: string): string[] {
  const relativeDir = remoteDir.startsWith(`${root}/`) ? remoteDir.slice(root.length + 1) : "";
  const segments = relativeDir.split("/").filter(Boolean);
  const dirs = [root];
  let current = root;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}

function createAttachmentNonce(): string {
  return randomUUID();
}

function replaceContentPaths(content: string, replacements: Map<string, string>): string {
  let next = content;
  const orderedReplacements = [...replacements.entries()].sort(
    ([left], [right]) => right.length - left.length,
  );
  for (const [from, to] of orderedReplacements) {
    next = next.split(from).join(to);
  }
  return next;
}

function basenameFromPathLike(pathLike: string): string {
  const segments = pathLike.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? pathLike;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .replaceAll("\0", "-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return sanitized || "attachment";
}
