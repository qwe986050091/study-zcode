// INV-01 空路径直接失败：守住位置 去空判断；改错故障 系统弹窗报无意义错误。
// INV-02 失败返回结构而非抛出：守住位置 返回值形状；改错故障 调用方需要额外捕获。
// INV-03 先规范化再解析真实路径：守住位置 语句顺序；改错故障 符号链接打开错误目标。
// INV-04 真实路径失败仍可回退：守住位置 捕获分支；改错故障 不存在的路径直接放弃。
// INV-05 打开失败记录上下文：守住位置 日志字段；改错故障 只看到一句失败。
// INV-06 成功也记录目标路径：守住位置 信息日志；改错故障 排查时看不到实际打开对象。
// INV-07 错误对象取消息文本：守住位置 类型分支；改错故障 日志出现对象占位。
// INV-08 文件管理器失败同样记日志：守住位置 错误分支；改错故障 目录打不开毫无痕迹。
// INV-09 平台差异集中在一处：守住位置 平台判断；改错故障 苹果系统打开目录行为退化。
// INV-10 截图前校验窗口可用：守住位置 空值与销毁判断；改错故障 窗口关闭后截图崩溃。
// INV-11 截图在进程内完成：守住位置 调用位置；改错故障 需要屏幕录制权限。
// INV-12 文件名自带时间戳：守住位置 模板拼接；改错故障 多次反馈互相覆盖。
// INV-13 文件名替换非法字符：守住位置 正则替换；改错故障 冒号导致写入失败。
// INV-14 响应携带大小与类型：守住位置 返回字段；改错故障 上传端无法预判载荷。
// INV-15 先试直接打开：守住位置 首次调用；改错故障 正常路径多一次兜底。
// INV-16 再试指定应用打开：守住位置 第二次调用；改错故障 不响应默认应用设置。
// INV-17 最后回退通用打开：守住位置 末尾分支；改错故障 前两步失败即报错。
// INV-18 全部失败才告警：守住位置 末尾日志；改错故障 中间步骤失败也刷告警。
//
// 模块职责：主进程的 openFileUrlInDefaultApp / openPathInDefaultApp / openPathInFileManager 与 captureWindowScreenshot 三件公共事。
// 状态所有权：无状态；错误一律经调用方传入的 logger 记录。
// 阅读顺序：先看三个导出函数，再看截图，最后看平台兜底链。
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { shell } from "electron";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

// fileURLToPath 必须先把文件地址转本地路径；失败只记日志不外抛；复用 openPathInDefaultApp 路径打开实现。
export async function openFileUrlInDefaultApp(
  url: string,
  logger: DesktopIpcLogger,
): Promise<void> {
  try {
    const filePath = fileURLToPath(url);
    await openPathInDefaultApp(filePath, logger);
  } catch (error) {
    logger.warn("[open-external] file URL 打开失败", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// 空路径直接失败；normalize 规范化后尝试 realpath；系统错误原样返回。
export async function openPathInDefaultApp(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    const error = "empty path";
    logger.warn("[open-external] 本地文件打开失败", { path: rawPath, error });
    return { success: false, error };
  }

  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径，让系统返回更具体的错误。
  }

  try {
    const error = await shell.openPath(target);
    if (error) {
      logger.warn("[open-external] 本地文件打开失败", { path: target, error });
      return { success: false, error };
    }
    logger.info?.("[open-external] 本地文件打开成功", { path: target });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[open-external] 本地文件打开失败", { path: target, error: message });
    return { success: false, error: message };
  }
}

// 空路径直接失败；process.platform 判断集中在此；失败返回结构而非抛出。
export async function openPathInFileManager(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // 路径不存在或无法解析时仍尝试用规范化后的原路径打开，便于定位权限等问题。
  }

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(target, logger);
  }

  const error = await shell.openPath(target);
  if (error) {
    logger.warn("[open-in-file-manager] shell.openPath 失败", {
      path: target,
      error,
    });
    return { success: false, error };
  }
  return { success: true };
}

export async function captureWindowScreenshot(senderWindow: BrowserWindow | null) {
  if (!senderWindow || senderWindow.isDestroyed()) {
    return null;
  }

  // 报错横幅里的反馈需要带上用户看到的现场。
  // 这里在 main 进程截当前窗口，避免 renderer 走屏幕录制权限或只能截到局部 DOM。
  const image = await senderWindow.webContents.capturePage();
  const buffer = image.toPNG();
  return {
    dataBase64: buffer.toString("base64"),
    filename: `zcode-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    contentType: "image/png",
    size: buffer.byteLength,
  };
}

// 依次尝试 runOpen 三种打开方式；全部失败才记录一次告警；失败信息合并 firstError/finderError/shell 三个来源。
async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {
  const runOpen = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await runOpen([target]);
    return { success: true };
  } catch (firstError) {
    try {
      await runOpen(["-a", "Finder", target]);
      return { success: true };
    } catch (finderError) {
      const shellMessage = await shell.openPath(target);
      if (!shellMessage) {
        return { success: true };
      }
      logger.warn("[open-in-file-manager] macOS 打开目录均失败", {
        path: target,
        shellMessage,
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        finderError: finderError instanceof Error ? finderError.message : String(finderError),
      });
      return { success: false, error: shellMessage };
    }
  }
}
