// INV-01 命令名可覆盖：守住位置 常量；改错故障 测试与部署环境无法替换路径。
// INV-02 输出先去回车：守住位置 归一化函数；改错故障 Windows 换行导致解析失败。
// INV-03 可执行判断可注入：守住位置 选项字段；改错故障 单测依赖真实安装。
// INV-04 路径分隔符随平台：守住位置 分隔符函数；改错故障 Windows 上 PATH 切不开。
// INV-05 拼接走平台路径库：守住位置 分支拼接；改错故障 混用分隔符导致路径无效。
// INV-06 可执行名按平台枚举：守住位置 名称数组；改错故障 Windows 找不到包装脚本。
// INV-07 PATH 优先于固定路径：守住位置 查找顺序；改错故障 用户自定义版本被覆盖。
// INV-08 空目录跳过：守住位置 裁剪后判断；改错故障 当前目录被当作 PATH 项。
// INV-09 找不到时返回裸命令：守住位置 末尾返回；改错故障 启动阶段直接抛错。
// INV-10 探测失败即不可用：守住位置 捕获分支；改错故障 守护进程未启动仍显示入口。
// INV-11 错误信息取标准错误：守住位置 或运算；改错故障 只看到退出码没有原因。
// INV-12 输出上限固定：守住位置 缓冲区常量；改错故障 大列表被截断成半行。
// INV-13 逐行解析：守住位置 换行切分；改错故障 多容器只解析出第一条。
// INV-14 空行被丢弃：守住位置 过滤；改错故障 解析器收到空串报错。
// INV-15 关键字段缺失即跳过该行：守住位置 字段判断；改错故障 列表出现空标识卡片。
// INV-16 可选字段退化为空串：守住位置 空值合并；改错故障 界面出现未定义字样。
// INV-17 单行失败不影响整批：守住位置 捕获分支；改错故障 一条脏数据清空整个列表。
// INV-18 列举默认只看运行中：守住位置 参数分支；改错故障 默认把已停止容器算进去。
//
// 模块职责：定位 docker 可执行文件并解析容器列表。
// 状态所有权：无状态，环境与平台由调用方注入。
// 阅读顺序：先看命令定位与回退路径，再看执行封装，最后看列表解析。
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { DockerContainerInfo } from "@zcode/shared";
export type { DockerContainerInfo } from "@zcode/shared";

const DOCKER_COMMAND = "docker";
const DOCKER_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

type DockerCommandResolutionOptions = {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  isExecutable?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
};

// normalizeDockerOutput 只抹掉 \r，不碰其它字节。
// 首尾空白留给调用方，exec 路径自己再 trim。
// 换行符保持原样，parseDockerContainerList 再按 "\n" 切分。
// execDocker 与 parseDockerContainerList 都先过这一层。
// replace 返回新串，入参 raw 不被改动。
function normalizeDockerOutput(raw: string): string {
  return raw.replace(/\r/g, "");
}

function defaultIsExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function joinExecutablePath(
  platform: NodeJS.Platform,
  directory: string,
  executableName: string,
): string {
  return platform === "win32"
    ? win32.join(directory, executableName)
    : posix.join(directory, executableName);
}

function getDockerExecutableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? ["docker.exe", "docker.cmd", "docker.bat", DOCKER_COMMAND]
    : [DOCKER_COMMAND];
}

// macOS 覆盖常见安装位置。
// Linux 只列标准目录。
// Windows 列桌面版路径。
// 未知平台返回空数组。
// 回退只在前一步失败后使用。
function getFallbackDockerCommands(platform: NodeJS.Platform, userHomeDir: string): string[] {
  if (platform === "darwin") {
    return [
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
      posix.join(userHomeDir, ".orbstack/bin/docker"),
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ];
  }

  if (platform === "linux") {
    return ["/usr/local/bin/docker", "/usr/bin/docker", "/snap/bin/docker"];
  }

  if (platform === "win32") {
    return [
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\ProgramData\\DockerDesktop\\version-bin\\docker.exe",
    ];
  }

  return [];
}

// platform、env、homeDir、isExecutable 全部由 options 注入。
// 先按 PATH 顺序查找。
// 每个 PATH 目录先试 docker.exe、docker.cmd、docker.bat，再试 docker。
// PATH 里的空段 trim 后为 ""，直接 continue 而不是拼路径。
// PATH 全部落空后才查 getFallbackDockerCommands 返回的固定路径。
// 都不可执行时返回常量 DOCKER_COMMAND，让调用方拿到 ENOENT 而不是空串。
export function resolveDockerCommand(options: DockerCommandResolutionOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const pathValue = env.PATH ?? "";
  const pathDelimiter = getPathDelimiter(platform);

  for (const directory of pathValue.split(pathDelimiter)) {
    const trimmedDirectory = directory.trim();
    if (!trimmedDirectory) {
      continue;
    }

    for (const executableName of getDockerExecutableNames(platform)) {
      const candidate = joinExecutablePath(platform, trimmedDirectory, executableName);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  // macOS GUI 应用从 Dock/Finder 启动时通常不会继承 shell PATH，
  // OrbStack/Docker Desktop 的 docker wrapper 仍可能位于这些稳定路径。
  // 先查 PATH，再查常见安装位置，避免 daemon 正常运行时被误判为 Docker 不可用。
  for (const candidate of getFallbackDockerCommands(platform, options.homeDir ?? homedir())) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return DOCKER_COMMAND;
}

async function execDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      resolveDockerCommand(),
      args,
      {
        encoding: "utf8",
        maxBuffer: DOCKER_EXEC_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(normalizeDockerOutput(stderr).trim() || error.message));
          return;
        }

        resolve(normalizeDockerOutput(stdout));
      },
    );
  });
}

// 先按 "\n" 切行，再逐行 trim。
// filter(line => line.length > 0) 在 JSON.parse 之前执行。
// 每行独立解析 JSON。
// parsed.ID 或 parsed.Names 为空时返回空的 flatMap 结果。
// Image、State、Status 缺省时用 "" 而不是 undefined。
// JSON.parse 抛错被 catch 吞掉，只跳过当前行。
export function parseDockerContainerList(rawOutput: string): DockerContainerInfo[] {
  return normalizeDockerOutput(rawOutput)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as {
          ID?: string;
          Image?: string;
          Names?: string;
          State?: string;
          Status?: string;
        };

        if (!parsed.ID || !parsed.Names) {
          return [];
        }

        return [
          {
            id: parsed.ID,
            image: parsed.Image ?? "",
            name: parsed.Names,
            state: parsed.State ?? "",
            status: parsed.Status ?? "",
          },
        ];
      } catch {
        return [];
      }
    });
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execDocker(["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    // 之前只把“docker 命令不存在”视为不可用，daemon 未启动时仍会误判成可用，
    // UI 会继续展示 Docker 入口，直到真正连接时才报错。
    // 这里改成任何探测失败都返回 false，让入口展示和实际可连接状态保持一致。
    return false;
  }
}

export async function listDockerContainers(options?: {
  all?: boolean;
}): Promise<DockerContainerInfo[]> {
  const args = ["ps"];
  if (options?.all) {
    args.push("-a");
  }
  args.push("--format", "{{json .}}");

  const output = await execDocker(args);
  return parseDockerContainerList(output);
}
