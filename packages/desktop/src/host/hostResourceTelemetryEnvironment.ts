// 资源遥测用的「环境身份」哈希。
//
// 职责：把 RemoteTarget（server 时附带 serverId）规范化为稳定环境 key，再取 sha256，
// 让 main 能按环境归并资源样本，同时不在遥测旁路里暴露原始地址 / 主机名。
// 输入输出：输入 target 与可选 serverId；输出 hex 哈希字符串。
// 副作用：无（纯函数，createHash 为本地计算）。
// 失败语义：不抛错；target 字段缺失时由 buildRemoteEnvironmentKey 决定其规范化行为。
// 维护的不变量：同规格远端环境不能被合并——因此参与哈希的必须是完整规范身份
//（kind + host/port/用户名 + serverId），不能只取 host。
import { createHash } from "node:crypto";
import { buildRemoteEnvironmentKey, type RemoteTarget } from "@zcode/shared";

// 计算环境 key；server target 且给了 serverId 时把 serverId 并入身份，
// 其余情况直接用 target。输出固定长度 hex，可直接作为遥测分组键。
/** 同规格远端环境不能合并；只传规范环境身份的哈希，原始地址不进入遥测旁路。 */
export function resolveResourceTelemetryEnvironmentKey(
  target: RemoteTarget,
  serverId?: string,
): string {
  const environment = target.kind === "server" && serverId ? { ...target, serverId } : target;
  return createHash("sha256").update(buildRemoteEnvironmentKey(environment)).digest("hex");
}
