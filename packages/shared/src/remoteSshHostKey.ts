// INV-01 共享键绝不含口令：守住位置 字段列表；改错故障 密码进入日志或跨窗口缓存键。
// INV-02 认证方式参与身份：守住位置 resolveSshAuthKind；改错故障 换认证方式后复用旧连接。
// INV-03 私钥路径归一化后入键：守住位置 normalizePrivateKeyPath；改错故障 同一私钥的两种写法产生两条连接。
// INV-04 host 统一小写并 trim：守住位置 数组第二项；改错故障 大小写不同被当成两台主机。
// INV-05 端口缺省 22：守住位置 target.port ?? 22；改错故障 显式 22 与缺省产生两个键。
// INV-06 用户名只 trim 不折叠大小写：守住位置 第四项；改错故障 不同账号撞键。
// INV-07 盘符与 UNC 根不可被 .. 弹掉：守住位置 blocksParentTraversal；改错故障 路径逃逸到父目录。
// INV-08 相对与 ~ 路径保留未消解 ..：守住位置 末尾 push；改错故障 浏览器侧错误求值。
// INV-09 分隔符统一为斜杠：守住位置 replace 反斜杠；改错故障 Windows 路径跨平台不一致。
// INV-10 盘符统一大写：守住位置 正则替换；改错故障 C: 与 c: 生成两个键。
// INV-11 空段与点段直接丢弃：守住位置 循环内 continue；改错故障 路径出现双斜杠差异。
// INV-12 归一化结果为空回落到原前缀：守住位置 || root.prefix；改错故障 根路径变成空串。
// INV-13 版本前缀固定：守住位置 数组首项；改错故障 协议变更后旧键仍被命中。
// INV-14 键是 JSON 数组而非拼接串：守住位置 JSON.stringify；改错故障 字段含分隔符时撞键。
//
// 模块职责：为窗口内 SSH 远端生成稳定且不含敏感信息的共享身份键。
// 阅读顺序：先看字段清单与认证方式，再看路径根拆分，最后看逐段归一化。
import type { RemoteTargetSnapshot } from "./protocol.js";
import type { SSHConnectOptions } from "./remoteTarget.js";

type SshRemoteHostKeyTarget = SSHConnectOptions | Extract<RemoteTargetSnapshot, { kind: "ssh" }>;

interface PrivateKeyPathRoot {
  prefix: string;
  body: string;
  blocksParentTraversal: boolean;
}

// 先识别盘符绝对路径，再处理 UNC 与 POSIX 根，顺序不能换。
// UNC 至少要 server 与 share 两段才构成合法根。
// 波浪号与裸相对路径不做越界阻断，交给上层策略。
function splitPrivateKeyPathRoot(value: string): PrivateKeyPathRoot {
  const windowsDriveRoot = value.match(/^([A-Z]:)\/(.*)$/);
  if (windowsDriveRoot) {
    return {
      prefix: `${windowsDriveRoot[1]}/`,
      body: windowsDriveRoot[2] ?? "",
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("//")) {
    const segments = value.slice(2).split("/").filter(Boolean);
    if (segments.length >= 2) {
      const [server, share, ...bodySegments] = segments;
      return {
        prefix: `//${server}/${share}/`,
        body: bodySegments.join("/"),
        blocksParentTraversal: true,
      };
    }
    return {
      prefix: "//",
      body: segments.join("/"),
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("/")) {
    return {
      prefix: "/",
      body: value.replace(/^\/+/, ""),
      blocksParentTraversal: true,
    };
  }

  if (value.startsWith("~/")) {
    return {
      prefix: "~/",
      body: value.slice(2),
      blocksParentTraversal: false,
    };
  }

  const windowsDriveRelative = value.match(/^([A-Z]:)(.*)$/);
  if (windowsDriveRelative) {
    return {
      prefix: windowsDriveRelative[1] ?? "",
      body: windowsDriveRelative[2] ?? "",
      blocksParentTraversal: false,
    };
  }

  return {
    prefix: "",
    body: value,
    blocksParentTraversal: false,
  };
}

// trim 后为空统一返回空串，避免 undefined 进入键。
// 反斜杠先统一，否则后续按斜杠分段会漏拆。
// 盘符大写化保证跨平台一致。
function normalizePrivateKeyPath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }

  const normalizedSeparators = trimmed.replace(/\\/g, "/");
  const driveNormalized = normalizedSeparators.replace(
    /^([a-z]):/i,
    (_, drive: string) => `${drive.toUpperCase()}:`,
  );
  const root = splitPrivateKeyPathRoot(driveNormalized);
  const segments: string[] = [];

  for (const segment of root.body.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
        continue;
      }
      // 盘符、UNC share 和 POSIX root 不是普通路径段，`..` 不能把根弹掉；
      // 相对路径与 `~` 无法在浏览器侧安全求值，保留未消解的 parent segment 以避免错误复用。
      // 根路径上的 .. 直接忽略，保持根不被上跳。
      // 相对路径保留 ..，因为浏览器侧无法安全求值。
      if (root.blocksParentTraversal) {
        continue;
      }
      segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  // 拼完为空时回落到纯根，保证根路径也有稳定键。
  return `${root.prefix}${segments.join("/")}` || root.prefix;
}

// 私钥优先于口令，二者同时存在时按私钥建连。
// 都没有则视为 agent，避免把空字符串当认证信息。
function resolveSshAuthKind(target: SshRemoteHostKeyTarget): "agent" | "password" | "private-key" {
  if (target.privateKeyPath?.trim()) {
    return "private-key";
  }
  if (
    ("password" in target && typeof target.password === "string") ||
    ("passwordCredentialKey" in target && Boolean(target.passwordCredentialKey?.trim()))
  ) {
    return "password";
  }
  return "agent";
}

/**
 * 构造窗口内 SSH Remote Host 的共享身份。
 * 密码和私钥口令只用于建连，禁止进入共享键或日志。
 */
// 数组顺序即协议，改动需要同时升级版本前缀。
// 认证方式由既有字段推导，不额外读取运行时状态。
export function buildSshRemoteHostKey(target: SshRemoteHostKeyTarget): string {
  return JSON.stringify([
    "ssh:v1",
    target.host.trim().toLowerCase(),
    target.port ?? 22,
    target.username.trim(),
    resolveSshAuthKind(target),
    normalizePrivateKeyPath(target.privateKeyPath),
  ]);
}
