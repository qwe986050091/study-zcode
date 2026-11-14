import { spawn } from "node:child_process";
import {
  DEFAULT_GIT_DISCOVERY_TIMEOUT_MS,
  getGitBinaryCandidates,
  getGitCommandEnv,
} from "../config.js";

// 本模块只负责「找到可用的 Git 可执行文件」与「构造 Git 子进程环境」两件事，
// 不涉及仓库发现或具体命令语义，便于 Git 探测逻辑被多个 service 复用与替换。
// 接口保持最小面，调用方无需感知候选路径与环境变量的拼接细节。
export interface GitEnvironmentProvider {
  resolveGitBinary(): Promise<string | null>;
  createCommandEnv(): NodeJS.ProcessEnv;
}

// 探测候选路径是否真能执行：仅以 --version 作为轻量握手，不解析输出内容，
// 因为不同 Git 发行版的版本字符串格式差异较大，退出码为 0 即视为可用。
// 结果始终 resolve 布尔值而不 reject，避免单个候选异常打断整条回退链。
async function canExecuteGitCandidate(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
// stdio 置为 ignore 可防止子进程输出污染宿主日志；windowsHide 避免 Windows 下弹出控制台窗口。
// env 由调用方统一构造后注入，确保候选路径解析依赖的变量与后续真实执行保持一致。
    const child = spawn(candidate, ["--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, DEFAULT_GIT_DISCOVERY_TIMEOUT_MS);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

// 工厂返回带缓存的对象：缓存声明在闭包内，生命周期与 provider 实例一致，
// 因此同一 provider 的并发调用只会触发一轮探测，避免重复拉起 git --version。
// 缓存的是 Promise 而非结果，这样「正在探测」期间的其他调用也能共享同一次结果。
export function createGitEnvironmentProvider(): GitEnvironmentProvider {
  let cachedGitBinaryPromise: Promise<string | null> | null = null;

  return {
    async resolveGitBinary(): Promise<string | null> {
      if (cachedGitBinaryPromise) {
        return await cachedGitBinaryPromise;
      }

      const env = getGitCommandEnv();
      // Git binary 的探测在一次会话里不会频繁变化，
      // 这里缓存第一次探测结果，避免每个 Git RPC 都重复打一遍 `git --version`。
      cachedGitBinaryPromise = (async () => {
// 按候选顺序依次探测并返回第一个可用项；顺序由 config 决定（通常优先用户配置，其次系统 PATH）。
// 全部失败时返回 null，由上层给出「未安装 Git」的提示，而不是抛出异常。
        for (const candidate of getGitBinaryCandidates()) {
          if (await canExecuteGitCandidate(candidate, env)) {
            return candidate;
          }
        }
        return null;
      })();

      return await cachedGitBinaryPromise;
    },

// 每次调用都重新构造环境，避免调用方修改返回对象后影响到其他 Git 子进程。
// 这里刻意不缓存：环境变量可能随会话配置变化，而构造开销远低于二进制探测。
    createCommandEnv(): NodeJS.ProcessEnv {
      return getGitCommandEnv();
    },
  };
}
