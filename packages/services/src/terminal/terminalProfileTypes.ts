// 职责：描述终端外观配置的数据形状——字体来源、主题色板与探测结果。
// 边界：纯类型声明，不做校验与合并；合并优先级由终端配置服务负责。
// INV：字段全可选，缺省表示沿用上层或终端默认值，不得填充硬编码默认色。
// 改错后果：字段改名或改必填会让旧配置反序列化失败，用户终端外观被重置为出厂值。
export type TerminalFontFamilySource = "custom" | "system" | "fallback";

// 色板键名对齐终端渲染组件的约定（含 bright 变体），是主题下发渲染层的唯一映射面。
// 保持可选：主题可能只覆盖部分颜色，其余必须继续继承终端默认，避免出现半黑半白。
// 新增键需同步更新渲染侧，否则配置静默失效且没有任何提示。
export interface TerminalThemeProfile {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

// 探测结果是尽力而为的快照：宿主终端配置可能不存在、不完整或不可读。
// 故字段全可选，缺失即“未探测到”，调用方不得据缺失推断出某个默认值。
// 探测与保存分离，避免一次失败的探测覆盖用户已保存的偏好。
export interface TerminalDetectedProfile {
  fontFamily?: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
}
