import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "#src/memory/memory.js";

// 预览上限固定为 5 MiB：超过该值的文件不进入编辑器预览，避免一次读取占满内存。
// 上限同时用于读取长度与最终 stat 校验，两个来源都未超限才算稳定快照。
const PROJECT_MEMORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

// 从已打开且可验证的句柄读取记忆文件，返回内容与 mtime（毫秒）。
// 调用方提供 validatePath 复用上层允许目录规则；本函数只保证读到同一份普通文件。
// [失败路径] inode/size/mtime 任一变化都抛带错误码的异常：调用方依错误码重读或提示，绝不返回半旧内容。
export async function readProjectMemoryFileFromStableHandle(params: {
  fileName: string;
  filePath: string;
  validatePath: () => Promise<void>;
}): Promise<{ content: string; updatedAt: number }> {
// 先用 lstat 拒绝符号链接与非常规文件，避免后续 open 跟随链接指向外部路径。
// bigint 统计量用于精确比较 inode、大小与纳秒时间戳，避免浮点精度丢失。
  const preOpenStat = await lstat(params.filePath, { bigint: true });
  if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${params.filePath}`);
  }

// O_NOFOLLOW 在部分平台缺失，缺失时退回 0 并依赖前置 lstat 与句柄校验。
  const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  // 路径检查后再 readFile(path) 会重新解析路径，可能跟随并发替换的链接读取外部文件。
  // 只读句柄不加锁、不获取所有权；Memory 原子更新可继续 rename，正文始终从已验证句柄读取。
// 只读打开且不加锁：Memory 的原子替换依赖 rename，持有读句柄不会阻塞写入方。
  const handle = await open(params.filePath, constants.O_RDONLY | noFollowFlag);
  try {
// 句柄 stat 反映真正被打开的对象，与路径 lstat 交叉验证可发现打开瞬间的替换。
    const openedStat = await handle.stat({ bigint: true });
// 打开后再校验路径归属，覆盖 lstat 之后路径被换成允许目录外目标的情况。
    await params.validatePath();
// 第三次取路径状态，确认路径当前仍指向与句柄一致的文件。
    const postOpenStat = await lstat(params.filePath, { bigint: true });
    if (
      !openedStat.isFile() ||
      !postOpenStat.isFile() ||
      postOpenStat.isSymbolicLink() ||
      !isSameFileSnapshot(openedStat, preOpenStat) ||
      !isSameFileSnapshot(openedStat, postOpenStat)
    ) {
      throwFileChangedError(params.fileName);
    }

// 先按已打开句柄的大小快速拒绝，避免为超大文件分配缓冲区。
    if (openedStat.size > BigInt(PROJECT_MEMORY_PREVIEW_MAX_BYTES)) {
      throwPreviewLimitError(params.fileName);
    }

// 多读 1 字节用于识别打开后继续增长的文件，真读到超限长度会在下方报错。
    const content = await readBoundedFile(handle, PROJECT_MEMORY_PREVIEW_MAX_BYTES + 1);
// 读取结束后再次 stat 句柄，确认读取期间文件没有被原地改写。
    const finalStat = await handle.stat({ bigint: true });
    // 原子 rename 失败时写入会退化为同 inode 的原地覆盖，仅读取文件身份无法识别内容变化。
// 原子 rename 失败会退化为同 inode 覆盖，必须比较大小与时间戳而不只是 inode。
    if (!isSameFileSnapshot(openedStat, finalStat)) {
      throwFileChangedError(params.fileName);
    }
    if (
      content.length > PROJECT_MEMORY_PREVIEW_MAX_BYTES ||
      finalStat.size > BigInt(PROJECT_MEMORY_PREVIEW_MAX_BYTES)
    ) {
      throwPreviewLimitError(params.fileName);
    }
// 到此处内容长度与最终大小均已通过校验，可以安全返回。
// updatedAt 使用纳秒转毫秒，与文件系统时间精度保持一致。
    return {
      content: content.toString("utf-8"),
      updatedAt: Number(finalStat.mtimeNs) / 1_000_000,
    };
// 无论校验或读取是否失败都关闭句柄，避免预览路径泄漏文件描述符。
  } finally {
    await handle.close();
  }
}

// 快照相等要求设备、inode、大小与 mtime/ctime 全部一致。
// ctime 无法由用户直接设置，能捕捉到同尺寸同 mtime 的原地替换。
function isSameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

// 按块读取直到缓冲区填满或遇到 EOF，避免 readFile 一次性放大读取量。
// 返回的子数组不含分配时的尾部空字节，调用方按实际长度判断是否触顶。
async function readBoundedFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

// 超限错误带稳定 code，上层据此区分文件过大与其他读取失败。
function throwPreviewLimitError(fileName: string): never {
  throw Object.assign(
    new Error(`Project Memory file exceeds the 5 MiB preview limit: ${fileName}`),
    { code: PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE },
  );
}

function throwFileChangedError(fileName: string): never {
  throw Object.assign(new Error(`Project Memory file changed during preview: ${fileName}`), {
    code: PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  });
}
