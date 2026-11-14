// 侧栏 API 统计分区。
// 职责：展示模型请求计数、server 侧 fetch/search 用量与近期网络请求。
// 边界：只读 usage/networkRequests，不改变顺序、不发起请求。
// 副作用：无，纯展示；颜色与截断按侧栏固定列宽计算。
// 降级：usage 缺失对应字段显示 "-"，无请求时显示 empty 行。

import type { ModelUsageSummary } from "@zcode/contracts";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { NetworkRequest } from "./app-model.js";
import { palette } from "./app-model.js";
import { SIDEBAR_CONTENT_WIDTH } from "./app-sidebar-layout.js";
import { SidebarSectionHeader } from "./app-sidebar-section-header.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import { formatDuration } from "./state.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 侧边栏行宽常量：label 固定 9 列，剩余宽度（含 1 列间隔）归 value，
// 保证不同 section 的键值列纵向对齐。
const SIDEBAR_LABEL_WIDTH = 9;
const SIDEBAR_ROW_VALUE_WIDTH = SIDEBAR_CONTENT_WIDTH - SIDEBAR_LABEL_WIDTH - 1;
// provider 标识若为 UUID，展示时压成「前 8 位...后 4 位」，避免长 ID 挤占整行；
// UUID_IDENTIFIER_PATTERN 只识别标准 8-4-4-4-12 形式，其他 ID 原样展示。
const COMPACT_IDENTIFIER_PREFIX_LENGTH = 8;
const COMPACT_IDENTIFIER_SUFFIX_LENGTH = 4;
const UUID_IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIDEBAR_TEXT_ROW_STYLE = { flexShrink: 0, height: 1, truncate: true, wrapMode: "none" };

// API 统计 section：展示模型请求数、server 侧 fetch/search 计数与近期网络请求。
// expanded 为 false 时只渲染标题行，不产生子节点；onToggle 缺省表示不可折叠。
// 输入口径：networkRequests 为空数组视为"无近期请求"而非异常，会显示 empty 文案；
// usage 为 undefined 表示该 session 尚无用量统计，对应字段统一显示 "-"。
// 副作用：无，纯展示，数据由上层 session 事件驱动传入。
export function ApiSection(props: {
  copy: TuiCopy;
  expanded: boolean;
  networkRequests: NetworkRequest[];
  onToggle?: () => void;
  usage?: ModelUsageSummary;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        flexDirection: "column",
        flexShrink: 0,
        marginTop: 1,
      },
    },
    SidebarSectionHeader({
      expanded: props.expanded,
      onToggle: props.onToggle,
      title: props.copy.sidebar.sections.apis,
    }),
    ...(props.expanded ? apiLines(props) : []),
  );
}

// section 内容：先输出 3 行汇总（模型请求数 / fetch+search / pending+error+recent），
// 再最多列 5 条近期请求，超出用 "more" 行提示剩余条数；无请求时用 empty 行提前结束。
// pending/error 由 status 派生，仅用于汇总展示，不改变请求本身的顺序。
function apiLines(props: {
  copy: TuiCopy;
  networkRequests: NetworkRequest[];
  usage?: ModelUsageSummary;
}): React.ReactNode[] {
  const usage = props.usage;
  const pending = props.networkRequests.filter((request) => request.status === "pending").length;
  const failed = props.networkRequests.filter((request) => request.status === "error").length;
  const lines = [
    rowLine(
      props.copy.sidebar.api.model,
      usage ? String(usage.modelRequestCount) : "-",
      "api-model",
    ),
    rowLine(
      props.copy.sidebar.api.server,
      usage ? `fetch ${usage.webFetchRequests} / search ${usage.webSearchRequests}` : "-",
      "api-server",
    ),
    rowLine(
      props.copy.sidebar.api.requests,
      props.networkRequests.length > 0
        ? `${pending} pending / ${failed} error / ${props.networkRequests.length} recent`
        : "-",
      "api-requests",
    ),
  ];

  if (props.networkRequests.length === 0) {
    lines.push(textLine(props.copy.sidebar.api.empty, palette.muted, "api-empty"));
    return lines;
  }

  for (const request of props.networkRequests.slice(0, 5)) {
    lines.push(
      textLine(formatRequestLine(request, props.copy), requestColor(request), `api-${request.id}`),
    );
  }
  if (props.networkRequests.length > 5) {
    lines.push(
      textLine(
        props.copy.sidebar.api.more(props.networkRequests.length - 5),
        palette.muted,
        "api-more",
      ),
    );
  }
  return lines;
}

// 键值行：label 按显示列宽左对齐补空格，value 截断到剩余宽度；两段之间固定 1 列间隔。
function rowLine(label: string, value: string, key: string): React.ReactElement {
  return textLine(
    `${padEndDisplay(label, SIDEBAR_LABEL_WIDTH)} ${truncateDisplay(value, SIDEBAR_ROW_VALUE_WIDTH)}`,
    palette.text,
    key,
  );
}

// 通用文本行：固定 1 行高、不换行、超宽截断，防止单条长 URL 撑高侧边栏；
// key 由调用方保证在同一 section 内唯一。
function textLine(value: string, color: string, key: string): React.ReactElement {
  return h("text", { key, style: { ...SIDEBAR_TEXT_ROW_STYLE, fg: color } }, value);
}

// 按显示列宽右补空格；先截断再补，保证返回宽度恰好等于 targetCells（宽字符按 2 列计算）。
function padEndDisplay(value: string, targetCells: number): string {
  const visible = truncateDisplay(value, targetCells);
  return `${visible}${" ".repeat(Math.max(0, targetCells - displayWidth(visible)))}`;
}

// 单条请求行：状态 + 大写方法 + 目标 + 可选耗时，总宽不超过侧边栏内容宽度。
// 耗时用"尾部保留"策略：先按剩余宽度截断目标，再把耗时拼回行尾，避免时长被截掉。
function formatRequestLine(request: NetworkRequest, copy: TuiCopy): string {
  const status = requestStatusLabel(request, copy);
  const method = request.method.toUpperCase();
  const target = requestTargetLabel(request);
  const duration = request.durationMs === undefined ? "" : ` ${formatDuration(request.durationMs)}`;
  const prefix = `${status} ${method} `;
  if (!duration) return truncateDisplay(`${prefix}${target}`, SIDEBAR_CONTENT_WIDTH);

  const urlWidth = SIDEBAR_CONTENT_WIDTH - prefix.length - duration.length;
  if (urlWidth <= 0) {
    return truncateDisplay(`${prefix}${target}${duration}`, SIDEBAR_CONTENT_WIDTH);
  }
  return `${prefix}${truncateDisplay(target, urlWidth)}${duration}`;
}

// 请求目标展示：优先去掉与 provider 重复的前缀，只保留差异部分；
// 命中三种已知形态（provider 前缀 / 完全等于 provider / provider+model）时压缩，
// 其余形态保留 provider 标签加原始 URL，保证信息不丢失。
function requestTargetLabel(request: NetworkRequest): string {
  if (!request.provider) return request.url;

  const providerLabel = requestProviderLabel(request.provider);
  if (request.url.startsWith(`${request.provider} `)) {
    return `${providerLabel}${request.url.slice(request.provider.length)}`;
  }
  if (request.url === request.provider) return providerLabel;
  if (request.url === `${request.provider}/${request.model}`) {
    return `${providerLabel}/${request.model}`;
  }
  return `${providerLabel} ${request.url}`;
}

// provider 标签压缩：仅标准 UUID 压缩为「前 8 位...后 4 位」，其他标识（短 slug 等）原样返回。
function requestProviderLabel(provider: string): string {
  if (!UUID_IDENTIFIER_PATTERN.test(provider)) return provider;
  return `${provider.slice(0, COMPACT_IDENTIFIER_PREFIX_LENGTH)}...${provider.slice(
    -COMPACT_IDENTIFIER_SUFFIX_LENGTH,
  )}`;
}

// 状态配色：error 用 danger、pending 用 accent、已完成用 muted，
// 让"仍在进行"和"失败"在黑白终端下也能靠亮度区分。
function requestColor(request: NetworkRequest): string {
  if (request.status === "error") return palette.danger;
  if (request.status === "pending") return palette.accent;
  return palette.muted;
}

// 状态文案：pending/complete 走固定文案，error 时若带 statusCode 则展示带码文案，
// 无状态码（网络层失败）退回通用错误文案。
function requestStatusLabel(request: NetworkRequest, copy: TuiCopy): string {
  if (request.status === "pending") return copy.sidebar.request.pending;
  if (request.status === "error") {
    return request.statusCode === undefined
      ? copy.sidebar.request.error
      : copy.sidebar.request.errorWithStatus(request.statusCode);
  }
  return copy.sidebar.request.complete;
}
