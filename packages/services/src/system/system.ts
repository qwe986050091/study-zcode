// 系统信息契约：对外暴露宿主信息、集成终端可选 shell 与本机内网探测三项只读能力。
// INV：三个方法都是查询语义，不得在此承载改变宿主状态的副作用，否则 UI 主动刷新会引发行为漂移。
// INV：返回值必须复用 @zcode/shared 的公共类型，禁止就地定义同形结构，否则协议演进时两端类型会分叉。
// 维护提示：探测可能耗时并产生网络流量，频率与超时由调用方约束，这一层不做节流与缓存。
import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  SystemInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISystemService {
  info(): Promise<SystemInfo>;
  listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]>;
  probeIntranet(request: IntranetProbeRequest): Promise<IntranetProbeResult>;
}

// 描述符绑定 ServiceChannels.System；频道一旦变更即破坏与既有宿主进程的兼容，必须与协议版本同步升级。
export const ISystemService = createServiceDescriptor<ISystemService>(ServiceChannels.System);
