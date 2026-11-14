// 快速选择（quick pick）命令注册表：把宿主能力（新建任务、打开工作区、切换面板与标签、
// 主题、账号、反馈等）投影成一个纯数据的命令数组，供命令面板渲染、过滤与执行。
// 本文件不持有 UI 状态、不发请求、不读全局 store；同样的入参必然得到同样的输出，
// 因此可以在每次面板打开时重建而不需要缓存，也就不存在读到过期上下文的问题。
// INV-01 输出数组中 id 全局唯一，“settings”与“suggested-settings”是刻意的两个命令；守住位置：createQuickPickCommands 内全部字面量 id；改错故障：列表 key 冲突导致渲染复用错误节点，回车执行到另一条命令。
// INV-02 每条命令的 sectionId 必须落在 QUICK_PICK_SECTION_ORDER 之内，分区顺序只由该数组决定；守住位置：sectionId 字段与分区常量；改错故障：命令落进错误分组或分组顺序抖动，用户按肌肉记忆找不到条目。
// INV-03 titleId 是 i18n key，禁止拼接或内联任何自然语言文案；守住位置：每条命令的 titleId；改错故障：切换语言后条目显示原始 key，面板里出现裸点号字符串。
// INV-04 keywords 必须同时包含英文与中文检索词，且除专有名词外保持小写；守住位置：每条命令的 keywords；改错故障：中文输入法用户搜不到条目，只能靠逐条滚动查找。
// INV-05 shortcut 只用于展示，不在此处判重或注册绑定；守住位置：shortcut 字段与 shortcuts 入参；改错故障：与宿主快捷键注册表双写，冲突检测失效且两处文案漂移。
// INV-06 disabled 只表达“当前上下文不可执行”，绝不等于隐藏；守住位置：open-workspace 的 disabled 字段；改错故障：把禁用写成过滤会让用户以为功能被删除，而不是当前不可用。
// INV-07 run 必须是惰性函数，禁止在构造命令表的过程中被调用；守住位置：所有 run 字段；改错故障：面板一打开就触发打开工作区、登出等副作用。
// INV-08 run 的异步失败由调用方捕获，本文件不吞异常；守住位置：createQuickPickCommands 的返回值契约；改错故障：在此处 try 掉错误会让登录或反馈失败静默无声。
// INV-09 能力开关（内嵌浏览器、终端、审查）缺省为 true，只有显式 false 才裁剪；守住位置：解构默认值与末尾 filter；改错故障：漏传开关时功能整片消失，回归定位困难。
// INV-10 allowOpenWorkspace 为 false 时条目仍在且位置不变，只置 disabled；守住位置：open-workspace 条目；改错故障：条目位移会打乱用户对列表位置的预期。
// INV-11 canOpenCommunity 为 false 时整条不出现，权限或环境不足不能留入口；守住位置：canOpenCommunity 分支；改错故障：点击后进入空白社群页且无返回路径。
// INV-12 login 与 logout 互斥：已登录只出登出，未登录只出登录，handler 缺失时都不出；守住位置：isLoggedIn 与两个可选 handler 的联合判定；改错故障：同时出现登录与登出，或渲染出点击无反应的条目。
// INV-13 同一个 handler 可挂在多条命令上，但 id 不得复用；守住位置：settings 与 suggested-settings；改错故障：合并成一个 id 会破坏分区语义，用户找不到建议区的设置入口。
// INV-14 themeTarget 是切换目标而非当前主题，titleId 与 icon 必须成对取值；守住位置：switch-theme 的两处三元表达式；改错故障：文案说切到深色却点亮浅色图标，用户无法判断当前主题。
// INV-15 icon 必须是 QuickPickCommandIcon 的成员，toggle-sidebar 的图标随可见性翻转；守住位置：icon 字段与 isSidebarVisible 三元；改错故障：图标缺失渲染成空白方块，侧栏状态也无法从图标读出。
// INV-16 数组书写顺序即模糊匹配同分时的最终 tie-break，不依赖调用方二次排序；守住位置：commands 字面量的条目顺序；改错故障：同分条目每次打开位置不同，用户点击落空。
// INV-17 条件命令统一用 push 追加在字面量之后，段落顺序与字面量保持同一语义；守住位置：四处 push 调用；改错故障：条件命令插到中间会让应用分区顺序随登录态漂移。
// INV-18 本函数是纯函数：不改写入参、不读外部可变状态、返回新数组；守住位置：整体实现与末尾 filter；改错故障：调用方共享的 handlers 或 shortcuts 被意外改写，造成跨面板串扰。
export type QuickPickCommandIcon =
  | "book"
  | "browser"
  | "community"
  | "diff"
  | "feedback"
  | "folder"
  | "login"
  | "logout"
  | "message"
  | "mcp"
  | "settings"
  | "sidebarClose"
  | "sidebarOpen"
  | "skills"
  | "themeDark"
  | "themeLight"
  | "terminal";

export type QuickPickCommandSectionId =
  | "suggested"
  | "chat"
  | "navigation"
  | "panels"
  | "configure"
  | "app";

// 分区顺序是唯一的展示真值：渲染层只按这个数组切组，不自行排序。
// [权衡] 若让渲染层按 sectionId 字典序排，新增分区会莫名插到中间，
// 用户对“设置总在最下面”的位置记忆被打断；显式数组让顺序改动变成一次可评审的 diff。
export const QUICK_PICK_SECTION_ORDER: QuickPickCommandSectionId[] = [
  "suggested",
  "chat",
  "navigation",
  "panels",
  "configure",
  "app",
];

// 命令的形状契约：id 定位、sectionId 分组、titleId 取文案、keywords 供匹配，
// shortcut 仅展示。这里不引入选中或悬停事件，是因为面板只需要“执行”这一种意图；
// [权衡] 若把交互态也建模进注册表，命令表就会反向依赖面板内部状态，
// 同一份表无法再被 CLI 或测试复用。
export interface QuickPickCommand {
  id: string;
  sectionId: QuickPickCommandSectionId;
  titleId: string;
  icon: QuickPickCommandIcon;
  shortcut?: string;
  keywords: string[];
  disabled?: boolean;
  run: () => void | Promise<void>;
}

// handlers 是宿主注入的能力集合，本文件只引用不实现：注册表因此零依赖，
// 单测可用纯假实现覆盖全部条目，无需挂载真实 store 或网络层。
interface QuickPickCommandHandlers {
  createTask: () => void;
  openWorkspace: () => void;
  openSettings: () => void;
  openSkillsSettings: () => void;
  openMcpSettings: () => void;
  switchTheme: () => void;
  openFeedback: () => void | Promise<void>;
  openCommunity: () => void | Promise<void>;
  openProductDocs: () => void | Promise<void>;
  login?: () => void | Promise<void>;
  logout?: () => void | Promise<void>;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  togglePreview: () => void;
  openTerminalTab: () => void;
  openBrowserTab: () => void;
  openReviewTab: () => void;
}

// 上下文快照：能力开关、侧栏可见性、登录态、主题目标、快捷键文案与 handlers 一次传入。
// [权衡] 这里刻意传值而不传 getState 之类的读取器——若传读取器，
// 同一次渲染内不同命令会读到不同时刻的状态，出现侧栏已关但图标仍显示关闭的撕裂；
// [失败路径] 漏传某个能力开关时按 true 处理（见解构默认值），避免功能被静默裁掉。
interface CreateQuickPickCommandsOptions {
  allowOpenWorkspace: boolean;
  canOpenCommunity: boolean;
  isSidebarVisible: boolean;
  isLoggedIn: boolean;
  supportsEmbeddedBrowser?: boolean;
  supportsTerminal?: boolean;
  supportsReview?: boolean;
  themeTarget: "dark" | "light";
  shortcuts: {
    newTask: string;
    openWorkspace: string;
    toggleSidebar: string;
    toggleTerminal: string;
  };
  handlers: QuickPickCommandHandlers;
}

export function createQuickPickCommands({
  allowOpenWorkspace,
  canOpenCommunity,
  isSidebarVisible,
  isLoggedIn,
  supportsEmbeddedBrowser = true,
  supportsTerminal = true,
  supportsReview = true,
  themeTarget,
  shortcuts,
  handlers,
}: CreateQuickPickCommandsOptions): QuickPickCommand[] {
  // 主表用字面量一次性写出，保证“阅读顺序 = 展示顺序 = 同分 tie-break”，
  // 条件命令随后用 push 追加，避免在字面量里混入大量三元展开。
  // [失败路径] 任何一条漏写 sectionId 都会在渲染层落到未知分区，条目直接不可见。
  const commands: QuickPickCommand[] = [
    {
      // 首条固定是“新建任务”：面板打开即回车的高频路径，位置不能随上下文移动。
      // 它的 run 直接绑定 handlers.createTask，不做包装，便于测试断言是同一引用。
      id: "new-task",
      sectionId: "suggested",
      titleId: "quickPick.command.newTask",
      icon: "message",
      shortcut: shortcuts.newTask,
      keywords: ["new", "task", "任务", "新任务", "新建任务"],
      run: handlers.createTask,
    },
    {
      // [权衡] 工作区不可打开时保留条目并置 disabled，而不是过滤掉：
      // 用户仍能看到入口与对应快捷键，知道功能存在、当前环境不可用，
      // 而不是以为这个能力已经从产品里移除。
      id: "open-workspace",
      sectionId: "suggested",
      titleId: "quickPick.command.openWorkspace",
      icon: "folder",
      shortcut: shortcuts.openWorkspace,
      keywords: ["open", "workspace", "folder", "project", "打开", "文件夹", "项目"],
      disabled: !allowOpenWorkspace,
      run: handlers.openWorkspace,
    },
    {
      // 与配置分区的 settings 指向同一个 handler，但 id 与分区都不同：
      // “建议”区承担发现性，“配置”区承担查找性，两条入口互不替代。
      id: "suggested-settings",
      sectionId: "suggested",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      // icon 随 isSidebarVisible 翻转，表达“点击后会发生什么”而不是当前状态；
      // [失败路径] 若 icon 与 shortcut 描述的方向不一致，用户会误判侧栏当前是否展开，
      // 按下快捷键后得到与预期相反的结果。
      id: "toggle-sidebar",
      sectionId: "panels",
      titleId: "quickPick.command.toggleSidebar",
      icon: isSidebarVisible ? "sidebarClose" : "sidebarOpen",
      shortcut: shortcuts.toggleSidebar,
      keywords: ["sidebar", "left sidebar", "toggle sidebar", "侧栏", "侧边栏", "切换侧栏"],
      run: handlers.toggleSidebar,
    },
    {
      // 终端开关无条件出现在主表中，是否可用交给末尾的能力过滤统一裁剪，
      // 避免“这里判一次、那里再判一次”造成两处条件漂移。
      id: "toggle-terminal",
      sectionId: "panels",
      titleId: "quickPick.command.toggleTerminal",
      icon: "terminal",
      shortcut: shortcuts.toggleTerminal,
      keywords: ["terminal", "shell", "console", "终端"],
      run: handlers.toggleTerminal,
    },
    // 条件条目用展开语法拼进主表，而不是 push 到末尾：
    // 面板分区依赖数组顺序，面板组内的预览必须紧跟终端开关，不能跑到应用组后面。
    // [权衡] 展开写法牺牲了一点可读性，换来顺序在源码里一眼可见。
    // satisfies 只做类型检查不改变推断结果，保证展开后的元素仍被收窄到命令形状。
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "toggle-preview",
            sectionId: "panels",
            titleId: "quickPick.command.togglePreview",
            icon: "browser",
            keywords: [
              "preview",
              "browser",
              "web",
              "show",
              "hide",
              "预览",
              "浏览器",
              "网页",
              "显示",
              "隐藏",
            ],
            run: handlers.togglePreview,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      // 新开标签与显示隐藏面板是两种意图：前者不改变面板可见性，
      // 因此不复用 toggle 的 handler，也不共享 id。
      id: "add-terminal-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addTerminalTab",
      icon: "terminal",
      keywords: ["add", "terminal", "tab", "new terminal", "添加终端", "终端标签"],
      run: handlers.openTerminalTab,
    },
    // 浏览器标签的追加能力同样受内嵌浏览器开关约束，与上面的预览开关同源：
    // 关闭内嵌浏览器时两者必须一起消失，不能留下能加标签却没有面板的死路。
    // [失败路径] 只裁剪其中一个，用户会点进一个永远渲染不出来的空标签。
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "add-browser-tab",
            sectionId: "panels",
            titleId: "quickPick.command.addBrowserTab",
            icon: "browser",
            keywords: ["add", "browser", "tab", "preview", "添加浏览器", "浏览器标签"],
            run: handlers.openBrowserTab,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      // 审查标签的可用性由审查能力单独控制，与内嵌浏览器无关：
      // [权衡] 两者都渲染在面板区，但依赖的宿主能力不同，合并开关会让裁剪粒度变粗，
      // 只支持审查、不支持网页预览的宿主会同时丢功能。
      id: "add-review-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addReviewTab",
      icon: "diff",
      keywords: ["add", "review", "diff", "changes", "添加审查", "审查标签", "变更"],
      run: handlers.openReviewTab,
    },
    {
      // 配置分区的设置入口：与建议区同名不同 id，
      // 排在主题切换之前，因为改配置比换皮肤更常用。
      id: "settings",
      sectionId: "configure",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      // themeTarget 是切换后要去的目标，不是当前主题：文案与图标都按目标取值。
      // [失败路径] 若两处三元条件写反，会出现提示切到深色却点亮浅色图标的矛盾，
      // 用户无法从条目判断当前处于哪一端。
      // [权衡] 不在此处读取主题状态，把当前与目标的换算留给宿主，保持纯函数。
      id: "switch-theme",
      sectionId: "configure",
      titleId:
        themeTarget === "dark"
          ? "quickPick.command.switchThemeToDark"
          : "quickPick.command.switchThemeToLight",
      icon: themeTarget === "dark" ? "themeDark" : "themeLight",
      keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
      run: handlers.switchTheme,
    },
    {
      // 技能与 MCP 各自独立成条，不合并为“扩展设置”：
      // 两者检索词与心智模型不同，合并后无论搜技能还是搜服务器都只能命中一条。
      id: "skills-settings",
      sectionId: "configure",
      titleId: "quickPick.command.skills",
      icon: "skills",
      keywords: ["skills", "skill", "配置", "技能"],
      run: handlers.openSkillsSettings,
    },
    {
      // keywords 里保留大写 MCP 便于展示层高亮，大小写折叠由匹配层负责；
      // 中文侧只放“服务器”，因为 MCP 本身就是用户会直接输入的原文。
      id: "mcp-settings",
      sectionId: "configure",
      titleId: "quickPick.command.mcpServers",
      icon: "mcp",
      keywords: ["mcp", "server", "servers", "MCP", "服务器"],
      run: handlers.openMcpSettings,
    },
  ];

  // 从这里开始用 push 追加条件与尾部命令：字面量只保留无条件条目。
  // [权衡] 若全部塞进字面量，需要多层嵌套展开，顺序反而更难核对；
  // push 段与字面量共同遵守建议、对话、导航、面板、配置、应用的段落顺序。
  commands.push({
    id: "feedback",
    sectionId: "app",
    titleId: "quickPick.command.feedback",
    icon: "feedback",
    keywords: [
      "feedback",
      "issue",
      "support",
      "tickets",
      "问题上报",
      "问题反馈",
      "反馈",
      "我的反馈",
      "工单",
    ],
    run: handlers.openFeedback,
  });

  // 社群入口带权限与环境判定，不满足时整条不出现而不是置灰：
  // 置灰会让用户以为登录后即可访问，实际是该环境完全没有社群服务。
  // [失败路径] 强行放行会跳到空白页，且没有返回路径。
  if (canOpenCommunity) {
    commands.push({
      id: "community",
      sectionId: "app",
      titleId: "quickPick.command.community",
      icon: "community",
      keywords: ["community", "users", "chat", "用户社群", "社群"],
      run: handlers.openCommunity,
    });
  }

  // 产品文档对所有环境开放，不挂任何能力开关：它是功能不可用时的兜底出口，
  // [失败路径] 一旦被裁剪，用户在受限环境里连帮助入口都没有。
  commands.push({
    id: "product-docs",
    sectionId: "app",
    titleId: "quickPick.command.productDocs",
    icon: "book",
    keywords: ["docs", "documentation", "product docs", "文档", "产品文档"],
    run: handlers.openProductDocs,
  });

  // 账号动作的互斥判定：已登录且注入了登出才出登出，
  // 否则未登录且注入了登录才出登录；handler 缺失时两条都不出。
  // [失败路径] 只判登录态不判 handler，会在未接账号体系的宿主里渲染出点击无反应的条目。
  // [权衡] 用互斥分支而不是两个独立条件，保证任何状态下账号相关条目最多一条。
  if (isLoggedIn && handlers.logout) {
    commands.push({
      id: "logout",
      sectionId: "app",
      titleId: "quickPick.command.logout",
      icon: "logout",
      keywords: ["disconnect", "logout", "sign out", "断开连接", "登出"],
      run: handlers.logout,
    });
  // 登录分支位于 else 侧：登录态切换时两条命令是替换关系，不是并列关系。
  // [权衡] 两条都属应用分区且排序相邻，替换时列表长度不变，视觉上不产生跳动。
  // 这里不保留上一次会话的条目，避免登出后仍能点到遗留动作。
  } else if (!isLoggedIn && handlers.login) {
    commands.push({
      id: "login",
      sectionId: "app",
      titleId: "quickPick.command.login",
      icon: "login",
      // 命令面板的账号动作对用户表达为“连接/断开连接”，搜索词也要同步。
      keywords: ["connect", "login", "sign in", "连接", "登录"],
      run: handlers.login,
    });
  }

  // 能力裁剪放在最后统一做，保证主表的书写顺序不受开关影响；
  // [失败路径] 若在构造期就分支裁剪，同一分区在不同宿主上的相对顺序会漂移，模糊匹配同分时的 tie-break 也因此改变。
  return commands.filter(
    (command) =>
      (supportsTerminal ||
        (command.id !== "toggle-terminal" && command.id !== "add-terminal-tab")) &&
      (supportsReview || command.id !== "add-review-tab"),
  );
}
