// 职责边界：本文件只把 pid 转成一次 taskkill 调用并归一化结果，不负责重试、超时后升级为强制结束或等待进程真正消失。
// INV：必须走异步 execFile 且始终 resolve（错误放进结果对象）；改成同步或 reject 会让调用方状态机漏掉失败分支并卡住 Host 退出。
import { execFile } from "node:child_process";
import type { WindowsTaskkillRunner } from "#src/process/processTreeTypes.js";

export const defaultWindowsTaskkillRunner: WindowsTaskkillRunner = ({ force, pid, timeoutMs }) =>
  new Promise((resolve) => {
    // 多个 workspace 退出时，同步 taskkill 会按 Agent 数量串行阻塞 Host。
    // 异步 runner 让进程树并发收口，并把命令完成结果交给等待式状态机观察。
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, _stdout, stderr) => {
        resolve({ ...(error ? { error } : {}), ...(stderr ? { stderr } : {}) });
      },
    );
  });
