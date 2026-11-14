// ============================================================
// Provider 端点路由工厂的注入参数（纯类型定义）
// 定位：bootstrap 与 adapter 的接缝，声明路由能力所需的全部外部依赖，不含实现。
// 输入输出：仅类型；无运行时副作用、无失败路径。
// 不变量：实现方只能读取这些注入项，不得改写 Provider 持久化配置或环境变量。
// ============================================================

import type { HttpClientPort, Logger } from "@zcode/contracts";

/** 由 bootstrap 注入的运行环境；实现不得修改 Provider 的持久化配置。 */
export interface ProviderEndpointRoutingFactoryOptions {
  /** 网关落点 origin（含协议与端口）；路由只替换 origin/path，不继承原请求的鉴权。 */
  endpointOrigin: string;
  /** 客户端版本，空/undefined 表示未知，仅用于附加标识，不参与路由判定。 */
  appVersion?: string;
  /** 统一 HTTP 出口，路由自身不直接调用全局 fetch。 */
  httpClient: HttpClientPort;
  /** 可选日志口；缺省时静默，不因缺失日志而失败。 */
  logger?: Logger;
  /** 读取 ZCode JWT；返回 null 表示当前无可用票据（调用方需按未鉴权处理）。 */
  readZCodeJwt?: () => Promise<string | null>;
  /** 请求期来源头快照，允许同步或异步；缺省表示不附加任何来源头。 */
  sourceHeaders?: () =>
    | Promise<Readonly<Record<string, string>>>
    | Readonly<Record<string, string>>;
}
