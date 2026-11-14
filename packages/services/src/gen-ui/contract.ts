// Gen UI 宿主契约：只负责文档读取、沙箱准备与控件状态，不参与 HTML 内容的渲染与执行。
// 边界：readDocument 在 executor Host 执行，状态与沙箱相关方法落在 desktop base services。
// 不变量：所有状态方法都以完整 target 定位，同一 target 的 state 只有唯一权威来源。
// 改错后果：漏带 instanceKey 或 ownerWebContentsId 会让沙箱实例跨窗口串用，销毁时无法确定性回收。
import type { Event } from "@zcode/rpc";
import type {
  GenUiDocument,
  GenUiScope,
  GenUiStateChange,
  GenUiStateEntry,
  GenUiStateTarget,
  GenUiWidgetState,
} from "@zcode/shared/gen-ui";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";

export interface GenUiPrepareParams extends GenUiStateTarget {
  html: string;
  ownerWebContentsId: number;
  instanceKey: string;
}
/** readDocument runs on the executor Host. State and sandbox methods run on desktop base services. */
// prepareSandbox 与 setState 可能并发：沙箱就绪前写入的状态由实现自行缓冲，契约不保证顺序。
// onStateChanged 是广播而非回执，多宿主订阅时会收到自己写入的变更，消费方必须幂等处理。
// readDocument 失败只代表本次读取不可用，不应据此丢弃已缓存的控件状态。
export interface IGenUiService {
  readDocument(target: GenUiStateTarget): Promise<GenUiDocument>;
  prepareSandbox(input: GenUiPrepareParams): Promise<PluginSandboxHandle>;
  getState(target: GenUiStateTarget): Promise<GenUiWidgetState | null>;
  setState(input: { target: GenUiStateTarget; state: GenUiWidgetState }): Promise<void>;
  listState(scope: GenUiScope): Promise<GenUiStateEntry[]>;
  onStateChanged: Event<GenUiStateChange>;
}
export const IGenUiService = createServiceDescriptor<IGenUiService>("gen-ui");
