// 能力群、节点与连线必须作为同一份审计数据集整体校验，避免跨文件产生悬空引用。
// 数据层说明：system/group/node/edge 四类定义先以紧凑 tuple 维护，导出时再映射为对象；
// 导出数组的顺序即 UI 分组与布局顺序，id 为跨文件引用键，必须全局唯一。
// 本文件是纯静态数据，无 IO/副作用；增删节点或边需同步对应的 spec 与覆盖率审计清单。
// ===== 深度注释：能力图谱数据层（纯静态事实，运行时只读）=====
// 职责边界（做什么 / 不做什么 / 依赖谁）：
// - 做：以紧凑 tuple 维护 system / group / node / edge 四层事实，导出为对象数组，供能力图与覆盖率审计共用同一份数据。
// - 做：把「谁拥有哪块事实」写进 scope 与 authority，让跨层依赖可被人工复核，而不是靠命名猜。
// - 不做：不做引用完整性校验、不统计真实代码行数、不读文件系统、不写存储、不发事件、不参与运行时决策。
// - 依赖：只依赖 TypeScript 类型系统；展示名依赖 capabilityRelationNames，导出数组被 UI 与审计脚本直接消费。
//
// 不变量（INV，改动前逐条确认；违反任意一条都会让页面或审计静默失真）：
// INV-01 断言：system id 集合必须闭合，且被所有 group.systemId 引用 —— 守住它的位置：systemDefinitions —— 改错故障：缺失系统时能力图分区整块不渲染。
// INV-02 断言：systemDefinitions 顺序固定为 renderer→host→zcode-cli→engineering-infrastructure —— 守住它的位置：数组字面量顺序 —— 改错故障：层级颠倒会让依赖边反向、布局抖动。
// INV-03 断言：groupDefinitions 的 tuple 顺序即 UI 分组顺序 —— 守住它的位置：groupDefinitions —— 改错故障：审计报告分组与设计文档对不上。
// INV-04 断言：node id 全局唯一 —— 守住它的位置：nodeDefinitions —— 改错故障：重复 id 让边指向先声明者，另一组能力静默缺边。
// INV-05 断言：edge id 由数组下标生成（edge-1 起），中间插入即改号 —— 守住它的位置：capabilityEdges.map —— 改错故障：外部按 edge-N 引用的审计基线整体漂移。
// INV-06 断言：codeEstimate 归属能力群，不得用节点代码量累加 —— 守住它的位置：groupDefinitions 后两列 —— 改错故障：节点重叠导致重复计数，覆盖率分母虚高。
// INV-07 断言：confidence 只表达人工估算可信度，不参与任何计算 —— 守住它的位置：CapabilityCodeEstimate —— 改错故障：下游把 medium 当阈值，误判缺口。
// INV-08 断言：capabilityRelationNames 必须覆盖 CapabilityRelationType 全集 —— 守住它的位置：Record 类型 —— 改错故障：新增关系类型漏名，图例显示 undefined。
// INV-09 断言：导入层不校验悬空边 —— 守住它的位置：capabilityEdges —— 改错故障：加严格校验会让历史数据整体加载失败，首页白屏。
// INV-10 断言：owner 是责任角色而非个人 —— 守住它的位置：所有 Definitions —— 改错故障：人员变动后数据过期，责任归属失效。
// INV-11 断言：authority 描述事实来源，不写实现文件路径 —— 守住它的位置：nodeDefinitions 第 5 列 —— 改错故障：路径重构后数据变成伪事实，审计误判。
// INV-12 断言：scope 必须显式区分「当前」与「规划」 —— 守住它的位置：office/automation 相关节点 —— 改错故障：planned 能力被算进覆盖率分子，对外承诺失真。
// INV-13 断言：productionLines 是非精确估算，保留数字分隔符 —— 守住它的位置：groupDefinitions —— 改错故障：被当成精确统计后用于性能预算。
// INV-14 断言：导出数组名（capabilitySystems/Groups/Nodes/Edges）保持稳定 —— 守住它的位置：文件尾部 —— 改错故障：改名打断 UI 与审计脚本的跨包导入。
// INV-15 断言：edge 的 label 面向读者，不作为匹配键 —— 守住它的位置：tuple 第 4 列 —— 改错故障：文案本地化后按 label 匹配全部断裂。
// INV-16 断言：所有 id 使用 kebab-case 且大小写一致 —— 守住它的位置：四类定义 —— 改错故障：跨文件引用按大小写敏感失配。
// INV-17 断言：新增节点必须同时补所属 group 与相关边 —— 守住它的位置：nodeDefinitions 尾部 —— 改错故障：孤立节点在图上不可达，覆盖率漏算。
// INV-18 断言：本文件无副作用、无 IO —— 守住它的位置：顶层导出 —— 改错故障：引入读取后 build 不再确定性，缓存失效。
// INV-19 断言：export 声明不冻结内部 tuple —— 守住它的位置：map 返回 —— 改错故障：冻结会阻断测试夹具的深拷贝。
// INV-20 断言：relation type 只驱动着色与图例，不表达执行先后 —— 守住它的位置：CapabilityRelationType —— 改错故障：被当成调度顺序会产生错误依赖。
//
// 标注约定：[契约] 对外数据结构；[事务] 跨文件一致性；[权衡] 强度与成本的取舍。
/* oxlint-disable max-lines */
// 能力关系类型：delivery 交付、invariant 隔离/不变量、runtime 执行、shared 共享、state 状态；
// 取值同时驱动边着色与图例，新增取值必须同步 capabilityRelationNames。
export type CapabilityRelationType = "delivery" | "invariant" | "runtime" | "shared" | "state";

// 代码量估算的置信等级，只表达人工估算可信度（high → medium-low 递减），不参与任何计算。
export type CapabilityCodeEstimateConfidence = "high" | "medium-high" | "medium" | "medium-low";

// 单个能力群的代码规模估算：productionLines 为生产代码行数近似值（非精确统计）；
// confidence 标明估算可信度，展示时需保留不确定性措辞，避免被当作精确指标。
export interface CapabilityCodeEstimate {
  productionLines: number;
  confidence: CapabilityCodeEstimateConfidence;
}

// 系统层（渲染层/宿主层/CLI/工程基建）：owner 是责任角色而非个人；
// description 说明该层边界以及明确不拥有的状态。
export interface CapabilitySystem {
  id: string;
  name: string;
  owner: string;
  description: string;
}

// 能力群：systemId 必须指向 capabilitySystems 中的 id；codeEstimate 归属群粒度，
// 不由节点代码量累加得出，避免节点重叠导致重复计数。
export interface CapabilityGroup {
  id: string;
  systemId: string;
  name: string;
  owner: string;
  description: string;
  codeEstimate: CapabilityCodeEstimate;
}

// 能力节点：id 全局唯一，groupId 必须指向能力群；scope 描述职责范围，
// authority 标注权威归属方（如 Renderer local draft / CLI 运行时），用于判断事实来源。
export interface CapabilityNode {
  id: string;
  groupId: string;
  label: string;
  scope: string;
  authority: string;
}

// 能力依赖边：source/target 指向节点 id，方向按 label 语义阅读（通常是依赖方 → 被依赖方）；
// id 在导出时按数组下标生成（edge-1 起），label 是面向读者的关系说明。
export interface CapabilityEdge {
  id: string;
  source: string;
  target: string;
  type: CapabilityRelationType;
  label: string;
}

// 定义期使用的紧凑 tuple 类型：字段顺序与下方 *Definitions 数组一一对应，
// 目的是一条记录压成一行便于 review；导出层再映射为具名对象，顺序不可随意调整。
// [契约] 群 tuple 的 7 个位置与导出映射一一对应；用位置而非字段名是为了让每条记录压成一行便于 review。
// 调整字段顺序必须同时改 CapabilityGroupDefinition、groupDefinitions 与 capabilityGroups 的解构，缺一处就会静默错位。
type CapabilityGroupDefinition = readonly [
  id: string,
  systemId: string,
  name: string,
  owner: string,
  description: string,
  productionLines: number,
  confidence: CapabilityCodeEstimateConfidence,
];

// 系统 tuple 只有描述字段，没有可执行语义；任何派生值（统计、颜色）都由消费方计算，不写回定义。
type CapabilitySystemDefinition = readonly [
  id: string,
  name: string,
  owner: string,
  description: string,
];

// 节点 tuple 固定 5 列；scope 与 authority 都是必填，不允许留空表达「未知」。
// 空字符串会被 UI 直接渲染成空白单元格，看起来像数据缺失而不是设计选择。
type CapabilityNodeDefinition = readonly [
  id: string,
  groupId: string,
  label: string,
  scope: string,
  authority: string,
];

// 边 tuple 不含 id：id 是导出时按下标生成的派生值，避免手写序号与数组位置不一致。
type CapabilityEdgeDefinition = readonly [
  source: string,
  target: string,
  type: CapabilityRelationType,
  label: string,
];

// 系统清单：四个纵向层级，顺序决定能力图分区；owner 为角色名，description 说明该层拥有/不拥有的事实。
// 系统清单是能力图的第一层分区：四层语义固定，节点只能挂到已登记系统下，新增系统要同步图例与审计脚本。
// 本数组顺序即渲染顺序，调整顺序会改变读者对「谁依赖谁」的第一印象，因此不按字母序重排。
// [契约] tuple 字段顺序必须与 CapabilitySystemDefinition 严格一致，导出层按位置解构。
const systemDefinitions: readonly CapabilitySystemDefinition[] = [
  [
    "renderer",
    // 渲染层只拥有交互与只读投影，不拥有 session/turn 事实；把 Runtime 状态搬进来会让 UI 变成第二事实源。
    // 本层作者归属统一以 Renderer 前缀声明，便于审计时快速区分「展示」与「权威」。
    "渲染层（Renderer）",
    "产品体验负责人（Product Experience Owner）",
    "Desktop、Web 与 Mobile 的产品界面、交互意图和只读投影；不拥有 Agent 或会话事实。",
  ],
  [
    "host",
    // 宿主层负责进程监督、协议路由与跨端交付，不复制 CLI 业务状态；复制会让重连前后两端口径不一致。
    // owner 是角色而非个人，人员变动不改数据。
    "宿主层（Host）",
    "宿主与平台负责人（Host & Platform Owner）",
    "Local/Remote Host、平台服务、进程监督、协议路由与跨端交付；不复制 CLI 业务状态。",
  ],
  [
    "zcode-cli",
    // CLI 是 Agent、会话、模型、工具与扩展的唯一权威运行时；本层节点描述权威归属，不是 UI 文案。
    // 任何写操作都必须落在本层声明的运行时，不允许 Renderer 在本地补齐。
    "智能体运行层（ZCode CLI）",
    "CLI 运行时负责人（CLI Runtime Owner）",
    "Agent、Conversation、Model、Tool 与 Extension 的权威运行时、投影、持久化和恢复。",
  ],
  [
    "engineering-infrastructure",
    // 工程基建只验证与交付前三层，不进入线上请求链；把它当运行时依赖会引入发布耦合与循环依赖。
    // 质量与测试节点不得把产品埋点混入统计口径。
    "工程基础设施（Engineering Infrastructure）",
    "研发效能负责人（Developer Productivity Owner）",
    "产品运行时之外的构建、测试、质量度量与发布平台；只验证和交付前三层，不进入线上请求链。",
  ],
];

// 能力群清单：每组归属一个 systemId，并附带生产代码行数估算与置信度；
// 顺序按系统内产品域排列，直接决定能力图分组顺序。
// 能力群是「产品域」粒度，不是代码目录粒度；一个群可以跨多个包，但只能有一个责任 owner。
// codeEstimate 放在群上而不是节点上，是因为节点会重叠（同一文件被多个能力引用），累加必然重复计数。
// 组顺序决定能力图分组顺序，改名或换位都要同步覆盖率审计清单。
const groupDefinitions: readonly CapabilityGroupDefinition[] = [
  [
    // 渲染层对话域：输入、时间线、动作、媒体预览同组，只声明 projection 所有权；把 turn 事实写进来会产生第二份真源。
    // 调整本组节点时同步 conversation-runtime 组，避免同一事实在两个 group 各写一份、各自演化。
    "conversation-experience",
    "renderer",
    "对话与任务体验（Conversation & Task Experience）",
    "对话体验负责人（Conversation Experience Owner）",
    "负责 Composer、会话投影展示、会话动作、任务导航、媒体预览和 Hook 摘要体验。",
    78_200,
    "medium",
  ],
  [
    // 模型/账户体验只做选择与展示，provider 配置真值在 host 的 provider 域；这里不得出现配置写入方。
    // 套餐状态以 entitlement 快照为准，UI 不缓存金额与配额结果。
    "model-account-experience",
    "renderer",
    "模型与账户体验（Model & Account Experience）",
    "模型与账户体验负责人（Model & Account Experience Owner）",
    "负责 Provider/Model 选择、套餐状态、购买和用量界面。",
    30_200,
    "medium-high",
  ],
  [
    // 扩展体验是设置入口集合，MCP 诊断只读 Host 投影；在本组补写入逻辑会让诊断与实际连接状态不一致。
    "extension-experience",
    "renderer",
    "扩展体验（Extension Experience）",
    "扩展体验负责人（Extension Experience Owner）",
    "负责 Plugin、Skill、MCP、Hooks 等扩展的设置、市场、导入和连接诊断入口。",
    36_300,
    "medium",
  ],
  [
    // 浏览器/文件/终端/Git 只是渲染壳，文件与 PTY 事实在 Host service；本组不得声明文件系统所有权。
    // tab 上限与复用策略属于 browser-platform，不在 UI 组重复定义。
    "browser-workbench-experience",
    "renderer",
    "浏览器与开发工作台体验（Browser & Workbench Experience）",
    "工作台体验负责人（Workbench Experience Owner）",
    "负责 Browser、File、Terminal、Git/Diff 与仓库知识界面。",
    22_800,
    "medium-high",
  ],
  [
    // 本组混编「当前已交付」与「孵化/规划」，scope 必须在句首标明状态；否则覆盖率审计会把规划项当已实现。
    // Office 预览不等于原生编辑器：任何节点不得把「可预览」写成「可编辑」。
    "office-computer-use-incubation",
    "renderer",
    "办公套件与计算机操作孵化（Office Suite & Computer Use Incubation）",
    "智能工作空间负责人（Intelligent Workspace Owner）",
    "负责办公套件预览/编辑和 Computer Use 产品化体验；当前已有 PDF、DOCX/DOC、XLSX 只读预览、全格式文档 Skills 与 macOS/Windows CUA beta，其余节点明确标记为孵化或规划。",
    1_200,
    "medium-high",
  ],
  [
    // 定时/闲时/Bot 的配置与历史 UI；运行态由 Host 调度器回写，本组不持有任务状态机。
    "automation-experience",
    "renderer",
    "自动化体验（Automation Experience）",
    "自动化体验负责人（Automation Experience Owner）",
    "负责定时自动化、闲时任务和 Bot 的配置、历史与状态界面。",
    11_700,
    "high",
  ],
  [
    // 设计系统、主题、i18n 与设置壳；跨窗口同步走 broadcast，业务状态不落在本组。
    // 主题/语言字段必须防回环，不能把本地偏好当作服务端事实。
    "ui-platform",
    "renderer",
    "UI 平台（UI Platform）",
    "UI 平台负责人（UI Platform Owner）",
    "负责设计系统、主题、国际化、响应式和 Settings/Onboarding 框架。",
    55_400,
    "medium-low",
  ],
  [
    // 用量看板与反馈入口；数字来自 usage bridge 快照，本组不做本地估算与补齐。
    "insights-feedback",
    "renderer",
    "数据洞察与反馈体验（Insights & Feedback Experience）",
    "洞察体验负责人（Insights Experience Owner）",
    "负责 App Usage 可视化、Feedback 入口与进程监视展示。",
    6_000,
    "medium-high",
  ],
  [
    // OAuth/套餐/支付事实都在 Host 侧解析；Renderer 自报的身份不被采信，本组不得新增本地身份推导。
    // Coding/Start/Team 三类套餐共享 plan-identity 解析，避免各自维护一套判定。
    "account-entitlements",
    "host",
    "账户与权益（Account & Entitlements）",
    "账户与权益负责人（Account & Entitlements Owner）",
    "负责 OAuth、Credential、Plan Identity、Start/Coding/Team Plan、支付与远端额度。",
    9_500,
    "medium",
  ],
  [
    // 安装、升级与跨端同步；资源贡献清单来自 Host，UI 不重新合并资源。
    "extension-management",
    "host",
    "扩展管理与同步（Extension Management & Sync）",
    "扩展管理负责人（Extension Management Owner）",
    "负责 Plugin 安装升级、扩展资源贡献和跨本地/远程同步。",
    11_400,
    "high",
  ],
  [
    // WebContentsView、CDP backend 与 CUA helper 生命周期都在 Main；32-tab 上限是硬约束，不得按需放宽。
    // CUA 权限 broker 必须 fail-closed，缺失可信 Host 时拒绝而不是降级。
    "browser-platform",
    "host",
    "浏览器与计算机操作平台（Browser & Computer Use Platform）",
    "浏览器平台负责人（Browser Platform Owner）",
    "负责 WebContentsView、CDP backend、Computer Use Helper 生命周期、可信 broker、系统观察与原生输入。",
    14_500,
    "high",
  ],
  [
    // 身份、Local/Remote Host 与双端交付边界；workspaceKey 是隔离键，路径只用于文件操作与展示。
    // desktop-continuous 与 mobile-replayable 是两条链路，不得混用恢复语义。
    "workspace-delivery",
    "host",
    "工作区与交付（Workspace & Delivery）",
    "远程运行时负责人（Remote Runtime Owner）",
    "负责 workspace identity、Local/Remote Host、SSH 与 desktop/mobile 交付边界。",
    73_100,
    "medium-low",
  ],
  [
    // File/Terminal/Git/索引服务；workspace 隔离在本层强制，调用方不需要也不允许自行拼接路径做隔离。
    "workbench-services",
    "host",
    "工作台服务（Workbench Services）",
    "工作台服务负责人（Workbench Services Owner）",
    "负责 File、Terminal、Git、Repo Wiki、Repo Snapshot 与索引服务。",
    19_100,
    "medium-high",
  ],
  [
    // scheduler、闲时凭证与 Bot 渠道；闲时任务必须先取号再执行，跳过凭证会绕过服务端准入。
    "automation-channel",
    "host",
    "自动化与渠道运行时（Automation & Channel Runtime）",
    "编排负责人（Orchestration Owner）",
    "负责 scheduler、持久化任务、闲时准入、Bots 与第三方消息渠道。",
    18_300,
    "medium-high",
  ],
  [
    // Electron 生命周期、更新与诊断包；Main 不承载 task/session 业务状态。
    "client-platform",
    "host",
    "客户端平台（Client Platform）",
    "客户端平台负责人（Client Platform Owner）",
    "负责 Electron 生命周期、客户端更新、反馈工单和诊断包。",
    31_200,
    "medium-low",
  ],
  [
    // 埋点、ARMS 与日志是旁路能力：上报失败只能降级为 warn，不能改写业务流程的成败。
    // App Usage 桥只转发快照，不扫描会话文件、不估算、不持久化事实。
    "data-observability",
    "host",
    "数据与可观测性（Data & Observability）",
    "数据与可观测性负责人（Data & Observability Owner）",
    "负责 App Usage bridge、产品埋点、Conversation telemetry、ARMS、性能可靠性和日志。",
    9_300,
    "medium",
  ],
  [
    // turn 状态机、上下文、记忆与压缩的唯一所有者；其他层只能观察其投影。
    "agent-core",
    "zcode-cli",
    "智能体核心（Agent Core）",
    "智能体内核负责人（Agent Kernel Owner）",
    "负责 runtime 装配、turn 状态机、上下文、memory、compact、stream recovery 与 target continuation。",
    23_646,
    "medium",
  ],
  [
    // session 生命周期、输入接纳、事件账本与产品投影；已接受的 busy 输入必须串行 admission。
    // 恢复链路依赖严格事件顺序，任何重排都会造成重连后状态跳跃。
    "conversation-runtime",
    "zcode-cli",
    "对话运行时（Conversation Runtime）",
    "对话运行时负责人（Conversation Runtime Owner）",
    "负责 session lifecycle、input admission、queue、event journal、ProductProjection 与恢复。",
    42_098,
    "medium-high",
  ],
  [
    // provider runtime 与模型事实；token 预算与模态 gating 以 Active Model 属性为准，不按模型名猜。
    "models",
    "zcode-cli",
    "模型能力（Model Capabilities）",
    "模型能力负责人（Model Capability Owner）",
    "负责 provider runtime、模型目录、token 预算、多模态和推理工具能力。",
    14_451,
    "high",
  ],
  [
    // 工具调度、权限审批与模式策略；审批必须先于执行，顺序对调等于绕过权限。
    "tool-safety",
    "zcode-cli",
    "工具运行时与安全（Tool Runtime & Safety）",
    "工具与安全负责人（Tool & Safety Owner）",
    "负责内置工具、调度、权限、模式策略和工具执行结果。",
    30_980,
    "medium-high",
  ],
  [
    // 子代理 profile 与 child runtime；raw child 事件不得混入父 turn，交互必须经 broker 路由。
    "multi-agent",
    "zcode-cli",
    "多智能体（Multi-Agent）",
    "多智能体负责人（Multi-Agent Owner）",
    "负责 Subagent profile、child runtime、交互协调与后台任务。",
    7_088,
    "high",
  ],
  [
    // MCP/Skill/Hooks/Commands 的资源发现与执行；扩展加载优先级是唯一真源，UI 不重复合并。
    "extension-runtime",
    "zcode-cli",
    "扩展运行时（Extension Runtime）",
    "扩展运行时负责人（Extension Runtime Owner）",
    "负责 MCP、Skill、Hooks、Commands 与 Memory resources 的发现和执行。",
    20_653,
    "medium-high",
  ],
  [
    // Browser Use Plugin、Node REPL 与 headless backend；没有 Desktop Main 时也必须能独立工作。
    "browser-runtime",
    "zcode-cli",
    "浏览器运行时（Browser Runtime）",
    "浏览器运行时负责人（Browser Runtime Owner）",
    "负责 Browser Use Plugin、Node REPL/Playwright 与 Headless backend。",
    7_901,
    "high",
  ],
  [
    // usage 事实与 SQLite 保留策略；30 天保留是硬约束，清理逻辑不得随查询频率变化。
    "usage-observability",
    "zcode-cli",
    "用量可观测存储（Usage Observability）",
    "用量数据负责人（Usage Data Owner）",
    "负责 model/turn/tool usage 事实、SQLite 30 天保留和 App Usage 聚合。",
    1_539,
    "high",
  ],
  [
    // 构建、签名与发布 DAG；静态质量门禁是发布前置，不能在流水线里绕过。
    "build-release-engineering",
    "engineering-infrastructure",
    "构建与发布工程（Build & Release Engineering）",
    "构建发布负责人（Build & Release Owner）",
    "负责 GitLab pipeline、跨平台构建、打包签名、公证、制品、CDN 与灰度/稳定发布。",
    12_600,
    "medium-high",
  ],
  [
    // E2E harness、capture/replay 与故障注入；夹具必须确定性，任何真实网络依赖都会让结果不可复现。
    "test-automation-platform",
    "engineering-infrastructure",
    "测试自动化平台（Test Automation Platform）",
    "测试平台负责人（Test Platform Owner）",
    "负责 Desktop/CLI E2E harness、capture/replay、跨平台执行、故障注入与用例晋级。",
    26_400,
    "medium",
  ],
  [
    // 静态门禁与报告口径（quality-* 指标），不与产品埋点数据混存。
    "quality-intelligence",
    "engineering-infrastructure",
    "质量数据与工程治理（Quality Intelligence & Engineering Governance）",
    "质量工程负责人（Quality Engineering Owner）",
    "负责 E2E 报告、覆盖率、质量趋势、静态门禁、工程性能与失败制品。",
    12_800,
    "medium-high",
  ],
];

// 节点 tuple 字段顺序：id、所属 groupId、label、scope（职责说明）、authority（权威归属）；
// 新增节点必须同时补所属 group 与相关边；导出层不做引用校验，悬空 id 只会表现为图上断线。
// 能力节点是一份人工维护的紧凑清单；每个 tuple 保持一行，便于 review。
// prettier-ignore 只保护节点 tuple 的一行一条格式；删除它会让每条记录展开成多行，review 成本骤增。
// prettier-ignore
const nodeDefinitions: readonly CapabilityNodeDefinition[] = [
  // Composer 只持有未提交草稿与 intent，提交后由 CLI admission 接管；在这里存 accepted queue 会造出第二条写入路径。
  // 附件只保存引用，不保存二进制；媒体能力按 Active Model 的输入格式 gating，不按文件扩展名猜测。
  // 模型/模式选择的默认值来自 Host 投影，UI 不自行推导 provider 可用性。
  ["composer", "conversation-experience", "输入与意图（Composer & Intent）", "输入草稿、附件引用、模型/模式选择、媒体能力提示和 command intent。", "Renderer local draft"],
  ["plan-shortcut", "conversation-experience", "Plan 快捷入口（Plan Shortcut）", "`/plan` 空命令只切换 Plan Mode；带任务文本时 compare-and-set 切换并提交，附件场景拒绝 shortcut。", "Renderer slash command + CLI mode policy"],
  ["conversation-projection-store", "conversation-experience", "会话投影缓存（Conversation Projection Store）", "订阅 snapshot/delta，维护窗口内只读 projection cache。", "Renderer ConversationProjectionStore"],
  ["conversation-ui", "conversation-experience", "对话时间线（Conversation Timeline）", "消息、reasoning、tool、Hook 摘要、状态栏和交互弹窗。", "Renderer projection views"],
  ["conversation-actions", "conversation-experience", "会话动作（Conversation Actions）", "send、queue、stop、edit、retry、fork、goal、compact 的 UI intent。", "Renderer command intent"],
  ["task-navigation", "conversation-experience", "任务导航（Task Navigation）", "项目/分组/时间线任务列表、搜索与 Command Center。", "Renderer task list projection"],
  ["attachment-ux", "conversation-experience", "附件体验（Attachment Experience）", "本地/远程附件选择、预览、prompt 引用和 image/video 能力 gating。", "Renderer attachment draft"],
  ["sent-media-preview", "conversation-experience", "已发送媒体预览（Sent Media Preview）", "已发送 image/video 的有序 gallery、视频首帧/播放和安全的 local/remote chunk preview。", "Renderer media preview + Host authorized preview"],
  ["hook-turn-summary", "conversation-experience", "本轮 Hook 摘要（Turn Hook Summary）", "仅真实 client-visible Hook 执行显示 Anchor/Popover；按来源、状态、耗时呈现安全摘要，不展示敏感命令或路径。", "Conversation projection + ConversationHookDetailsAction"],
  // 设置表单只提交草稿，Provider 配置的原子写入由 ProviderConfigService 统一执行。
  // 固定 Account Provider 的 access 只能由 Built-in Config 声明，表单不得尝试改写。
  // 删除后的自定义 Provider 不能被迟到保存复活，本层不提供「不存在则创建」的语义。
  ["provider-settings", "model-account-experience", "供应商与连接设置（Provider & Connection Settings）", "Builtin/custom provider、连接表单、账号状态与默认项。", "Renderer settings forms"],
  ["model-selector", "model-account-experience", "模型选择器（Model Selector）", "共享候选、分组、过滤与展示，含 image/video 模态 badges 与 reasoning 选项；各入口独立提交。", "Renderer selection builders"],
  ["plan-status-ui", "model-account-experience", "套餐状态与购买界面（Plan Status & Purchase UI）", "Start/Coding/Team Plan 状态卡、购买、升级和项目选择。", "Renderer plan settings"],
  ["plan-usage-ui", "model-account-experience", "套餐用量界面（Plan Usage Surfaces）", "Settings 图表、侧栏 remaining 与 composer 套餐提示。", "Renderer plan usage state"],
  // 扩展设置是入口聚合，不拥有安装状态；安装/升级由 Host plugin management 落盘。
  // MCP 诊断读取连接投影，不主动发起 tools/list；主动探测会干扰真实连接生命周期。
  // 按 pluginId 归属分组是为了定位问题，不是权限边界。
  ["extension-settings", "extension-experience", "扩展设置（Extension Settings）", "Plugin、Skill、MCP、Hooks、Commands 和 Memory 配置入口，含本地化 MCP 诊断与 Plugin 归属分组。", "Renderer extension settings"],
  ["mcp-settings-diagnostics", "extension-experience", "MCP 设置诊断（MCP Settings Diagnostics）", "按 pluginId 归属展示 initialize/tools/list、连接状态、失败类型、本地化详情和 request ID。", "Renderer MCP settings projection"],
  ["plugin-marketplace-ui", "extension-experience", "插件市场界面（Plugin Marketplace UI）", "市场浏览、安装确认、升级和启停状态。", "Renderer marketplace state"],
  // 浏览器 UI 只渲染 tab 与导航状态，WebContentsView 的挂载与生命周期在 Main。
  // 32 个 tab 是进程内硬上限；UI 不得在超限时静默新开，必须给出可解释反馈。
  // open 默认复用同站点 tab 的策略属于 browser-tab-residency，不在本节点重复实现。
  ["embedded-browser-ui", "browser-workbench-experience", "内置浏览器界面（Embedded Browser UI）", "Tab、导航、侧边窗格、页面状态和 open 复用反馈展示。", "Renderer browser state"],
  ["file-tree", "browser-workbench-experience", "文件树与预览（File Tree & Preview）", "懒加载文件树、预览、watcher 投影和文件提及。", "Renderer file state"],
  ["terminal-ui", "browser-workbench-experience", "终端界面（Terminal UI）", "多 tab、输入输出、链接和生命周期展示。", "Renderer terminal registry"],
  ["git-diff-ui", "browser-workbench-experience", "Git 与差异界面（Git & Diff UI）", "状态、diff、stage、commit 和分支交互。", "Renderer Git state"],
  // 当前只读预览，任何「保存/编辑」入口都必须等 Host document service 落地后再接。
  // 读取限定在 workspace 内，通过 file service 的 readBinaryPreview，不允许 UI 直接拼绝对路径。
  // 预览失败必须降级为可读错误，不能把整页设置页拖垮。
  ["office-document-preview", "office-computer-use-incubation", "办公文档与 PDF 预览（Office Document & PDF Preview）", "当前：PDF、DOCX/DOC、XLSX 只读预览、分页/缩放和 workspace 文件读取。孵化：目录、批注、修订和 PPTX 预览。", "Renderer preview state"],
  ["office-spreadsheet-workbench", "office-computer-use-incubation", "电子表格预览与编辑（Spreadsheet Preview & Editing）", "当前：XLSX/XLSM/XLS 只读 sheet 预览；不承诺公式、图表、导出或单元格写回。规划：公式、图表和单元格编辑。", "Renderer editor draft (planned)"],
  ["office-presentation-workbench", "office-computer-use-incubation", "演示文稿预览与编辑（Presentation Preview & Editing）", "规划：PPTX 缩略图、幻灯片预览、元素编辑、讲者备注和导出。", "Renderer editor draft (planned)"],
  ["office-native-editing", "office-computer-use-incubation", "办公套件原生编辑与协作（Native Office Editing & Collaboration）", "当前：Agent 可通过 DOCX/PDF/PPTX/XLSX Skills 生产工作区制品。规划：原生编辑、批注、修订、版本冲突和增量保存。", "Renderer editor draft (planned)"],
  ["computer-use-task-ux", "office-computer-use-incubation", "计算机操作任务体验（Computer Use Task Experience）", "当前：CUA 权限引导、通用 MCP 工具卡，以及由 computer-use/operation-event runtime sideband 驱动、每次工具触发最多延长 10 秒的 Windows 顶部操作提示。孵化：实时画面、操作轨迹、目标窗口和步骤状态。", "Desktop Main native projection + Renderer tool projection"],
  ["computer-use-takeover", "office-computer-use-incubation", "人工接管与安全确认（Human Takeover & Safety Confirmation）", "规划：暂停、逐步确认、高风险动作确认、人工接管和恢复 Agent 控制。", "Renderer control intent (planned)"],
  // 自动化编辑器只维护草稿，计划与运行历史由 Host AutomationService/Repo 持久化。
  // 「Run now」是 intent，不是本地执行；触发必须回到调度器。
  ["automation-editor", "automation-experience", "定时自动化界面（Automation UI）", "计划、编辑、历史、Run now 和运行结果。", "Renderer automation draft"],
  ["offpeak-ui", "automation-experience", "闲时任务界面（Off-Peak UI）", "闲时任务配置、暂停、续跑和排队状态。", "Renderer off-peak state"],
  ["bot-management", "automation-experience", "机器人管理（Bot Management）", "Bot 配置、渠道绑定、workspace 和 task 映射。", "Renderer bot settings"],
  // 设计系统输出语义 token，不输出具体色值分支；主题切换只能通过 token 层生效。
  // 组件复用优先于新增变体，避免同一交互出现两套状态。
  // 桌面与手机 Web 必须共用同一套 token，断点差异只在布局层。
  ["design-system", "ui-platform", "设计系统（Design System）", "语义颜色、字体、间距、组件和交互层级。", "Shared UI tokens/components"],
  ["theme-i18n", "ui-platform", "主题与国际化（Theme & i18n）", "Light/Dark/Zai 主题、locale 与跨窗口同步。", "Renderer store + broadcast"],
  ["responsive-settings-shell", "ui-platform", "响应式与设置框架（Responsive & Settings Shell）", "Desktop/Web/Mobile 响应式、Settings 和 Onboarding 框架。", "Shared UI shell"],
  // 看板只消费 usage/stats 快照；缺数据时显示空态，不在前端补算或估算。
  // 7 天与 30 天是服务端聚合窗口，切换区间不得复用上一区间缓存。
  ["app-usage-dashboard", "insights-feedback", "应用用量看板（App Usage Dashboard）", "7/30 天指标卡、热力图、每日模型柱图和模型饼图。", "Renderer range/snapshot state"],
  ["feedback-ui", "insights-feedback", "反馈入口（Feedback UI）", "反馈工单创建、附件选择、进度和处理通知。", "Renderer feedback draft"],
  ["resource-manager-ui", "insights-feedback", "资源管理器界面（Resource Manager UI）", "CPU / 内存双层指标卡，按基础服务、内置插件、社区插件分组的进程列表。", "Renderer resource usage snapshot"],
  // 凭据只在 Host 侧使用与存储，Renderer 不接触明文 token。
  // OAuth 回调与 state 注册必须绑定窗口，跨窗口复用 state 会造成回调劫持。
  // 身份域隔离是安全边界，不能按 workspacePath 合并两套凭据。
  ["oauth-credential", "account-entitlements", "OAuth 与凭据（OAuth & Credentials）", "OAuth 生命周期、API Key、Credential store 与身份域隔离。", "Host OAuth/Credential services"],
  ["plan-identity", "account-entitlements", "套餐身份与权益解析（Plan Identity & Entitlements）", "统一解析 coding_plan/start_plan/no_plan/unknown 与个人/团队上下文。", "Host entitlement snapshot"],
  ["start-plan", "account-entitlements", "免费套餐（Start Plan）", "独立 provider、OAuth JWT、balance/daily quota 与升级入口。", "Host Start Plan balance APIs"],
  ["personal-coding-plan", "account-entitlements", "个人编码套餐（Personal Coding Plan）", "个人付费订阅、可用 provider、续费、到期和额度身份。", "Host Coding Plan APIs"],
  ["team-plan", "account-entitlements", "团队套餐（Team Plan）", "BigModel organization/project/product/seats、项目 API key 与企业权益。", "Host Team Plan APIs"],
  ["subscription-billing", "account-entitlements", "订阅与支付（Subscription & Billing）", "个人 preview/sign/check/payment 与企业 pricing/order/status。", "Host subscription services"],
  ["plan-quota-monitor", "account-entitlements", "套餐额度与 Monitor 用量（Plan Quota & Monitor Usage）", "Coding/Team quota、model/tool monitor；不读取 App Usage。", "Remote quota/monitor backend"],
  // 安装与升级是 Host 领域操作，UI 只提交意图并展示结果。
  // 官方内置插件不可卸载，只能启停；把「内置」当普通插件删除会让后续依赖缺失。
  // 资源贡献清单以 Host 返回为准，避免 UI 与运行时各自合并一次。
  ["plugin-management", "extension-management", "插件管理（Plugin Management）", "安装、升级、启停、官方内置插件和资源贡献清单。", "Host plugin management service"],
  ["extension-sync", "extension-management", "导入与远程同步（Import & Remote Sync）", "外部 Agent 导入、local/remote 配置和资源同步。", "Host extension sync services"],
  // 宿主在 Main 进程管理 WebContentsView；Renderer 只拿投影，不得直接操作 webContents。
  // tab 销毁必须走统一生命周期，绕过会遗留进程与权限监听。
  // 窗口关闭时先缓存 webContents id 再清理，避免访问已销毁对象。
  ["embedded-browser-host", "browser-platform", "内置浏览器宿主（Embedded Browser Host）", "WebContentsView、tab 生命周期、导航、窗口挂载和 32-tab 进程内上限。", "Electron Main browser host"],
  ["browser-tab-residency", "browser-platform", "浏览器 Tab 常驻与复用（Browser Tab Residency & Reuse）", "Embedded Browser 维持 32-tab 硬上限和进程内生命周期；agent-owned `open` 默认复用同站点 Tab，找不到候选才新建。", "CLI Browser facade + Electron browser host"],
  ["cdp-control", "browser-platform", "CDP 控制（CDP Control）", "snapshot、click、type、resize 和页面状态。", "Host CDP backend"],
  ["cua-helper-lifecycle", "browser-platform", "Computer Use Helper 生命周期（Computer Use Helper Lifecycle）", "当前 beta：下载、安装、签名校验、启动、健康检查、版本隔离和 orphan reaper。", "Host Computer Use Helper manager"],
  ["cua-permission", "browser-platform", "CUA 权限与可信代理（CUA Permission & Trust Broker）", "当前 beta：Accessibility/Screen Recording 引导、socket/token、peer/launcher 校验和 fail-closed broker。", "Host CUA helper/broker"],
  ["computer-surface-observation", "browser-platform", "计算机界面观察（Computer Surface Observation）", "当前 beta：应用/窗口/AX tree、元素定位、屏幕读取和 stale-check 事实。", "Desktop-local CUA observation backend"],
  ["computer-input-execution", "browser-platform", "原生输入与应用操作（Native Input & Application Actions）", "当前 beta：click、keyboard、scroll、open application 和进程范围动作。", "Desktop-local CUA input backend"],
  // 身份键统一为 workspaceIdentity?.trim() || workspacePath，用于去重、绑定、缓存与队列；路径只用于文件操作。
  // 远程链路必须同时贯穿 identity 与 remoteSessionId，只按路径匹配会把两个远端 workspace 合并。
  // 任何新接口都要保留本地路径 fallback，否则本地 workspace 会失去身份。
  ["workspace-identity", "workspace-delivery", "工作区身份（Workspace Identity）", "workspaceKey、remoteSessionId、身份隔离和路由。", "Shared identity contracts"],
  ["local-host", "workspace-delivery", "本地主机（Local Host）", "窗口级本地服务、CLI 进程路由和 service graph。", "Desktop Host Process"],
  ["remote-host", "workspace-delivery", "远程主机（Remote Host）", "SSH/WSL/Docker/Server runtime、连接复用和 Host pooling。", "Remote session manager"],
  ["mobile-remote", "workspace-delivery", "手机远控网关（Mobile Remote Gateway）", "配对后的 mobile workspace/task 控制入口和 attachment 调度。", "Host web remote gateway"],
  ["relay-pairing", "workspace-delivery", "中继与配对（Relay & Pairing）", "device/terminal 鉴权、心跳和 rpc-frame 透传。", "Relay transport"],
  ["shared-attachment", "workspace-delivery", "共享主机挂载（Shared Host Attachment）", "把手机连接挂到已有 Local/Remote Host。", "Desktop Main attachment routing"],
  ["desktop-continuous", "workspace-delivery", "桌面连续通信（Desktop Continuous）", "桌面完整实时消息流、connection-owned subscription 与直连通信；不使用 replayable gap/snapshot 恢复。", "Host desktop attachment profile"],
  ["mobile-replayable", "workspace-delivery", "手机可重放交付（Mobile Replayable）", "gap、snapshot、watermark、buffer 与重连恢复。", "Host mobile attachment profile"],
  // 索引只存元数据，不存会话正文；把正文塞进索引会让补全与搜索口径分叉。
  // 索引写入必须幂等，重复事件不能产生重复条目。
  // 归档/置顶是投影层事实，不触发会话状态迁移。
  ["task-index", "workbench-services", "任务 SQLite 索引（Task SQLite Index）", "任务列表元数据、搜索、置顶、归档与未读；不拥有正文。", "Host TaskIndexRepo"],
  ["file-service", "workbench-services", "文件服务（File Service）", "readdir/read/watch、远程路径执行与 workspace 隔离。", "Host file service"],
  ["terminal-service", "workbench-services", "终端服务（Terminal Service）", "PTY 生命周期、输入输出、resize 和远程 cwd。", "Host terminal service"],
  ["git-service", "workbench-services", "Git 服务（Git Service）", "status、diff、stage、commit、branch 和 checkpoint。", "Host Git services"],
  ["office-document-service", "workbench-services", "办公文档服务（Office Document Service）", "规划：workspace-scoped DOCX/XLSX/PPTX 解析、转换、缩略图、保存、导出和版本冲突处理。", "Host document service (planned)"],
  // 持久化计划与运行历史是唯一事实；UI 不缓存运行中状态。
  // 记录必须带 workspace identity，否则远程与本地任务会互相覆盖。
  ["automations", "automation-channel", "自动化记录（Automation Records）", "持久化计划、运行历史、状态与 workspace identity。", "Host AutomationService/Repo"],
  ["automation-scheduler", "automation-channel", "自动化调度器（Automation Scheduler）", "cron 计算、misfire、派发和运行结果回写。", "Host scheduler"],
  ["offpeak", "automation-channel", "闲时任务运行时（Off-Peak Runtime）", "状态机、暂停、续跑和 idle model overlay。", "Host OffPeakTaskService/Repo"],
  ["offpeak-ticket", "automation-channel", "闲时任务凭证（Off-Peak Ticket）", "服务端取号、排队、准入、重取号和 settle。", "Off-Peak backend"],
  ["bots", "automation-channel", "机器人核心（Bots Core）", "Bot 配置、绑定、workspace、task 和交互状态。", "Host BotService"],
  ["channel-adapters", "automation-channel", "渠道适配器（Channel Adapters）", "Telegram、飞书/Lark、微信和 Webhook。", "Host provider adapters"],
  // Main 负责窗口、原生操作与进程调度，不承载 task/session 业务状态。
  // deep link 与 OAuth 回调必须投递到发起窗口，不能广播到所有窗口。
  // 退出安装等更新动作只能在确认无未保存写入后执行。
  ["electron-platform", "client-platform", "Electron 平台（Electron Platform）", "窗口、Main/Host、native dialog、deep link 和进程生命周期。", "Desktop Main"],
  ["client-update-lifecycle", "client-platform", "客户端更新生命周期（Client Update Lifecycle）", "检查、下载、强更 guard、退出安装、更新完成与 release notes。", "Desktop autoUpdater"],
  ["feedback-tickets", "client-platform", "反馈工单（Feedback Tickets）", "工单提交、后台 job、附件和状态通知。", "Host feedback service"],
  ["diagnostics-bundle", "client-platform", "日志导出与诊断包（Log Export & Diagnostic Bundle）", "日志归档、脱敏、设备环境快照和反馈附件。", "Host diagnostic bundle"],
  // 桥只转发快照，不扫描 session JSON、不估算、不落盘；三者任一都会产生第二份用量事实。
  // 快照字段缺失时透传缺失，不在桥里补零。
  ["app-usage-bridge", "data-observability", "应用用量协议桥（App Usage Protocol Bridge）", "转发 usage/stats snapshot；不扫描 session JSON，不估算和不持久化事实。", "Host UsageStatsService"],
  ["product-telemetry", "data-observability", "产品埋点与数仓（Product Telemetry /report）", "产品行为、DAU、assistant feedback 与 deviceMid/daily-active 去重。", "Host TelemetryCore"],
  ["conversation-telemetry", "data-observability", "对话遥测桥（Conversation Telemetry Bridge）", "live facts、去重、前后台状态和 clientMode 上报门禁。", "Host conversation telemetry"],
  ["arms-rum", "data-observability", "ARMS 与 RUM（ARMS & RUM）", "Electron JS error、Crash、API、longTask 与自定义事件。", "Desktop Main ARMS SDK"],
  ["performance-reliability", "data-observability", "性能与可靠性监控（Performance & Reliability）", "稳定性、资源、网络、UI perf、Agent crash 和告警口径。", "Host/Desktop telemetry aggregators"],
  ["logging-infrastructure", "data-observability", "日志基础设施（Logging Infrastructure）", "UI/service/RPC/CLI logger、分级、轮转、脱敏和归档。", "Cross-layer logging sinks"],
  ["resource-manager-runtime", "data-observability", "资源管理器运行时（Resource Manager Runtime）", "Electron 指标 + Host 侧进程树采样 + CLI MCP 子进程归属，合并为整机口径快照。", "Desktop resource manager"],
  // 启动装配只做一次依赖注入；运行时中途重建 Config 会让进行中的 turn 读到两套环境。
  // shutdown 必须等待在途写入，否则最后一个事件可能丢失。
  ["runtime-bootstrap", "agent-core", "运行时装配与配置（Runtime Bootstrap & Config）", "AgentRuntime 依赖注入、workspace config、shell/env 和 shutdown。", "CLI AgentRuntime"],
  ["turn-orchestration", "agent-core", "Turn 编排与状态机（Turn Orchestration & State Machine）", "TurnStarted、hooks、上下文、model/tool loop、完成、取消与失败。", "CLI turn machine"],
  ["context-assembly", "agent-core", "上下文构建与指令注入（Context Assembly & Instruction Injection）", "workspace/user/project instructions、环境、附件和扩展注入。", "CLI context builder"],
  ["memory-runtime", "agent-core", "记忆召回与写入（Memory Recall & Write）", "summary、相关 topic 检索、remember/forget、脱敏和原子持久化。", "CLI memory runtime"],
  ["compact-runtime", "agent-core", "上下文压缩（Context Compaction）", "手动/自动/reactive/microcompact、summary、timeline 与 rapid-refill breaker。", "CLI compact runtime"],
  ["model-step-stream", "agent-core", "模型步骤与流式恢复（Model Step, Streaming & Recovery）", "reasoning/text/tool stream 顺序、背压、retry、anchor 和 tail discard。", "CLI model step orchestration"],
  ["target-continuation", "agent-core", "目标持续执行（Goal & Target Continuation）", "target 激活/暂停、自动续跑、完成验证、heartbeat 和结算。", "CLI target runtime"],
  ["runtime-fault-recovery", "agent-core", "运行时故障收口（Runtime Fault Recovery）", "cancel、provider/tool fault、recoverable error 和 terminal event 收口。", "CLI turn error policy"],
  // 首次持久化先于任何 turn 事件，否则恢复时缺少会话头。
  // cold resume 只重放已确认事件，不能用内存快照替代 journal。
  // session mode/title 的变更走同一生命周期，不另开写入通道。
  ["session-lifecycle", "conversation-runtime", "会话生命周期与恢复（Session Lifecycle & Resume）", "首次持久化、cold resume、session mode/title 和 runtime activation。", "CLI session runtime"],
  ["input-admission", "conversation-runtime", "输入接纳、队列与 Steering（Input Admission, Queue & Steering）", "busy input、guide/queue、held queue、reorder/edit/remove 和 autoDrain。", "CLI CommandInbox/FIFO"],
  ["command-ack-recovery", "conversation-runtime", "命令确认与恢复（Command ACK, Dedupe & Recovery）", "accepted/rejected/stale/duplicate、command query 与 discarded input ledger。", "CLI command ledger"],
  ["session-event-journal", "conversation-runtime", "会话事件账本（Session Event Journal）", "durable append、严格事件顺序、stream events 和恢复重放。", "CLI event store"],
  ["product-projection", "conversation-runtime", "产品投影（ProductProjection）", "会话正文、运行态、交互、queue、command 结果和 client-safe Hook 摘要的权威投影。", "CLI ProductProjection"],
  ["conversation-branch-rewind", "conversation-runtime", "分支、编辑重试与回退（Branch, Retry, Rewind & Checkpoints）", "fork/edit/retry、stable boundary、checkpoint 和 file rewind。", "CLI conversation mutation"],
  ["session-store", "conversation-runtime", "会话存储（Session Store）", "session 事件、历史、恢复、迁移和持久化索引。", "CLI session store"],
  // adapter 只做协议转换，不决定模型能力；能力来自 Active Model 属性与配置规则。
  // retry 必须保留原始请求 id，否则重复工具调用无法去重。
  // tool-call assembly 的顺序即模型输出顺序，不得重排。
  ["model-runtime", "models", "模型运行时（Model Runtime）", "模型协议、adapter、provider request、retry 与 tool-call assembly。", "CLI model adapters"],
  ["provider-registry", "models", "模型供应商注册表（Provider Registry）", "Built-in/Account/Personal Provider Config 解析、完整 View 与 lookup/validate。", "Provider Registry"],
  ["model-config-rules", "models", "模型配置规则（Model Config Rules）", "Built-in + Personal Rules 解析完整 properties、option specs 与 reasoning mapping。", "Provider Config domain"],
  ["model-token-limits", "models", "上下文与输出预算（Context & Output Limits）", "Active Model 的 context window、max output、输入预算与 compact 阈值。", "Active Model properties/options"],
  ["model-modalities", "models", "多模态能力（Multimodal Capabilities）", "Active Model inputFormat/outputFormat；请求对 image/video/PDF 做 gating，并受 Adapter 编码能力约束。", "Active Model properties"],
  ["model-reasoning", "models", "推理与工具能力（Reasoning & Tool Capabilities）", "Model Config Rules 声明 reasoning levels、tool call、structured output 与 Adapter mapping。", "Active Model option specs/properties"],
  // 内置工具通过统一注册表暴露，权限校验在调度器里做，工具本身不重复判断模式。
  // 工具输出即产物事实，不能在 UI 层二次改写。
  ["builtin-tools", "tool-safety", "内置工具（Built-in Tools）", "Read/Edit/Write/Bash/Grep/Glob/ApplyPatch 等。", "CLI Tool Registry"],
  ["tool-scheduler", "tool-safety", "工具调度器（Tool Scheduler）", "工具校验、调度、生命周期、并发和结果回传。", "CLI Tool Executor"],
  ["permission-broker", "tool-safety", "权限协调器（Permission Broker）", "权限请求、审批、deny/allow 与 pending interaction。", "CLI Permission Service"],
  ["mode-policy", "tool-safety", "模式与规划策略（Mode & Plan Policy）", "build/edit/plan/yolo、Plan Mode 和只读策略。", "CLI mode/permission policy"],
  ["tool-artifacts", "tool-safety", "工具产物（Tool Artifacts）", "工具输入、输出、diff、媒体与持久化格式。", "CLI artifact store"],
  // profile 只声明能力范围，不持有运行态；子会话状态归属 child runtime。
  // 用户覆盖优先于内置 profile，合并顺序不可反转。
  ["subagent-profiles", "multi-agent", "子智能体配置（Subagent Profiles）", "内置/用户 profile、模型、工具和 MCP 范围。", "CLI Subagent Markdown/overrides"],
  ["child-runtime", "multi-agent", "子智能体运行时（Child Runtime）", "子会话、执行、工具和模型运行态。", "CLI child AgentRuntime"],
  ["interaction-broker", "multi-agent", "交互协调器（Interaction Broker）", "子任务权限与 AskUserQuestion 路由到父任务。", "CLI parent-routed broker"],
  ["background-tasks", "multi-agent", "后台任务（Background Tasks）", "后台 Subagent、join、通知与取消。", "CLI runtime task registry"],
  // MCP 连接状态单向由运行时产出，UI 不得回写。
  // 凭据只在 tools/call 时使用，不能把服务端广告当 entitlement。
  // 协议协商结果决定可用工具集，异步 catalog 未完成时不得提前暴露工具。
  ["mcp-runtime", "extension-runtime", "MCP 运行时（MCP Runtime）", "stdio/http/sse、OAuth、双代协议协商、异步 tool catalog、tool discovery 与连接状态。", "CLI MCP runtime"],
  ["official-server-mcp", "extension-runtime", "官方 Server MCP（Official Server MCP）", "官方 Server MCP 的 auth/quota/unavailable 状态；仅在 tools/call 使用凭据，不把服务广告当作 entitlement。", "CLI MCP runtime + Host entitlement services"],
  ["skills", "extension-runtime", "技能运行时（Skills Runtime）", "Skill discovery、读取、启停和 prompt 注入。", "CLI Skill loader"],
  ["hooks", "extension-runtime", "钩子运行时（Hooks Runtime）", "SessionStart、Pre/PostToolUse、Stop 等事件。", "CLI Hook runner"],
  ["commands", "extension-runtime", "命令运行时（Commands Runtime）", "Markdown command、slash catalog、启停和 prompt materialization。", "CLI Command loader"],
  ["memory-resources", "extension-runtime", "记忆资源（Memory Resources）", "持久记忆文件、topic、读取和提示注入资源。", "CLI memory files"],
  ["extension-loader", "extension-runtime", "扩展发现与加载（Extension Discovery & Loading）", "优先级、资源合并、plugin contribution 和 runtime reload。", "CLI extension loader"],
  ["document-skills", "extension-runtime", "文档生产技能（Document Production Skills）", "当前：官方 DOCX/PDF/PPTX/XLSX Skills 与 image_search MCP，通过现有工具和脚本创建、编辑、校验工作区文档；不等于原生 Office Editor。", "CLI official document-skills plugin"],
  ["computer-use-mcp", "extension-runtime", "计算机操作 MCP 接入（Computer Use MCP Integration）", "当前 beta：识别 zcode-cua、注入专属 broker 凭据、缺少可信 Host 时 fail closed，并注册 MCP tools。", "CLI MCP runtime + zcode-cua resolver"],
  // 插件随包分发，版本与 CLI 对齐；单独升级会打破协议兼容。
  // skill 只描述用法，真正的浏览器能力在 client runtime 与 MCP server。
  ["browser-plugin", "browser-runtime", "浏览器使用插件（Browser Use Plugin）", "官方 skill、client runtime 和 MCP server。", "Bundled browser-use plugin"],
  ["node-repl", "browser-runtime", "Node 运行环境（Node REPL / Playwright）", "持久绑定、Playwright facade 和浏览器脚本执行。", "CLI Node REPL runtime"],
  ["headless-browser", "browser-runtime", "无头浏览器后端（Headless Backend）", "没有 Desktop Main 时的 CDP/browser backend。", "CLI browser backend"],
  // 只在生命周期节点写事实，禁止在投影层估算 token。
  // 写入失败不能阻断 turn；用量是旁路，但缺失必须可观测。
  // 同一 turn 的重试要分别记账，合并会低估成本。
  ["usage-fact-collection", "usage-observability", "用量事实采集（Usage Fact Collection）", "Model、Turn、Tool 生命周期写真实 token、latency、错误、重试和审批事实。", "CLI runtime usage methods"],
  ["usage-sqlite", "usage-observability", "用量 SQLite 与保留策略（Usage SQLite & Retention）", "model_usage/turn_usage/tool_usage，默认 db.sqlite，30 天保留。", "CLI usage repository"],
  ["app-usage-aggregation", "usage-observability", "应用用量聚合（App Usage Aggregation）", "按时间、模型、工具和日期 SQL 聚合并生成 source=agent-db snapshot。", "CLI usage/stats builder"],
  // stage DAG 的串并行关系是发布正确性的一部分，不能为缩短时长随意合并。
  // 手动审批是灰度发布的前置，不得用自动跳过替代。
  // 缓存键必须包含锁文件哈希，否则会复用过期依赖。
  ["ci-pipelines", "build-release-engineering", "CI 工作流与流水线编排（CI Workflows & Pipeline Orchestration）", "workflow rules、runner、cache、stage DAG、手动审批和环境隔离。", "GitLab CI configuration"],
  ["multi-target-build", "build-release-engineering", "多目标构建与制品准备（Multi-target Build & Artifact Preparation）", "Desktop/Web/CLI/Remote assets、架构矩阵、runtime dependency 与 artifact manifest。", "CI build jobs and build scripts"],
  ["desktop-packaging-signing", "build-release-engineering", "桌面打包、签名与公证（Desktop Packaging, Signing & Notarization）", "Electron Builder、macOS notarization、Windows signing、Linux packages 与 Computer Use Helper。", "Packaging and signing scripts"],
  ["release-orchestration", "build-release-engineering", "版本、审批与灰度/稳定发布（Versioning, Approval & Gray/Stable Release）", "version/changelog、release approve、upload、preload、gray publish 与 stable promote。", "GitLab release DAG"],
  ["artifact-distribution", "build-release-engineering", "制品、CDN 与发布通知（Artifacts, CDN & Release Notifications）", "GitLab artifacts、OSS/CDN、update feed、内部 Preview 与飞书通知。", "Release artifact channels"],
  // harness 负责进程与窗口生命周期，用例不直接起停 Electron。
  // workspace seed 必须每次隔离，复用会引入跨用例污染。
  // 失败截图与视频是诊断产物，不能作为断言依据。
  ["desktop-e2e-harness", "test-automation-platform", "桌面 E2E Harness（Desktop E2E Harness）", "WDIO/Electron service、窗口与进程生命周期、workspace seed、截图和视频。", "Desktop WDIO test harness"],
  ["capture-replay-fixtures", "test-automation-platform", "捕获、回放与确定性夹具（Capture, Replay & Deterministic Fixtures）", "model/SSE/network capture、fixture matching、fake time 与可重复 provider 响应。", "E2E replay infrastructure"],
  ["cross-platform-e2e", "test-automation-platform", "跨平台与远程 E2E（Cross-platform & Remote E2E）", "macOS/Windows shard、Docker、SSH/WSL/remote workspace 与隔离运行。", "CI E2E runners"],
  ["cli-tool-replay", "test-automation-platform", "CLI 与工具回放验证（CLI & Tool Replay Verification）", "ZCode CLI E2E、distillation proxy、tool capture/replay 与 parity compare。", "CLI/distillation test runtime"],
  ["fault-injection", "test-automation-platform", "故障注入与生命周期压力（Fault Injection & Lifecycle Stress）", "网络、SSE、文件系统、进程、重连、竞态和 session lifecycle stress。", "E2E fault harness"],
  ["case-admission-promotion", "test-automation-platform", "用例准入、晋级与夹具治理（Case Admission, Promotion & Fixture Governance）", "manual-review、verified、Docker admission、fixture 校验和 promotion transaction。", "E2E admission scripts"],
  // 门禁失败必须 fail-fast，不能以「已知失败」放行。
  // affected 选择只缩小范围，不替代全量门禁的定义。
  ["static-quality-gates", "quality-intelligence", "静态质量与单元门禁（Static Quality & Unit Gates）", "lint、typecheck、unit/affected test、schema 和 CI fail-fast。", "Repository quality commands"],
  ["e2e-reporting", "quality-intelligence", "E2E 报告与失败制品（E2E Reporting & Failure Artifacts）", "summary JSON/Markdown、coverage、截图、视频、日志和本地 viewer。", "E2E reporter package"],
  ["quality-metrics", "quality-intelligence", "质量指标与趋势（Quality Metrics & Trends）", "通过率、失败分类、时长、flake、作者贡献和 Bitable/report 平台上传。", "Quality data pipelines"],
  ["coverage-governance", "quality-intelligence", "覆盖率与产品用例治理（Coverage & Product Case Governance）", "case catalog、coverage matrix、formal admission、缺口审计和晋级门槛。", "Coverage audit and formal proof"],
  ["engineering-performance", "quality-intelligence", "工程性能与预算（Engineering Performance & Budgets）", "CI step timing、bundle size、测试分片权重、cache 命中与构建可靠性。", "Engineering performance audits"],
];

// 边 tuple 字段顺序：source、target、relation type、面向读者的 label；
// 数组下标（从 0 开始）决定导出 id "edge-<index+1>"，在中间增删条目会改变后续所有边 id。
const edgeDefinitions: readonly CapabilityEdgeDefinition[] = [
  // Composer 与模型选择器共享候选与展示，但提交仍由各自入口独立完成。
  // 这条边是展示依赖，不代表 Composer 拥有模型配置。
  ["composer", "model-selector", "shared", "当前会话模型"],
  // 附件边只表达引用关系，不表示 Composer 拥有附件内容；二进制与生命周期在 file service。
  ["composer", "attachment-ux", "shared", "附件引用"],
  ["composer", "plan-shortcut", "shared", "slash shortcut"],
  // Plan 快捷入口只切换模式，不提交任务；带任务文本时才走 command 提交通道。
  ["plan-shortcut", "mode-policy", "shared", "切换 Plan Mode"],
  ["plan-shortcut", "input-admission", "runtime", "带任务文本时提交 command"],
  ["conversation-actions", "input-admission", "runtime", "提交 V4 command"],
  ["conversation-actions", "command-ack-recovery", "state", "ACK 与恢复查询"],
  ["conversation-projection-store", "conversation-ui", "state", "只读 projection"],
  ["conversation-projection-store", "conversation-actions", "shared", "guard 与 capability"],
  // 任务导航读取索引元数据，不读会话正文；正文反向流入列表会让列表刷新变慢且越权。
  ["task-index", "task-navigation", "state", "列表元数据"],
  // 附件选择走 file service，UI 不直接访问文件系统；远程场景必须带 workspace identity。
  ["attachment-ux", "file-service", "runtime", "选择与传输"],
  // 媒体能力门控读 Active Model 的输入格式，读不到时按不支持处理，不能默认放行。
  // 该门控只影响 Active Model 的媒体提示与选择，不改变已提交附件的历史记录。
  ["attachment-ux", "model-modalities", "shared", "媒体能力 gating"],
  ["attachment-ux", "sent-media-preview", "shared", "有序媒体展示"],
  // 已发送媒体的预览必须经 file service 授权的 chunk 读取，不能把 URL 直接透传给 img/video。
  ["sent-media-preview", "file-service", "delivery", "安全 local/remote preview"],
  // 设置页读取 provider registry 的解析结果，写入必须回到 ProviderConfigService。
  ["provider-settings", "provider-registry", "state", "连接配置"],
  ["model-catalog", "model-selector", "shared", "候选与展示元数据"],
  ["plan-status-ui", "subscription-billing", "runtime", "购买与升级"],
  ["plan-status-ui", "plan-identity", "state", "套餐状态"],
  ["plan-usage-ui", "plan-quota-monitor", "state", "远端 quota / monitor"],
  ["extension-settings", "plugin-management", "runtime", "安装与启停"],
  ["extension-settings", "extension-sync", "runtime", "导入与同步"],
  ["extension-settings", "mcp-settings-diagnostics", "shared", "连接与归属详情"],
  // 诊断展示的是运行时缓存的连接事实，不是设置页主动探测的结果；两者混用会误导排障。
  ["mcp-settings-diagnostics", "mcp-runtime", "state", "initialize/tools/list 诊断"],
  ["mcp-settings-diagnostics", "workspace-identity", "invariant", "local/remote 诊断隔离"],
  ["plugin-marketplace-ui", "plugin-management", "runtime", "市场安装"],
  ["embedded-browser-ui", "embedded-browser-host", "delivery", "WebContentsView 挂载"],
  ["embedded-browser-ui", "browser-tab-residency", "state", "tab 上限与复用反馈"],
  // 文件树是 file service 的投影；UI 侧不得自行递归目录，否则远程 workspace 会出现两套枚举路径。
  ["file-tree", "file-service", "delivery", "文件 projection"],
  ["terminal-ui", "terminal-service", "delivery", "PTY stream"],
  ["git-diff-ui", "git-service", "delivery", "Git 状态与操作"],
  ["automation-editor", "automations", "state", "保存计划"],
  ["offpeak-ui", "offpeak", "state", "任务状态"],
  ["bot-management", "bots", "state", "配置与绑定"],
  ["design-system", "conversation-ui", "shared", "组件与 tokens"],
  ["theme-i18n", "conversation-ui", "shared", "主题与 locale"],
  ["responsive-settings-shell", "task-navigation", "shared", "多端壳"],
  ["app-usage-bridge", "app-usage-dashboard", "delivery", "agent-db snapshot"],
  ["feedback-ui", "feedback-tickets", "runtime", "创建工单"],
  ["resource-manager-runtime", "resource-manager-ui", "state", "资源快照"],
  // Start Plan 复用统一 OAuth 凭据，不另建身份域；独立凭据会导致切换套餐后需要重新登录。
  ["oauth-credential", "start-plan", "shared", "OAuth JWT"],
  ["oauth-credential", "personal-coding-plan", "shared", "账号与凭据"],
  ["oauth-credential", "team-plan", "shared", "项目 API key"],
  ["start-plan", "plan-identity", "state", "balance 权益"],
  ["personal-coding-plan", "plan-identity", "state", "个人订阅权益"],
  ["team-plan", "plan-identity", "state", "组织/项目权益"],
  ["subscription-billing", "personal-coding-plan", "state", "创建与刷新订阅"],
  ["subscription-billing", "team-plan", "state", "企业订单与席位"],
  ["personal-coding-plan", "plan-quota-monitor", "state", "个人额度与 monitor"],
  ["team-plan", "plan-quota-monitor", "state", "项目额度与 monitor"],
  ["start-plan", "plan-quota-monitor", "invariant", "不使用 monitor API"],
  ["plan-identity", "provider-registry", "shared", "套餐 provider 可用性"],
  ["official-server-mcp", "plan-identity", "state", "官方 MCP auth / entitlement"],
  ["official-server-mcp", "plan-quota-monitor", "state", "官方 MCP quota"],
  ["plan-quota-monitor", "app-usage-aggregation", "invariant", "不得 fallback 本地用量"],
  // 插件管理提供资源清单，扩展加载器消费它；两边不能各自维护一份合并逻辑。
  ["plugin-management", "extension-loader", "shared", "贡献资源清单"],
  ["extension-sync", "extension-loader", "delivery", "同步 runtime 资源"],
  // CDP 控制只能作用于宿主管理的 tab；对已销毁 tab 发指令必须失败而不是排队。
  ["embedded-browser-host", "cdp-control", "runtime", "页面控制 backend"],
  ["browser-tab-residency", "embedded-browser-host", "delivery", "32-tab 进程内常驻"],
  ["cdp-control", "browser-plugin", "delivery", "控制协议"],
  ["cua-helper-lifecycle", "cua-permission", "runtime", "启动可信权限主体"],
  ["cua-permission", "permission-broker", "runtime", "系统授权"],
  ["cua-permission", "computer-surface-observation", "runtime", "授权观察"],
  ["cua-permission", "computer-input-execution", "runtime", "授权输入"],
  ["computer-use-mcp", "computer-surface-observation", "runtime", "观察界面与截图"],
  ["computer-use-mcp", "computer-input-execution", "runtime", "执行 click / type / open"],
  ["computer-use-mcp", "computer-use-task-ux", "state", "工具生命周期投影"],
  [
    "local-host",
    "computer-use-task-ux",
    "state",
    "computer-use/operation-event → Windows CUA turn 状态",
  ],
  ["computer-use-task-ux", "conversation-ui", "shared", "复用任务时间线"],
  ["computer-use-takeover", "computer-input-execution", "runtime", "规划：暂停与接管"],
  ["mobile-remote", "cua-helper-lifecycle", "invariant", "不得为远控另起 Helper"],
  // Local Host 以 workspaceKey 隔离；只按路径聚合会把同一路径的不同身份合并。
  ["workspace-identity", "local-host", "shared", "workspaceKey"],
  // 远程 Host 必须同时带 identity 与 remoteSessionId；只带路径会让两个同路径远端互相覆盖。
  ["workspace-identity", "remote-host", "shared", "identity + remoteSessionId"],
  ["workspace-identity", "task-index", "shared", "索引隔离"],
  ["workspace-identity", "terminal-service", "shared", "会话隔离"],
  // 本地 CLI 通过 stdio 由 Local Host 拉起；绕过 Host 直连进程会丢失进程监督与协议校验。
  ["local-host", "runtime-bootstrap", "delivery", "stdio CLI"],
  ["remote-host", "runtime-bootstrap", "delivery", "SSH / WSL / Docker CLI"],
  ["mobile-remote", "relay-pairing", "delivery", "terminal pairing"],
  ["relay-pairing", "shared-attachment", "delivery", "rpc-frame"],
  ["shared-attachment", "local-host", "delivery", "挂载现有 Host"],
  ["shared-attachment", "remote-host", "delivery", "挂载现有 Host"],
  // 桌面链路是连续实时流，不带 gap/snapshot 重放；把恢复语义混进来会重复渲染历史事件。
  ["product-projection", "desktop-continuous", "delivery", "live topic"],
  ["product-projection", "mobile-replayable", "delivery", "gap / snapshot"],
  ["desktop-continuous", "conversation-projection-store", "delivery", "连续 projection"],
  ["mobile-replayable", "conversation-projection-store", "delivery", "可恢复 projection"],
  ["mobile-remote", "mobile-replayable", "delivery", "恢复配置"],
  ["shared-attachment", "desktop-continuous", "invariant", "不得混入手机恢复"],
  ["relay-pairing", "product-projection", "invariant", "relay 不拥有业务状态"],
  // 文件树消费 file service 的目录与 watcher 投影，不在 UI 侧做二次排序或过滤。
  ["file-service", "file-tree", "state", "目录与 watcher"],
  ["git-service", "file-tree", "shared", "Git 状态"],
  ["terminal-service", "local-host", "delivery", "本地 PTY"],
  ["terminal-service", "remote-host", "delivery", "远端 PTY"],
  ["office-document-preview", "file-tree", "shared", "复用 Preview Pane"],
  ["office-document-preview", "file-service", "delivery", "readBinaryPreview / workspace bytes"],
  ["office-document-preview", "office-document-service", "delivery", "规划：读取与转换"],
  ["office-spreadsheet-workbench", "office-document-service", "runtime", "规划：解析与写回"],
  ["office-presentation-workbench", "office-document-service", "runtime", "规划：解析与写回"],
  ["office-native-editing", "office-document-service", "runtime", "规划：保存与版本冲突"],
  ["office-document-service", "file-service", "shared", "workspace-scoped IO"],
  // 计划持久化后才可被调度；先调度后落盘会在崩溃后丢失任务。
  ["automations", "automation-scheduler", "state", "持久化计划"],
  ["automation-scheduler", "session-lifecycle", "runtime", "创建/继续 session"],
  ["automation-scheduler", "turn-orchestration", "runtime", "派发 prompt"],
  ["offpeak", "offpeak-ticket", "runtime", "取号与续票"],
  ["offpeak-ticket", "turn-orchestration", "runtime", "准入执行"],
  ["bots", "channel-adapters", "delivery", "渠道消息"],
  ["bots", "product-projection", "runtime", "创建/继续任务"],
  ["automations", "product-projection", "runtime", "绑定会话"],
  ["offpeak", "product-projection", "runtime", "普通会话执行"],
  // Main 监督 Local Host 进程；Host 崩溃后由 Main 重建，Renderer 不自行拉起。
  ["electron-platform", "local-host", "delivery", "监督 Host"],
  ["electron-platform", "remote-host", "delivery", "监督 Host"],
  ["client-update-lifecycle", "electron-platform", "runtime", "退出安装"],
  ["feedback-tickets", "diagnostics-bundle", "shared", "附加诊断包"],
  ["logging-infrastructure", "diagnostics-bundle", "state", "脱敏日志归档"],
  ["product-telemetry", "arms-rum", "invariant", "独立上报通道"],
  ["conversation-telemetry", "product-telemetry", "delivery", "agent_trace"],
  ["conversation-telemetry", "arms-rum", "delivery", "ui_perf 镜像"],
  ["product-projection", "conversation-telemetry", "shared", "live-only facts"],
  ["mobile-replayable", "conversation-telemetry", "invariant", "恢复不补报"],
  ["performance-reliability", "arms-rum", "delivery", "聚合指标"],
  ["local-host", "performance-reliability", "shared", "Agent lifecycle"],
  ["remote-host", "performance-reliability", "shared", "远端 lifecycle"],
  ["electron-platform", "resource-manager-runtime", "shared", "进程拓扑"],
  // 会话 runtime 由启动装配创建，生命周期结束后必须释放，不复用旧实例。
  ["runtime-bootstrap", "session-lifecycle", "runtime", "装配会话 runtime"],
  ["session-lifecycle", "session-store", "state", "首次持久化与恢复"],
  ["session-store", "session-event-journal", "state", "恢复事件"],
  ["input-admission", "command-ack-recovery", "state", "admission 结果"],
  ["input-admission", "turn-orchestration", "runtime", "启动 active turn"],
  ["input-admission", "product-projection", "state", "queue / guide"],
  ["command-ack-recovery", "session-event-journal", "state", "command ledger"],
  ["conversation-branch-rewind", "session-store", "runtime", "fork / rewind"],
  ["conversation-branch-rewind", "git-service", "runtime", "workspace checkpoint"],
  ["session-event-journal", "product-projection", "state", "投影事件"],
  ["product-projection", "sent-media-preview", "state", "已发送 media artifacts"],
  ["product-projection", "hook-turn-summary", "state", "client-safe HookInvocationRow"],
  ["hook-turn-summary", "conversation-ui", "shared", "turn action + details Popover"],
  ["hook-turn-summary", "desktop-continuous", "delivery", "direct continuous summary"],
  ["hook-turn-summary", "mobile-replayable", "delivery", "replayable summary/gap/snapshot"],
  ["product-projection", "task-index", "state", "发布任务摘要"],
  ["task-index", "product-projection", "invariant", "不得授权会话正文"],
  // 上下文必须在每个 turn 开始时重建；复用上一轮上下文会带上已失效的附件与工具结果。
  ["turn-orchestration", "context-assembly", "runtime", "构造 turn 上下文"],
  ["turn-orchestration", "model-step-stream", "runtime", "执行模型步骤"],
  // 工具批次由 turn 编排串行驱动；并行发起会破坏 permission 与结果顺序的一致性。
  ["turn-orchestration", "tool-scheduler", "runtime", "执行工具批次"],
  ["turn-orchestration", "target-continuation", "runtime", "完成后续跑"],
  ["turn-orchestration", "runtime-fault-recovery", "runtime", "异常与取消收口"],
  ["turn-orchestration", "session-event-journal", "state", "持久化生命周期"],
  ["context-assembly", "memory-runtime", "shared", "召回记忆"],
  ["memory-resources", "memory-runtime", "state", "持久记忆资源"],
  ["compact-runtime", "context-assembly", "state", "压缩历史"],
  ["model-token-limits", "compact-runtime", "shared", "compact 阈值"],
  // 模型步骤只通过 model runtime 发请求，不直连 provider HTTP；直连会绕过 retry 与 usage 记账。
  ["model-step-stream", "model-runtime", "runtime", "provider request"],
  ["model-step-stream", "session-event-journal", "state", "有序 stream event"],
  ["model-config-rules", "provider-registry", "state", "解析完整模型配置"],
  ["model-config-rules", "model-token-limits", "shared", "context / output 事实"],
  ["model-config-rules", "model-modalities", "shared", "输入输出格式"],
  ["model-config-rules", "model-reasoning", "shared", "reasoning / tools 事实"],
  ["model-selector", "session-lifecycle", "runtime", "提交 session config"],
  ["model-selector", "subagent-profiles", "shared", "Subagent 模型"],
  ["model-selector", "automations", "shared", "自动化模型"],
  ["model-selector", "offpeak", "shared", "闲时模型"],
  ["model-selector", "bots", "shared", "Bot 模型"],
  ["model-token-limits", "model-runtime", "shared", "请求 token 预算"],
  ["model-token-limits", "context-assembly", "shared", "输入上下文预算"],
  ["model-modalities", "model-runtime", "shared", "请求内容 gating"],
  ["model-reasoning", "model-runtime", "shared", "reasoning / tool options"],
  ["builtin-tools", "tool-scheduler", "runtime", "注册工具"],
  ["permission-broker", "tool-scheduler", "runtime", "审批执行"],
  ["mode-policy", "permission-broker", "shared", "权限策略"],
  ["tool-scheduler", "tool-artifacts", "state", "保存结果"],
  // 待审批交互必须投射到产品层，否则用户看不到请求、turn 会停在等待态。
  ["permission-broker", "product-projection", "state", "pending interaction"],
  ["subagent-profiles", "child-runtime", "runtime", "创建 child"],
  ["child-runtime", "interaction-broker", "runtime", "阻塞交互"],
  ["interaction-broker", "product-projection", "state", "镜像到父任务"],
  ["child-runtime", "background-tasks", "state", "后台生命周期"],
  ["child-runtime", "turn-orchestration", "invariant", "raw child 事件隔离"],
  // Skill 由扩展加载器统一发现，优先级冲突在加载器内解决，执行层不再排序。
  ["extension-loader", "skills", "shared", "加载资源"],
  ["extension-loader", "mcp-runtime", "shared", "加载服务器"],
  ["extension-loader", "hooks", "shared", "加载 hooks"],
  ["extension-loader", "commands", "shared", "加载 commands"],
  ["extension-loader", "memory-resources", "shared", "加载记忆"],
  ["skills", "document-skills", "shared", "发现 DOCX / PDF / PPTX / XLSX Skills"],
  ["document-skills", "builtin-tools", "runtime", "脚本与文件工具"],
  ["document-skills", "office-document-preview", "delivery", "生成可预览制品"],
  ["document-skills", "office-native-editing", "shared", "Agent 文档生产"],
  ["mcp-runtime", "computer-use-mcp", "shared", "加载 zcode-cua"],
  ["skills", "context-assembly", "shared", "注入说明"],
  ["hooks", "turn-orchestration", "runtime", "turn hooks"],
  ["hooks", "permission-broker", "runtime", "permission hooks"],
  // Hook 摘要只汇总 client-visible 的真实执行，不展示敏感命令与绝对路径。
  ["hooks", "hook-turn-summary", "state", "client-visible execution summary"],
  ["commands", "composer", "shared", "slash catalog"],
  // slash catalog 决定 /plan 是否可解析；catalog 未就绪时快捷入口必须禁用而不是猜测。
  ["commands", "plan-shortcut", "shared", "`/plan` catalog 与解析"],
  ["mcp-runtime", "tool-scheduler", "runtime", "注册 MCP tools"],
  ["mcp-runtime", "official-server-mcp", "shared", "官方 Server 协议与工具目录"],
  ["browser-plugin", "skills", "shared", "官方 Browser skill"],
  ["browser-plugin", "mcp-runtime", "runtime", "Node REPL server"],
  ["browser-plugin", "browser-tab-residency", "runtime", "open reuseTab / tabs.new"],
  ["node-repl", "cdp-control", "runtime", "Playwright / CDP"],
  ["headless-browser", "node-repl", "runtime", "CLI backend"],
  ["model-step-stream", "usage-fact-collection", "state", "模型请求事实"],
  ["turn-orchestration", "usage-fact-collection", "state", "turn 事实"],
  ["tool-scheduler", "usage-fact-collection", "state", "tool 事实"],
  // 用量写入 SQLite 并保留 30 天；清理只能按时间窗口，不能按访问频率。
  ["usage-fact-collection", "usage-sqlite", "state", "持久化 30 天"],
  ["usage-sqlite", "app-usage-aggregation", "state", "SQL 聚合"],
  ["app-usage-aggregation", "app-usage-bridge", "delivery", "usage/stats"],
  // CI 必须先过静态门禁再进入构建；顺序反过来会让失败制品进入分发链路。
  ["ci-pipelines", "static-quality-gates", "runtime", "执行质量门禁"],
  ["ci-pipelines", "desktop-e2e-harness", "runtime", "调度 E2E"],
  ["ci-pipelines", "multi-target-build", "runtime", "调度构建矩阵"],
  ["multi-target-build", "desktop-packaging-signing", "runtime", "准备打包输入"],
  ["desktop-packaging-signing", "artifact-distribution", "delivery", "签名制品"],
  ["release-orchestration", "artifact-distribution", "delivery", "审批并发布"],
  ["static-quality-gates", "release-orchestration", "invariant", "发布门禁不得绕过"],
  ["artifact-distribution", "client-update-lifecycle", "delivery", "update feed 与安装包"],
  ["artifact-distribution", "remote-host", "delivery", "远程 runtime assets"],
  // 夹具为 E2E 提供确定性响应；任何真实网络回退都会破坏可复现性。
  ["capture-replay-fixtures", "desktop-e2e-harness", "shared", "确定性 provider 响应"],
  ["capture-replay-fixtures", "cli-tool-replay", "shared", "capture/replay source"],
  ["cross-platform-e2e", "desktop-e2e-harness", "runtime", "跨平台 shard"],
  ["cross-platform-e2e", "remote-host", "runtime", "验证 SSH / WSL / Docker"],
  ["desktop-e2e-harness", "electron-platform", "runtime", "启动真实桌面"],
  ["cli-tool-replay", "runtime-bootstrap", "runtime", "启动 CLI 与工具回放"],
  ["fault-injection", "desktop-e2e-harness", "shared", "注入故障边界"],
  ["coverage-governance", "case-admission-promotion", "shared", "准入与覆盖门槛"],
  ["case-admission-promotion", "cross-platform-e2e", "runtime", "晋级 verified suite"],
  ["desktop-e2e-harness", "e2e-reporting", "state", "summary 与失败制品"],
  ["cross-platform-e2e", "e2e-reporting", "state", "平台结果汇总"],
  ["e2e-reporting", "quality-metrics", "state", "结构化结果"],
  ["e2e-reporting", "feedback-tickets", "delivery", "失败报告平台"],
  ["coverage-governance", "quality-metrics", "state", "覆盖缺口"],
  ["engineering-performance", "ci-pipelines", "state", "时长与预算反馈"],
  ["quality-metrics", "product-telemetry", "invariant", "不得混入产品数据"],
];

// 导出的系统对象数组：由定义 tuple 一对一映射，长度与顺序同 systemDefinitions；
// 返回值不保证冻结，修改应回到定义区完成。
// [契约] 导出层只做形态映射，不做校验与排序；因此「定义即事实」，任何修复都应回到 systemDefinitions。
// 导出数组与定义数组等长同序，UI 依赖该假设做分区，不要在 map 里过滤。
export const capabilitySystems: CapabilitySystem[] = systemDefinitions.map(
  ([id, name, owner, description]) => ({ id, name, owner, description }),
);

// 导出的能力群数组；systemId 引用能力系统 id，codeEstimate 由 tuple 的数值与置信度组装。
// codeEstimate 是嵌套对象，导出时新建，避免外部改写 tuple 中的原始数值。
// systemId 原样透传，不在导出层做存在性检查；悬空 systemId 由 UI 表现为未分组。
export const capabilityGroups: CapabilityGroup[] = groupDefinitions.map(
  ([id, systemId, name, owner, description, productionLines, confidence]) => ({
    id,
    systemId,
    name,
    owner,
    description,
    codeEstimate: {
      productionLines,
      confidence,
    },
  }),
);

// 导出的能力节点数组；groupId 引用能力群 id，但此层不做引用完整性校验（由 UI/审计脚本比对）。
// 节点导出保持定义顺序；UI 分组依赖稳定顺序，按 id 重排会让同组节点跳动。
// 此处不做 groupId 引用校验：历史数据中存在跨版本残留，强校验会让整页加载失败。
export const capabilityNodes: CapabilityNode[] = nodeDefinitions.map(
  ([id, groupId, label, scope, authority]) => ({
    id,
    groupId,
    label,
    scope,
    authority,
  }),
);

// 导出的能力边数组：id 为 "edge-1" 起的稳定序号，source/target 允许指向未声明节点（历史数据容忍）。
// [契约] edge id 一旦发布即对外稳定；新增边只能追加到数组尾部，不能插到中间。
// source/target 允许暂时悬空，是给跨版本数据留的容忍度，不是允许长期缺边。
export const capabilityEdges: CapabilityEdge[] = edgeDefinitions.map(
  ([source, target, type, label], index) => ({
    id: `edge-${index + 1}`,
    source,
    target,
    type,
    label,
  }),
);

// 关系类型到中文展示名的完整映射；键集合必须覆盖 CapabilityRelationType 的全部取值。
// 这里是关系类型的唯一展示真源；图例、筛选器与悬浮说明都读它，不要在组件里再写一份中文映射。
// 新增 relation type 时 TypeScript 的 Record 会强制补齐，先改类型再补名是最安全的顺序。
export const capabilityRelationNames: Record<CapabilityRelationType, string> = {
  delivery: "交付",
  invariant: "隔离",
  runtime: "执行",
  shared: "共享",
  state: "状态",
};
