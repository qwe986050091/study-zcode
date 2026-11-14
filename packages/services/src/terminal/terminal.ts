// 终端服务的 RPC 契约层：只声明能力与数据结构，不持有 PTY 进程或输出缓冲区。
// 职责：把 create/write/resize/dispose 与动态数据、退出事件映射到 ServiceChannels.Terminal。
// 边界：真实 PTY 生命周期在实现侧的本地 host 中，本文件不感知进程调度与平台差异。
// INV：id 由 create 返回且全局唯一；事件订阅必须先于写入，否则早期输出会静默丢失。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfile.js";

// 暴露后端类型与构建号供 UI 降级判断：ConPTY 在旧版 Windows 上有渲染与输入缺陷，需要前端兜底。
export interface TerminalWindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

// 方法统一返回 Promise：跨进程调用可能失败（PTY 已退出、host 断连），调用方必须处理拒绝。
// dispose 与 onDynamicExit 是两条独立路径——前者主动关闭，后者反映进程自然退出，不能互相替代。
export interface ITerminalService {
  create(params: { cols: number; rows: number; cwd?: string }): Promise<{
    id: string;
    shell: string;
    fontFamily: string;
    fontSize?: number;
    theme?: TerminalThemeProfile;
    fontFamilySource: TerminalFontFamilySource;
    windowsPty?: TerminalWindowsPtyInfo;
  }>;
  write(params: { id: string; data: string }): Promise<void>;
  resize(params: { id: string; cols: number; rows: number }): Promise<void>;
  dispose(params: { id: string }): Promise<void>;
  onDynamicData(id: string): Event<string>;
  onDynamicExit(id: string): Event<number>;
}

// 描述符把接口名与频道绑定，频道值即 RPC 路由键，改动会导致两端无法互通。
export const ITerminalService = createServiceDescriptor<ITerminalService>(ServiceChannels.Terminal);
