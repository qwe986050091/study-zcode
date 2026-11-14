// 结果物字节的两个读取实现：本地 workspace 与远端 workspace（SSH/WSL/Docker）。
// 边界职责：把「会话里的 ref 字符串」变成「已验证在工作区内的真实路径 + 字节」，
// 其余逻辑（去重、预算、manifest）都在上层，这里不感知分享协议。
// INV-01：返回的 canonicalPath 必须已解析符号链接，且仍是 workspace 的后代（守住它：realpath/resolvePath + 边界判断）。
// INV-02：读取前后文件必须未变（size/mtime 或 stat 双读），否则返回 changed 语义而不是旧字节（守住它：read 的二次 stat）。
// INV-03：只有 ENOENT/ENOTDIR/EISDIR 允许降级为 warning，其它 IO 错误必须上抛（守住它：isSkippableArtifactReadError）。
// 改错后果：越界读取本机任意文件（路径穿越）、把被改写的文件当原始内容分享、或静默丢掉结果物。
// [权衡] 远端与本地各写一份而不抽公共流程：远端走 fileService RPC、本地走 fs handle，
// 把两者强行合并会让每个步骤都多一层条件分支，反而更难审计边界检查是否遗漏。
import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

import type { IFileService } from "#src/file/file.js";

import { ConversationShareServiceError } from "./conversationShare.js";

// maxBytes 由服务端能力决定，必须由调用方传入而不是读常量：
// 不同环境的上限不同，写死会让客户端与服务端对「多大算超限」产生分歧。
export interface ConversationShareArtifactReadInput {
  workspacePath: string;
  ref: string;
  maxBytes: number;
}

// canonicalPath 用于跨来源去重：同一文件被多个候选引用时只上传一份，
// 因此它必须是解析后的真实路径，不能是用户写的原始 ref。
export interface ConversationShareMaterializedArtifact {
  bytes: Uint8Array;
  canonicalPath: string;
}

// mtimeMs 可选：远端 fileService 未必提供，缺省时上层退化为只比对 size。
export interface ConversationShareArtifactStat {
  canonicalPath: string;
  size: number;
  mtimeMs?: number;
}

// stat 是可选能力：预检用它判断「卡片是否还存在」，但历史上存在未实现的运行时，
// 上层必须能在 stat 缺席时用 read 兜底，所以这里是可选方法而不是必选。
// read 是必选：没有字节就无法分享，缺失时报错比返回空更诚实。
export interface ConversationShareArtifactSource {
// 返回 canonicalPath 而不是原始 ref，是为了让调用方用同一 key 做跨候选去重。
  read(input: ConversationShareArtifactReadInput): Promise<ConversationShareMaterializedArtifact>;
  stat?(
    input: Omit<ConversationShareArtifactReadInput, "maxBytes">,
  ): Promise<ConversationShareArtifactStat>;
}

// 远端按块读而不是一次性拉全文件：RPC 单帧有大小上限，且大文件一次性分配会
// 在 Host 侧形成瞬时内存峰值。512KB 是吞吐与内存的折中。
// 三个可跳过 errno 覆盖「文件不存在 / 路径中间是文件 / 目标是目录」，
// 这三种都表示内容已不可得，属于可由用户感知并接受的降级。
const REMOTE_READ_CHUNK_BYTES = 512 * 1024;
const SKIPPABLE_ARTIFACT_READ_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

// 只认白名单 errno：权限不足（EACCES）、连接断开等必须继续上抛，
// 否则发布成功但结果物缺失，用户以为分享完整。
function isSkippableArtifactReadError(error: unknown): boolean {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof errno === "string" && SKIPPABLE_ARTIFACT_READ_ERRNOS.has(errno);
}

/**
 * 兜底读失败统一带上 artifact_read_failed 与底层 errno：
 * 调用方据此把「正文引用的文件已不存在」降级为非阻断跳过，而不是打死整次发布。
 * errno 走已白名单化的 diagnostics，路径不进错误载荷。
 */
// 把 errno 塞进 diagnostics 而不是拼进 message：message 会进日志和 UI，
// 而 errno 属于结构化诊断，走白名单字段才能跨 RPC 且不带路径。
// reasonCode 固定 artifact_read_failed，让上层按「可跳过」而不是「契约错误」处理。
function unreadableArtifactError(message: string, cause: unknown): ConversationShareServiceError {
  const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new ConversationShareServiceError("invalid_conversation", message, {
    reasonCode: "artifact_read_failed",
    cause,
    ...(typeof errno === "string" ? { diagnostics: { errno } } : {}),
  });
}

// 远端 workspace 可能是 Linux（SSH/WSL）或 Windows（WSL 反连、Docker on Windows），
// 路径语义必须按被操作机器而不是本机判断，否则盘符路径会被 posix 逻辑拼成相对路径。
// 判定依据是 workspacePath 而不是 ref：workspace 决定远端平台，ref 只是其下的相对段。
function remotePathApi(path: string): typeof posix | typeof win32 {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") ? win32 : posix;
}

// 必须用远端平台自己的 relative/isAbsolute：在 Windows 语义下 `C:foo` 是相对路径，
// 用 posix 的 startsWith("..") 判断会漏掉跨盘符访问。
// 空串表示同一路径，视为在内；这是允许分享 workspace 根下文件的唯一入口。
function isRemoteInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const pathApi = remotePathApi(workspacePath);
  const relativePath = pathApi.relative(workspacePath, targetPath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath))
  );
}

/**
 * SSH/WSL/Docker 使用远端 fileService 完成 realpath/stat/range read；JWT 和 HTTP 上传仍留在 Desktop Host。
 */
// 远端实现只借用 fileService 的三个只读方法：resolvePath 做 realpath，stat 取元数据，
// readFileRange 分块读。JWT 与 HTTP 上传仍留在 Desktop Host，远端只提供字节。
// [权衡] 不做 write：远端 workspace 的写入由导入流程在本地副本完成，
// 若这里开放 write，就等于把「分享读取」通道升级成任意写通道。
export function createRemoteConversationShareArtifactSource(
  fileService: Pick<IFileService, "readFileRange" | "resolvePath" | "stat">,
): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }
      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
// stat 作用在 realpath 之后的路径上，避免符号链接指向 workspace 外部时被漏检。
        const artifactStat = await fileService.stat({ path: artifactRealPath });
// 目录/设备/管道都不可分享；size 缺失说明远端实现不完整，同样按不可读处理。
// 这里伪造 ENOTDIR 是刻意的：让上层统一走「路径不是文件」的降级分支。
        if (artifactStat.type !== "file" || artifactStat.size === undefined) {
          throw unreadableArtifactError("Conversation artifact source is not a readable file", {
            code: "ENOTDIR",
          });
        }
        return {
          canonicalPath: artifactRealPath,
          size: artifactStat.size,
          ...(artifactStat.mtimeMs === undefined ? {} : { mtimeMs: artifactStat.mtimeMs }),
        };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }

      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }

// 先取一次 stat 作为预算与预期长度；这一步同时承担「文件是否存在」的判断。
        const before = await fileService.stat({ path: artifactRealPath });
// 注意这里不回退成 unreadableArtifactError：文件存在但不是普通文件属于内容问题，
// 应作为 invalid_conversation 上报，而不是可跳过的缺失。
        if (before.type !== "file" || before.size === undefined) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact source is not a readable file",
          );
        }
// 在读之前就按 stat 大小拦截：先读后判会让一次超限请求消耗完整的内存与带宽。
        if (before.size > input.maxBytes) {
          throw new ConversationShareServiceError(
            "limit_exceeded",
            "Conversation artifact exceeds the byte limit",
          );
        }

// 按 stat 大小一次性分配，随后按块填充；若文件在读取期间变长，
// 下面的越界检查会把它识别为 changed，而不是静默截断。
        const bytes = new Uint8Array(before.size);
        let offset = 0;
// 循环条件用 stat 得到的长度而非「读到空为止」：后者无法区分 EOF 与瞬时短读，
// 前者让「提前结束」成为可检测的异常（见 chunk.byteLength === 0 分支）。
// 每块长度取 min(块上限, 剩余)，保证最后一块不会超过预期总长。
        while (offset < before.size) {
          const chunk = await fileService.readFileRange({
            path: artifactRealPath,
            offset,
            length: Math.min(REMOTE_READ_CHUNK_BYTES, before.size - offset),
          });
// 还没读满预期长度却返回空块：说明文件被截断或远端实现异常。
// [失败路径] 直接失败而不是 break：静默接受会分享一个长度对不上的字节串，
// 后续 sha256 校验才失败，错误会指向「完整性」而不是真正的「读取中断」。
          if (chunk.byteLength === 0) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact ended during remote staging",
            );
          }
// 越界说明文件在读取期间变长；继续写会覆盖 Uint8Array 之外的位置（静默丢弃），
// 于是算出的字节与 stat 声明的长度不一致，必须在写入前拦下。
          if (offset + chunk.byteLength > before.size) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact changed during remote staging",
            );
          }
// 用固定偏移写入预分配数组，避免 concat 产生中间数组复制。
          bytes.set(chunk, offset);
// 以实际读到的字节推进，而不是以请求长度推进：远端可能短读，按请求长度推进会越界。
          offset += chunk.byteLength;
        }

// 二次 stat 是远端唯一的「读期间未变更」证据：没有 fstat 句柄可用，
// 因此只能比对 size 与 mtime。
// [权衡] 这不能完全排除内容被原地改写且 mtime 未变的情况，但成本只有一次 RPC；
// 更强的保证要远端提供哈希或在同一句柄上读，超出当前协议。
        const after = await fileService.stat({ path: artifactRealPath });
        if (
          after.type !== "file" ||
          after.size !== before.size ||
          (before.mtimeMs !== undefined && after.mtimeMs !== before.mtimeMs)
        ) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact changed during remote staging",
          );
        }
        return { bytes, canonicalPath: artifactRealPath };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // 只有明确的“文件不存在/路径不是文件”才允许发现流程降级为 warning。
        // 远端连接断开、权限不足等错误必须继续抛出，避免发布成功却静默丢失结果物。
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
  };
}

// 本地版本直接用 node:path 的 relative/isAbsolute；调用前两边都必须是 realpath 结果。
function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relativePath = relative(workspacePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

// 本地实现全程用文件句柄而不是路径二次打开：句柄上的 stat/read 指向同一 inode，
// 可以消除「检查路径后再打开时被替换成符号链接」的竞态。
// [资源] 每个分支都必须在 finally 里 close，否则大量候选文件会耗尽句柄。
export function createLocalConversationShareArtifactSource(): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }
      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw unreadableArtifactError("Conversation artifact source is not a file", {
              code: "ENOTDIR",
            });
          }
          return {
            canonicalPath: artifactRealPath,
            size: artifactStat.size,
            mtimeMs: artifactStat.mtimeMs,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }

      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        // artifact Row 的 ref 来自会话数据，不能因为当前仅支持本地发布就默认可信；
        // 必须在跟随符号链接后再次验证 workspace 边界，避免分享读取任意本机文件。
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact source is not a file",
            );
          }
// 句柄 stat 之后立刻判上限：此时还没分配缓冲区，拒绝的成本最低。
          if (artifactStat.size > input.maxBytes) {
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
            );
          }
          // 后端能力上限可能远大于当前文件，按 maxBytes 分配会让小文件也占用大块内存；
          // 只按 stat 大小多读 1 字节，仍能识别 stat/read 间的文件增长。
// 只按 stat 大小加 1 字节分配，不按 maxBytes 分配：maxBytes 可能远大于文件，
// 按它分配会让每个小文件都占一大块内存。
// 多出的 1 字节用来检测「stat 之后文件变长」——读到它说明内容已变。
// [权衡] allocUnsafe 省掉清零开销，但必须保证未写区域不会外泄：
// 返回时只切到 bytesRead，未读部分不会进入结果。
          const buffer = Buffer.allocUnsafe(artifactStat.size + 1);
          let bytesRead = 0;
// 读到缓冲满或 EOF；Node 的 read 允许短读，所以必须循环而不是只调一次。
          while (bytesRead < buffer.byteLength) {
            const result = await handle.read(
              buffer,
              bytesRead,
              buffer.byteLength - bytesRead,
              bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
// 责任划分：stat 已判过一次，这里再判是因为文件可能在 stat 之后增长。
// 超限时抛出 limit_exceeded，上层会作为确定阻断而不是可跳过 warning。
          if (bytesRead > input.maxBytes) {
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
            );
          }
          return {
// subarray 是零拷贝视图，但包成 Uint8Array 的对象仍引用整块 buffer；
// 这里不复制是刻意为之：buffer 已按文件实际大小分配，开销可忽略。
            bytes: new Uint8Array(buffer.subarray(0, bytesRead)),
            canonicalPath: artifactRealPath,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // 只有明确的“文件不存在/路径不是文件”才允许发现流程降级为 warning。
        // 权限不足或其它 IO 错误需要阻断发布，不能伪装成可跳过的缺失文件。
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
  };
}
