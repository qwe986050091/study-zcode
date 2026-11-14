// INV-01 守住位置：本文件只做内置技能展示文案的静态映射；改错故障：在此处引入运行时状态或副作用会让文案层脱离纯函数边界，测试与复用随之失效。
// INV-02 守住位置：键空间归属为「官方内置插件名 + 技能名」两级；改错故障：把非官方技能塞进字典会让官方复审口径被污染，旧键被误认作官方来源。
// INV-03 守住位置：zh-CN 与 en-US 必须成对出现；改错故障：只补一侧会让另一种语言回退到原始英文描述，界面出现半汉化。
// INV-04 守住位置：字典值为逐字文案，不做插值；改错故障：在译文中混入占位符会因运行时不解析而原样透出给用户。
// INV-05 守住位置：locale 缺省视为 en-US；改错故障：把缺省改成 zh-CN 会让英文环境的中文键大面积命中。
// INV-06 守住位置：仅 scope 为 plugin 的技能参与官方判定；改错故障：放开该守卫会把用户自建同名技能误标为官方来源。
// INV-07 守住位置：插件名判定先于路径判定；改错故障：调换顺序会让路径被改写或指向软链的插件漏判。
// INV-08 守住位置：路径比较前统一把反斜杠归一为正斜杠；改错故障：跳过归一会让 Windows 上永远匹配不中 POSIX 形态的标记。
// INV-09 守住位置：官方插件名集合与路径标记集合需同步增删；改错故障：只改一侧会让同一插件在不同安装形态下判定结果不一致。
// INV-10 守住位置：命中官方字典即为终态，不再回读磁盘技能元数据；改错故障：再叠加一层读取会让展示文案与真实描述分叉。
// INV-11 守住位置：翻译缺失时回退到调用方传入的 description；改错故障：回退改为空串会让技能行在列表里静默丢失描述。
// INV-12 守住位置：来源标签只覆盖 workspace、plugin、user 三种 scope；改错故障：新增 scope 却漏改此处会默认落进用户分支而产生错误归属。
// INV-13 守住位置：来源标签与技能描述分属两层，互不嵌套；改错故障：把来源标签写进技能描述会让同一语义出现两个真源。
// INV-14 守住位置：字典键名与技能清单中的 name 完全一致，含连字符与大小写；改错故障：拼写漂移会让查询恒为 undefined 且没有任何报错。
// INV-15 守住位置：本模块不抛异常，任何未知输入都走回退；改错故障：抛错会把局部展示失败放大成整页技能列表不可用。
// INV-16 守住位置：新增语言需同时在类型与两条语言分支落地；改错故障：只加类型不加分支会让编译通过而运行时仍返回英文。
// INV-17 守住位置：逐字字典是刻意的豁免区，不走 i18n 格式化链路；改错故障：强行接入格式化会把译文里的百分号与花括号当占位符吞掉。
// INV-18 守住位置：改动文案需同步 en-US 与 zh-CN 的语义等价；改错故障：两边语义漂移会让同一技能在不同语言下的触发条件不一致。
//
// 模块职责：内置技能的中英展示文案字典与官方来源判定，为 UI 提供无副作用的纯查询。
// 状态所有权：常量字典由本文件独占持有并在模块加载后语义冻结，调用方只读，不得就地改写。
// 阅读顺序：先看两个官方插件白名单常量，再看技能文案字典，最后读三个导出与内部判定函数。
import type { Locale, SkillScope } from "@zcode/shared";

// 输入投影：调用方把技能清单裁剪成这五个字段后传入，本层不持有任何可变状态
// 字段语义：pluginName 仅当 scope 为 plugin 时有意义，其余来源一律留空
// 失败路径：字段缺失不抛错，判定函数按 falsy 处理并落到回退分支
// 权衡：宁可接受宽松结构也不做运行时校验，避免展示层阻塞在 schema 校验上
interface SkillDisplayCandidate {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  pluginName?: string;
}

// 白名单语义：只有此处列出的插件名才被视为随产品分发的官方内置插件
// 归属：集合成员由发布流程维护，第三方插件不得追加，避免官方标识被借用
// 失败路径：新增官方插件却漏登记时，会退化为路径标记判定或直接用原始描述
// 权衡：名单硬编码换取判定确定性，代价是每次新增插件都要同步本表
const OFFICIAL_BUILTIN_PLUGIN_NAMES = new Set([
  "android-emulator",
  "browser",
  "browser-use",
  "document-skills",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "ios-simulator",
  "restore-legacy-sessions",
  "skill-creator",
  "plugin-creator",
  "superpowers",
  "zcode-guide",
]);

// 兜底路径：插件名被改写或缺失时，用安装目录特征串反推是否官方分发
// 形态覆盖：同时收录正反斜杠两种分隔符，适配跨平台安装路径
// 失败路径：自定义安装目录不含标记则判定失败，属可接受的漏判而非误判
// 权衡：子串包含判定快且零依赖，代价是极端路径下可能判定过宽
const OFFICIAL_PLUGIN_PATH_MARKERS = [
  "/zcode-plugins-official/",
  "\\zcode-plugins-official\\",
  "/android-emulator-plugin/",
  "/browser-use-plugin/",
  "/document-skills-plugin/",
  "/documents-plugin/",
  "/pdf-plugin/",
  "/presentations-plugin/",
  "/spreadsheets-plugin/",
  "/ios-simulator-plugin/",
  "/restore-legacy-sessions-plugin/",
  "/skill-creator-plugin/",
  "/plugin-creator-plugin/",
  "/superpowers-plugin/",
  "/zcode-guide-plugin/",
];

// 键空间：一级键为技能 name，二级键为 Locale，二者共同构成文案寻址坐标
// 完整性约束：每个一级键必须同时给出 zh-CN 与 en-US，缺一侧即视为翻译缺陷
// 豁免边界：此字典是逐字文案，刻意绕开模板与复数规则，改字即改发布内容
// 失败路径：键不存在时查询得到 undefined，由上层回退到技能自带描述
// 权衡：扁平静态表便于人工校对与评审，代价是重复键只能靠评审发现
const BUILTIN_SKILL_DESCRIPTIONS: Record<string, Record<Locale, string>> = {
  "android-dev": {
    "zh-CN": "通过 android-emulator MCP 工具构建、运行、检查并轻量自动化 Android 应用。",
    "en-US": "Build, run, inspect, and lightly automate Android apps through the android-emulator MCP tools.",
  },
  "brainstorming": {
    "zh-CN": "在任何创造性工作前使用：创建功能、构建组件、增加能力或修改行为；先探索用户意图、需求和设计。",
    "en-US": "Use before any creative work, including creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements, and design before implementation.",
  },
  "control-browser": {
    "zh-CN": "控制 ZCode 内置浏览器，用于打开、检查、点击、输入、截图或验证网页和本地开发页面。",
    "en-US": "Control ZCode's built-in browser to open, inspect, click, type, screenshot, or verify webpages and local development targets.",
  },
  "dispatching-parallel-agents": {
    "zh-CN": "面对 2 个以上彼此独立、无共享状态或顺序依赖的任务时使用。",
    "en-US": "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies.",
  },
  // 示例锚点：以 docx 条目说明单个技能的文案形态，其余条目遵循同一约定
  // 逐字语义：值即最终展示文本，不做拼接、不做大小写或标点二次加工
  // 新增流程：先确认技能 name 与清单一致，再补齐两种语言，最后校对语义等价
  // 失败路径：漏写一种语言不会报错，只会让该语言用户看到英文兜底
  "docx": {
    "zh-CN": "完整的 DOCX 文档创建、编辑与分析能力，支持修订、批注、格式保持和文本提取。适用于创建新文档、修改内容、处理修订、添加批注或其它专业 Word 文档任务。",
    "en-US": "Create, edit, and analyze DOCX documents with revisions, comments, formatting preservation, and text extraction. Use for new documents, edits, revision handling, comments, and professional Word document work.",
  },
  "docx-viewer": {
    "zh-CN": "在 Word 文档侧栏与用户一起查看和讨论 .docx 文件。适用于打开、阅读、审阅或询问工作区中的 Word 文档，用户提到在查看器中选中或引用的内容，或需要检查刚生成的文档。",
    "en-US": "View and discuss Word (.docx) files with the user in the Documents side panel. Use to open, read, review, or ask about a workspace Word document, when the user refers to a selection or reference in the viewer, or to check a document you just produced.",
  },
  "executing-plans": {
    "zh-CN": "已有书面实现计划，并要在带评审检查点的独立会话中执行时使用。",
    "en-US": "Use when you have a written implementation plan to execute in a separate session with review checkpoints.",
  },
  "finishing-a-development-branch": {
    "zh-CN": "实现已完成、测试通过、需要决定如何合并、发 PR 或清理分支时使用。",
    "en-US": "Use when implementation is complete, tests pass, and you need to decide how to integrate the work through merge, PR, or cleanup.",
  },
  "ios-dev": {
    "zh-CN": "通过 ios-simulator MCP 工具构建、运行、检查并轻量自动化 iOS 模拟器应用。",
    "en-US": "Build, run, inspect, and lightly automate iOS Simulator apps through the ios-simulator MCP tools.",
  },
  "pdf": {
    "zh-CN": "专业 PDF 工具集，覆盖报告、创意视觉、学术 LaTeX 和现有 PDF 处理四条生产线。可按文档类型自动路由，支持报告、海报、论文、简历、提取、合并、拆分、表单填写和格式转换等任务。",
    "en-US": "Professional PDF toolkit for reports, creative visuals, academic LaTeX, and existing-PDF workflows. Supports reports, posters, papers, resumes, extraction, merge, split, forms, and conversion.",
  },
  "pdf-viewer": {
    "zh-CN": "在 PDF 侧栏与用户一起查看和讨论 PDF 文件。适用于打开、阅读、审阅或询问工作区中的 PDF，用户提到在查看器中选中或引用的内容，或需要检查刚生成的 PDF。",
    "en-US": "View and discuss PDF files with the user in the PDF side panel. Use to open, read, review, or ask about a workspace PDF, when the user refers to a selection or reference in the viewer, or to check a PDF you just produced.",
  },
  "pptx": {
    "zh-CN": "检查并窄范围更新从 PPTX 预览区选择的元素。通过完整文件指纹和 OOXML 定位校验 shape 文本或表格单元格，冲突时停止而不猜测。",
    "en-US": "Inspect and narrowly update elements selected in PPTX Preview Pane. Verifies the whole-file fingerprint and OOXML locator for shape or table-cell text, and stops on conflicts instead of guessing.",
  },
  "pptx-viewer": {
    "zh-CN": "在演示文稿侧栏与用户一起查看和讨论 .pptx 演示文稿。适用于一起打开、审阅或询问工作区中的演示文稿，用户提到在查看器中选中或引用的幻灯片或元素，或需要检查刚生成的演示文稿。",
    "en-US": "View and discuss PowerPoint (.pptx) decks with the user in the Presentations side panel. Use to open, review, or ask about a workspace deck together, when the user refers to a slide or shape selected or referenced in the viewer, or to check a deck you just produced.",
  },
  "receiving-code-review": {
    "zh-CN": "收到代码评审反馈、准备实现建议前使用；尤其当反馈不清楚或技术上可疑时，需要严谨验证而非盲目同意。",
    "en-US": "Use when receiving code review feedback before implementing suggestions, especially when feedback is unclear or technically questionable.",
  },
  "requesting-code-review": {
    "zh-CN": "完成任务、实现重大功能或合并前，用于请求代码评审以确认满足需求。",
    "en-US": "Use when completing tasks, implementing major features, or before merging to verify work meets requirements.",
  },
  "restore-legacy-sessions": {
    "zh-CN": "检查、规划或执行 ACP 时代 ZCode 旧 session 恢复到新的 ZCode 任务与会话库。",
    "en-US": "Inspect, plan, or restore old ACP-era ZCode sessions into the new ZCode task and session stores.",
  },
  "plugin-creator": {
    "zh-CN": "创建、校验 ZCode 插件，并指导本地安装与更新。",
    "en-US": "Create and validate ZCode plugins, and guide local installation and updates.",
  },
  "skill-creator": {
    "zh-CN": "创建新技能、编辑现有技能并迭代措辞。适用于从零编写 SKILL.md、改进已有技能、把重复工作流沉淀为可复用技能，或优化技能描述以提升触发可靠性。",
    "en-US": "Create new skills, edit existing skills, and iterate wording. Use for writing SKILL.md from scratch, improving skills, capturing repeated workflows, or tuning descriptions for reliable triggering.",
  },
  "subagent-driven-development": {
    "zh-CN": "在当前会话中执行包含独立任务的实现计划时使用。",
    "en-US": "Use when executing implementation plans with independent tasks in the current session.",
  },
  "systematic-debugging": {
    "zh-CN": "遇到任何 bug、测试失败或异常行为时，在提出修复前使用。",
    "en-US": "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.",
  },
  "test-driven-development": {
    "zh-CN": "实现任何功能或 bugfix 时，在编写实现代码前使用。",
    "en-US": "Use when implementing any feature or bugfix, before writing implementation code.",
  },
  "using-git-worktrees": {
    "zh-CN": "开始需要隔离的功能工作或执行实现计划前使用，确保存在隔离 workspace，优先使用原生工具，否则回退 git worktree。",
    "en-US": "Use when starting feature work that needs isolation or before executing implementation plans. Ensures an isolated workspace exists via native tools or git worktree fallback.",
  },
  "using-superpowers": {
    "zh-CN": "开始任何对话时使用；说明如何查找和使用技能，并要求在任何回复包括澄清问题前调用 Skill 工具。",
    "en-US": "Use when starting any conversation. Establishes how to find and use skills, requiring Skill tool invocation before any response including clarifying questions.",
  },
  "verification-before-completion": {
    "zh-CN": "准备声明工作完成、已修复或测试通过前使用；要求先运行验证命令并确认输出，先有证据再下结论。",
    "en-US": "Use before claiming work is complete, fixed, or passing. Requires running verification commands and confirming output before success claims.",
  },
  "web-gui-tester": {
    "zh-CN": "使用 ZCode Browser Use 对网页和本地 Web 前端执行纯 GUI 黑盒测试，通过真实用户交互、DOM 语义证据和截图验证功能、交互与响应式布局。",
    "en-US": "Run pure GUI black-box tests against websites and local web frontends with ZCode Browser Use, combining real user interactions, semantic DOM evidence, and inspected screenshots.",
  },
  "writing-plans": {
    "zh-CN": "已有规格或多步骤任务需求，在动代码前用于编写实现计划。",
    "en-US": "Use when you have a spec or requirements for a multi-step task, before touching code.",
  },
  "writing-skills": {
    "zh-CN": "创建新技能、编辑现有技能或在发布前验证技能是否有效时使用。",
    "en-US": "Use when creating new skills, editing existing skills, or verifying skills work before deployment.",
  },
  "xlsx-viewer": {
    "zh-CN": "在电子表格侧栏与用户一起查看和讨论 .xlsx 工作簿。适用于一起打开、浏览或询问工作区中的工作簿，用户提到在查看器中选中或引用的单元格，或需要检查刚生成的工作簿。",
    "en-US": "View and discuss Excel (.xlsx) workbooks with the user in the Spreadsheets side panel. Use to open, browse, or ask about a workspace workbook together, when the user refers to cells selected or referenced in the viewer, or to check a workbook you just produced.",
  },
};

// 职责：把内部 scope 枚举翻译成用户可见的来源标签，纯查表且无副作用
// 分支顺序：先分语言再分 scope，保证两种语言结构对称便于对照审查
// 失败路径：未知 scope 落进最后一条兜底分支并显示为“用户”，不抛异常
// 权衡：用连续判断替代映射表，换取分支可就近扩展，代价是新增 scope 需改两处
// 一致性：中文与英文分支必须同步增删，否则会出现某一侧漏配
export function resolveSkillSourceLabel(scope: SkillScope, locale?: Locale): string {
  if (locale === "zh-CN") {
    if (scope === "workspace") return "工作区";
    if (scope === "plugin") return "插件";
    return "用户";
  }
  if (scope === "workspace") return "Workspace";
  if (scope === "plugin") return "Plugin";
  return "User";
}

// 入口语义：优先返回官方内置字典文案，未命中时原样透出技能自带描述
// 状态所有权：只读字典与入参，不写缓存也不改技能对象，便于重复调用
// 判定门槛：只有被识别为官方插件的技能才进入字典查询，其余直接短路
// 缺省策略：locale 未传按 en-US 处理，与字典的二级键约定保持一致
// 失败路径：技能名或语言任一缺失都得到 undefined，由空值合并落到原始描述
// 权衡：不做按语言的逐级降级，换取行为可预测，代价是缺翻译时整段回退
export function resolveSkillDisplayDescription(
  skill: SkillDisplayCandidate,
  locale?: Locale,
): string {
  const localized = isOfficialBuiltinSkill(skill)
    ? BUILTIN_SKILL_DESCRIPTIONS[skill.name]?.[locale ?? "en-US"]
    : undefined;
  return localized ?? skill.description;
}

// 内部守卫：先确认来源为插件，再依次尝试插件名与安装路径两条判定线
// 短路设计：插件名命中即返回，不再计算路径，减少字符串归一的开销
// 失败路径：非插件来源或两条判定都未命中时返回 false，调用方因此回退原始描述
// 权衡：名与路径双通道提升召回，代价是两处名单必须同步维护
function isOfficialBuiltinSkill(skill: SkillDisplayCandidate): boolean {
  if (skill.scope !== "plugin") {
    return false;
  }
  const pluginName = skill.pluginName?.trim();
  if (pluginName && OFFICIAL_BUILTIN_PLUGIN_NAMES.has(pluginName)) {
    return true;
  }
  const normalizedPath = skill.path.replaceAll("\\", "/");
  return OFFICIAL_PLUGIN_PATH_MARKERS.some((marker) => normalizedPath.includes(marker));
}
