// 账号 Provider（BigModel / ZAI）远端 DTO 与本地兜底常量：只描述 /api/biz 响应形状，
// 不含网络、状态与重试逻辑。
// INV-01：所有远端字段都是 optional —— 服务端可能省略字段，调用方必须先判空再取值。
// INV-02：DEFAULT_ORG_NAME / DEFAULT_PROJECT_NAME 是「按名字兜底匹配」的唯一来源，
//          改文案会改变个人 Key 解析到的机构与项目。
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";

// 账号族白名单收紧到两个 ID：新增 Provider 必须同步改 resolveOAuthProviderId 与换证域名映射。
export type AccountApiProviderId = typeof BIGMODEL_PROVIDER_ID | typeof ZAI_PROVIDER_ID;

// 统一响应包：code 缺省视为成功；data 缺省由 AccountProviderApiClient 归一为 null。
export interface RemoteEnvelope<T> {
  code?: number;
  data?: T;
}

// projectType 兼容字符串与数字两种形态；"2" 表示 Team Plan 项目，个人 Key 解析必须过滤。
export interface RemoteProjectInfo {
  projectId?: string;
  projectName?: string;
  projectType?: number | string | null;
}

export interface RemoteOrganizationInfo {
  organizationId?: string;
  organizationName?: string;
  projects?: RemoteProjectInfo[];
}

export interface RemoteCustomerInfo {
  organizations?: RemoteOrganizationInfo[];
}

// 列表项只含摘要；secretKey 仅在单条查询或创建响应里返回。
export interface RemoteApiKeySummary {
  apiKey?: string;
  keyType?: number | null;
  name?: string;
}

export interface RemoteApiKeySecret {
  secretKey?: string;
}

// 名字兜底常量：找不到 organizationId/projectName 匹配时按它挑选默认机构与项目。
export const DEFAULT_ORG_NAME = "默认机构";
export const DEFAULT_PROJECT_NAME = "默认项目";
export const ZCODE_API_KEY_NAME = "zcode-api-key";
