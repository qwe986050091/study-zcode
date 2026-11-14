import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";

// 后端工厂的唯一入口：按 target.kind 动态加载，避免把三种后端打进同一份启动依赖。
export async function createRemoteBackend(target: RemoteTarget): Promise<IRemoteBackend> {
  // 用 switch 而非映射表：新增 kind 时漏写分支会落到抛错，不会静默回落。
  switch (target.kind) {
    // ssh 分支需要预读私钥：其余两种后端自己处理凭据。
    case "ssh": {
      // 动态 import：只有 SSH 目标才加载 ssh2 依赖，降低其它后端的启动开销。
      const { SSHBackend } = await import("./ssh-backend.js");
      // privateKey 先声明为 undefined：无私钥路径时保持未定义，交给 SSHBackend 走密码认证。
      let privateKey: string | Buffer | undefined;
      // 只有显式给了路径才读盘：没有路径表示用密码或 agent 认证。
      if (target.privateKeyPath) {
        // 展开 ~ 为用户目录：readFile 不认 shell 的波浪号展开。
        const keyPath = target.privateKeyPath.replace(/^~/, homedir());
        // 读出 Buffer 原样传入：加密私钥的解密交给 SSHBackend 与 passphrase。
        privateKey = await readFile(keyPath);
      }

      // 构造 SSHBackend：私钥内容与路径同时传，后者用于错误提示定位。
      return new SSHBackend({
        // host 必填：target 解析阶段已校验，这里不再兜底。
        host: target.host,
        // port 可缺省：SSHBackend 内部按 22 兜底。
        port: target.port,
        // username 原样传递：SSH 认证不允许匿名。
        username: target.username,
        // password 可能为空：与 privateKey 二选一，由 ssh2 决定最终认证方式。
        password: target.password,
        // 保留 privateKeyPath 仅作诊断：真正用于连接的是下面读出的 privateKey。
        privateKeyPath: target.privateKeyPath,
        // passphrase 透传给 SSHBackend：解密失败时由它给出可读错误。
        privateKeyPassphrase: target.privateKeyPassphrase,
        privateKey,
      });
    }
    // wsl 分支不读私钥：WSL 后端直接用发行版内的用户环境。
    case "wsl": {
      // 动态 import 避免在非 WSL 平台加载 wsl 相关依赖。
      const { WSLBackend } = await import("./wsl-backend.js");
      // target 直接透传：WSLBackend 自己解析发行版名与用户。
      return new WSLBackend(target);
    }
    // docker 分支同样按需加载：docker 后端不会进入 SSH 目标的依赖图。
    case "docker": {
      // 动态 import 隔离 docker 依赖：只有 docker 目标才付出加载成本。
      const { DockerBackend } = await import("./docker-backend.js");
      // 容器名等参数由 target 携带，构造函数内不再二次校验。
      return new DockerBackend(target);
    }
    // server 目标不产生部署后端：它连接的是已存在的服务，落到默认抛错。
    case "server":
      // 抛错而不是返回 null：调用方按配置错误处理，避免后续解引用空后端。
      throw new Error("server remote target connects to an existing server and has no deploy backend");
  }
}
