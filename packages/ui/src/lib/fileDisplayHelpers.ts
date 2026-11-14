// INV-01 默认图标名固定：守住位置 DEFAULT_FILE_ICON_NAME；改错故障 未知扩展名没有图标。
// INV-02 调色板缺项回退文档色：守住位置 getIconPalette 兜底；改错故障 图标透明不可见。
// INV-03 调色板只含前景与背景：守住位置 ICON_COLOR_MAP 值类型；改错故障 深色主题对比度不足。
// INV-04 文件名别名优先于扩展名：守住位置 两轮查找顺序；改错故障 .gitignore 显示成普通文档。
// INV-05 别名键统一小写：守住位置 normalizedLeaf；改错故障 大小写不同命中失败。
// INV-06 多段文件名逐段回退：守住位置 stemCandidate 循环；改错故障 vitest.config.ts 丢失配置语义。
// INV-07 图标匹配大小写不敏感：守住位置 toLowerCase；改错故障 README 与 readme 显示不同图标。
// INV-08 无扩展名回退默认图标：守住位置 lastDot 判断；改错故障 Makefile 显示空图标。
// INV-09 扩展名别名集中一处：守住位置 EXTENSION_ICON_ALIASES；改错故障 同一类型出现两套图标。
// INV-10 Office 扩展名显式收敛：守住位置 doc 与 docx；改错故障 Word 文件图标错位。
// INV-11 未列扩展名原样返回：守住位置 末尾兜底；改错故障 未知类型被强转文档图标。
// INV-12 尾点文件名不进入映射：守住位置 尾点切片；改错故障 空扩展名命中异常分支。
// INV-13 路径分隔符统一为正斜杠：守住位置 normalizePath；改错故障 Windows 路径取不到叶名。
// INV-14 末尾分隔符可裁掉：守住位置 trimTrailingSeparator；改错故障 目录路径多出空段。
// INV-15 图标缩写最多三字符：守住位置 slice 与 toUpperCase；改错故障 标签撑破徽章。
// INV-16 文档与目录用固定缩写：守住位置 两个分支；改错故障 徽章显示扩展名残片。
// INV-17 内联 SVG 走统一编码：守住位置 buildInlineSvgDataUrl；改错故障 图标在 data URL 中破图。
// INV-18 本文件不含 JSX：守住位置 纯工具模块；改错故障 组件与工具形成循环依赖。
//
// 模块职责：文件图标的名称解析、配色与缩写标签。
// 状态所有权：无状态；全部为只读常量表与纯函数。
// 阅读顺序：先看别名表，再读图标解析，最后看配色与标签。
// 纯工具函数和常量，从 fileDisplay.tsx 提取以控制文件行数

export const DEFAULT_FILE_ICON_NAME = "document";

// accent/background 是十六进制写死的一对前景与背景，不随主题反转：图标底色在明暗主题下保持一致。
// 表里没有的 key 由 getIconPalette 回退到 document 的配色；新增图标必须同时补两色。
const ICON_COLOR_MAP: Record<string, { accent: string; background: string }> = {
  audio: { accent: "#7C3AED", background: "#EDE9FE" },
  css: { accent: "#1572B6", background: "#E0F2FE" },
  database: { accent: "#7C3AED", background: "#EDE9FE" },
  docker: { accent: "#1D63ED", background: "#DBEAFE" },
  document: { accent: "#64748B", background: "#E2E8F0" },
  editorconfig: { accent: "#F59E0B", background: "#FEF3C7" },
  eslint: { accent: "#4F46E5", background: "#E0E7FF" },
  folder: { accent: "#B45309", background: "#FEF3C7" },
  git: { accent: "#F05133", background: "#FEE2E2" },
  go: { accent: "#0EA5E9", background: "#E0F2FE" },
  html: { accent: "#E44D26", background: "#FEE2E2" },
  image: { accent: "#DB2777", background: "#FCE7F3" },
  javascript: { accent: "#CA8A04", background: "#FEF9C3" },
  json: { accent: "#0F766E", background: "#CCFBF1" },
  markdown: { accent: "#2563EB", background: "#DBEAFE" },
  nodejs_alt: { accent: "#16A34A", background: "#DCFCE7" },
  npm: { accent: "#DC2626", background: "#FEE2E2" },
  php: { accent: "#7C3AED", background: "#EDE9FE" },
  prettier: { accent: "#DB2777", background: "#FCE7F3" },
  python: { accent: "#2563EB", background: "#DBEAFE" },
  react: { accent: "#0891B2", background: "#CFFAFE" },
  react_ts: { accent: "#0284C7", background: "#E0F2FE" },
  readme: { accent: "#2563EB", background: "#DBEAFE" },
  rust: { accent: "#9A3412", background: "#FFEDD5" },
  settings: { accent: "#4B5563", background: "#E5E7EB" },
  storybook: { accent: "#EC4899", background: "#FCE7F3" },
  svg: { accent: "#EA580C", background: "#FFEDD5" },
  toml: { accent: "#B45309", background: "#FEF3C7" },
  tsconfig: { accent: "#2563EB", background: "#DBEAFE" },
  typescript: { accent: "#2563EB", background: "#DBEAFE" },
  vitest: { accent: "#65A30D", background: "#ECFCCB" },
  video: { accent: "#DC2626", background: "#FEE2E2" },
  yaml: { accent: "#B91C1C", background: "#FEE2E2" },
  yarn: { accent: "#0F766E", background: "#CCFBF1" },
};

// 键是小写文件名（含点文件），值是 ICON_COLOR_MAP 的键；别名表只按文件名匹配而不看扩展名。
// .env 与 .gitignore 这类共用同一图标；新增别名要确认目标键在调色板里存在。
const FILE_NAME_ICON_ALIASES: Record<string, string> = {
  ".editorconfig": "editorconfig",
  ".env": "settings",
  ".gitattributes": "git",
  ".gitignore": "git",
  ".npmrc": "npm",
  ".nvmrc": "nodejs_alt",
  ".prettierrc": "prettier",
  ".yarnrc": "yarn",
  "babel.config": "babel",
  bun: "lock",
  "bun.lock": "lock",
  cargo: "rust",
  "cargo.lock": "lock",
  dockerfile: "docker",
  eslint: "eslint",
  "eslint.config": "eslint",
  gemfile: "gemfile",
  jest: "jest",
  "jest.config": "jest",
  makefile: "makefile",
  "package-lock": "lock",
  "pnpm-lock": "lock",
  readme: "readme",
  tsconfig: "tsconfig",
  vitest: "vitest",
  "vitest.config": "vitest",
  yarn: "yarn",
};

// material-icons 里的图标名和文件扩展名并不总是一一对应，
// 比如 tsx 实际素材叫 react_ts 而不是 react_tsx。这里集中做 alias，避免 mention panel 和输入框 token 出现扩展名对不上图标的问题。
const EXTENSION_ICON_ALIASES: Record<string, string> = {
  backup: "document",
  bash: "console",
  cjs: "javascript",
  cts: "typescript",
  css: "css",
  // Office 扩展名与 Material Icons 素材名不一致，直接用扩展名拼路径会选错图标；
  // 这里显式收敛到同一套产品语义，旧版与新版 Word 文件也共用 word 图标。
  doc: "word",
  docx: "word",
  go: "go",
  html: "html",
  java: "java",
  jpeg: "image",
  jpg: "image",
  js: "javascript",
  jsx: "react",
  json: "json",
  jsonl: "json",
  mjs: "javascript",
  md: "markdown",
  m4a: "audio",
  m4v: "video",
  flac: "audio",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  ogg: "audio",
  opus: "audio",
  mts: "typescript",
  pdf: "pdf",
  php: "php",
  png: "image",
  pptx: "powerpoint",
  py: "python",
  responses: "json",
  rs: "rust",
  sb: "storybook",
  sql: "database",
  sh: "console",
  snap: "snapcraft",
  svg: "svg",
  toml: "toml",
  ts: "typescript",
  tsx: "react_ts",
  txt: "document",
  wav: "audio",
  weba: "audio",
  webm: "video",
  xlsx: "table",
  yaml: "yaml",
  yml: "yaml",
  zsh: "console",
};

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function trimTrailingSeparator(path: string): string {
  return path.replace(/\/+$/, "");
}

// 先归一化路径取叶名并小写，再按 整名 → 逐段 stem 的顺序查 FILE_NAME_ICON_ALIASES。
// 无扩展名回退 DEFAULT_FILE_ICON_NAME；有扩展名查 EXTENSION_ICON_ALIASES，未收录时把扩展名原样当图标名返回。
export function resolveIconName(filePath: string): string {
  const normalizedPath = normalizePath(filePath);
  const lastSlash = normalizedPath.lastIndexOf("/");
  const leaf = lastSlash === -1 ? normalizedPath : normalizedPath.slice(lastSlash + 1);
  const normalizedLeaf = leaf.toLowerCase();
  const lastDot = leaf.lastIndexOf(".");
  const fileNameWithoutExtension =
    lastDot === -1 ? normalizedLeaf : normalizedLeaf.slice(0, lastDot);

  const fileNameAliasCandidates = new Set<string>([normalizedLeaf, fileNameWithoutExtension]);

  // 之前只会匹配完整文件名和"去掉最后一个扩展名"的结果，
  // 像 vitest.config.ts / tsconfig.base.json / .env.local 这类多段文件名会提前退回扩展名图标，
  // 导致配置文件语义丢失。这里逐段回退 stem，让常见配置文件能稳定命中更准确的图标。
  let stemCandidate = fileNameWithoutExtension;
  while (stemCandidate.includes(".")) {
    stemCandidate = stemCandidate.slice(0, stemCandidate.lastIndexOf("."));
    if (stemCandidate) {
      fileNameAliasCandidates.add(stemCandidate);
    }
  }

  for (const candidate of fileNameAliasCandidates) {
    const aliasedFileName = FILE_NAME_ICON_ALIASES[candidate];
    if (aliasedFileName) {
      return aliasedFileName;
    }
  }

  if (lastDot === -1) {
    return DEFAULT_FILE_ICON_NAME;
  }

  const extension = leaf.slice(lastDot + 1).toLowerCase();
  return EXTENSION_ICON_ALIASES[extension] ?? extension ?? DEFAULT_FILE_ICON_NAME;
}

export function getIconPalette(iconName: string) {
  return ICON_COLOR_MAP[iconName] ?? ICON_COLOR_MAP.document!;
}

// document 固定给 "DOC"，folder 固定给 "DIR"；其余取把 -/_ 换成空格后的首词前三字符。
// 返回值统一大写，用作没有图标时的三字符占位。
export function getIconLabel(iconName: string): string {
  if (iconName === "document") {
    return "DOC";
  }

  if (iconName === "folder") {
    return "DIR";
  }

  const compactName = iconName.replace(/[_-]+/g, " ").trim();
  const firstWord = compactName.split(/\s+/)[0] ?? iconName;
  return firstWord.slice(0, 3).toUpperCase();
}

export function buildInlineSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
