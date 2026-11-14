// INV-01 外部命令统一入口：守住位置 runPackagingCommand；改错故障 各打包点各自拼 shell 参数。
// INV-02 tar 一律改走宿主实现：守住位置 resolveHostTarCommand 调用；改错故障 Windows 命中 Git Bash 的 GNU tar。
// INV-03 zip 在 Windows 走 bsdtar：守住位置 useWindowsTarForZip；改错故障 无 Info-ZIP 环境下打包直接失败。
// INV-04 zip 参数改写：守住位置 ["-acf", ...args.slice(1)]；改错故障 bsdtar 收到不认识的 -qr 报错。
// INV-05 参数数组而非字符串：守住位置 spawn 形参；改错故障 带空格路径被 shell 拆开。
// INV-06 macOS 禁扩展属性：守住位置 --no-xattrs 分支；改错故障 PAX header 刷爆安装日志。
// INV-07 尘土文件抑制：守住位置 COPYFILE_DISABLE；改错故障 归档混入 ._* 条目。
// INV-08 非零退出即拒绝：守住位置 exit 回调；改错故障 打包失败仍产出半成品归档。
// INV-09 退出码带进错误：守住位置 错误消息拼接；改错故障 排查时看不到真实退出码。
// INV-10 文件遍历确定性：守住位置 两次 sort；改错故障 同一输入产生不同摘要。
// INV-11 摘要含相对路径：守住位置 hash.update(`${file}\0`)；改错故障 文件改名后摘要不变。
// INV-12 目录先展开后哈希：守住位置 stat.isDirectory 分支；改错故障 目录被当普通文件读取。
// INV-13 缺失路径跳过：守住位置 access 的 catch；改错故障 可选产物缺失导致整批打包中断。
// INV-14 临时目录不留残渣：守住位置 前后两次 rm；改错故障 .components 越积越多。
//
// 模块职责：以宿主的 tar/zip 能力把发布目录裁剪成分组件归档，并给出摘要。
// 阅读顺序：先看 runPackagingCommand 的平台改写，再看 hashPaths，最后看 createComponentArchive。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerTarget } from "../runtime/manifest.js";
import { isTarCommand, resolveHostTarCommand } from "./tarCommand.js";

// 打包命令的统一出口：`stageArchives` 是唯一调用点。
export async function runPackagingCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // Bug 原因：Windows runner 的 PATH 可能优先命中 Git Bash GNU tar，且系统没有
    // Info-ZIP；统一把逻辑 tar 与 Windows 上的逻辑 zip 映射到 System32 bsdtar。
    // Windows 上没有 zip 时改用 bsdtar。
    const useWindowsTarForZip = command === "zip" && process.platform === "win32";
    const resolvedCommand =
      command === "tar" || useWindowsTarForZip ? resolveHostTarCommand() : command;
    // 改写参数但不改写输出路径。
    const baseArgs = useWindowsTarForZip ? ["-acf", ...args.slice(1)] : [...args];
    // Bug 原因：COPYFILE_DISABLE 只能阻止 AppleDouble `._*`，bsdtar 仍会把 provenance/xattr
    // 写入 PAX header。Linux 解压时会为每个条目输出 unknown extended header，既刷爆连接日志，
    // 也可能在真实安装错误发生时把 stderr 根因淹没；macOS 打包必须同时禁用 xattr。
    // tar 家族统一关掉 AppleDouble。
    const env = isTarCommand(resolvedCommand)
      ? { ...process.env, COPYFILE_DISABLE: "1" }
      : process.env;
    // macOS 额外禁用 xattr 写入。
    const commandArgs =
      command === "tar" && process.platform === "darwin"
        ? ["--no-xattrs", ...baseArgs]
        : baseArgs;
    // 输出直通父进程，不缓存大日志。
    const child = spawn(resolvedCommand, commandArgs, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", rejectPromise);
    // 只有 0 才算成功。
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `${resolvedCommand} ${commandArgs.join(" ")} exited with code ${code ?? "null"}`,
          ),
        );
    });
  });
}

// 目录展开成相对路径列表。
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

// 摘要与字节数一次遍历产出。
export async function hashPaths(
  root: string,
  paths: readonly string[],
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(root, relativePath);
    const pathStat = await stat(absolutePath);
    const files = pathStat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const contents = await readFile(join(root, file));
      // 路径参与摘要，防止改名碰撞。
      hash.update(`${file}\0`);
      hash.update(contents);
      sizeBytes += contents.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

// 先算摘要，再用摘要命名临时目录。
export async function createComponentArchive(
  releaseDir: string,
  outputDir: string,
  target: ServerTarget,
  id: string,
  paths: readonly string[],
): Promise<{ archivePath: string; sha256: string; sizeBytes: number }> {
  const info = await hashPaths(releaseDir, paths);
  const componentRoot = join(outputDir, ".components", `${id}-${info.sha256.slice(0, 12)}`);
  await rm(componentRoot, { force: true, recursive: true });
  await mkdir(componentRoot, { recursive: true });
  for (const relativePath of paths) {
    const source = join(releaseDir, relativePath);
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(componentRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { recursive: true, dereference: true });
  }
  // 归档格式随目标平台：`darwin` 取 zip、`win32` 取 7z。
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  const archivePath = join(outputDir, "components", target, `${id}-${info.sha256}.${extension}`);
  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  // `zip` 与 `7z` 两条路径共用同一份临时树。
  if (extension === "zip") {
    await runPackagingCommand("zip", ["-qr", archivePath, "."], componentRoot);
  } else {
    await runPackagingCommand("tar", ["-czf", archivePath, "."], componentRoot);
  }
  await rm(componentRoot, { force: true, recursive: true });
  return { archivePath, ...info };
}
