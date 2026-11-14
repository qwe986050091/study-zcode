// INV-01 本表是内置斜杠命令名的唯一真源：保留名、TUI 补全、App 目录与 /help 都由它派生。守住位置：export 语句；改错故障：某端另存一份名单，新增命令只在一处生效。
// INV-02 name 在表内必须唯一且不带前导斜杠：调用方用 find 取第一条匹配。守住位置：各条目 name 字段；改错故障：重名时后一条永不被命中，目录与帮助展示错条目。
// INV-03 name 与 aliases 会归一化后并入保留名集合，归一化口径是 trim、去掉前导斜杠、转小写。守住位置：条目字面量；改错故障：别名漏写，用户同名自定义命令可覆盖内置语义。
// INV-04 aliases 只在确有历史别名时出现，且不得与任何 name 或其他别名重复。守住位置：六个带 aliases 的条目；改错故障：两个命令抢同一别名，先注册者静默吞掉输入。
// INV-05 usage 必须自带前导斜杠并保留方括号可选段，调用方直接把它当输入提示展示。守住位置：各条目 usage；改错故障：提示缺斜杠，用户照抄后命令不被解析。
// INV-06 workflow 的 usage 前缀被 builtin-workflow-command 用 startsWith 解析参数提示。守住位置：该条目的 usage；改错故障：前缀不符时参数提示退化成空串。
// INV-07 workflow 条目必须永远留在表内，灰度门在调用方过滤而不在这里删除。守住位置：workflow 条目；改错故障：删掉后 builtin-workflow-command 模块加载即抛错，CLI 无法启动。
// INV-08 summary 是 App 目录 description 的唯一来源，一句话写清命令用途。守住位置：各条目 summary；改错故障：目录与 /help 说法不一致，用户以为是两个命令。
// INV-09 details 是 /help 正文来源，按数组顺序逐行展示，每行只讲一件事。守住位置：各条目 details；改错故障：两件事挤进一行，窄终端折行后语义粘连。
// INV-10 details 只描述当前真实行为，不写计划中的能力。守住位置：各条目 details；改错故障：帮助承诺未实现的分支，用户按提示操作只会拿到报错。
// INV-11 表内顺序只影响本表的遍历，App 面板顺序由 slash-command-surface 的白名单决定。守住位置：数组元素次序；改错故障：误以为改这里就能改面板排序，两处长期不一致。
// INV-12 新增命令必须同时补条目与实现：表里缺席意味着命令不可寻址。守住位置：数组新增项；改错故障：只有实现没有条目，保留名缺失，同名自定义命令可抢注。
// INV-13 aliases 与 details 是 readonly 数组，调用方不得原地修改。守住位置：类型定义的两个字段；改错故障：某处 push 共享数组，跨会话串味且难以复现。
// INV-14 对外类型由显式注解固定，as const 只做本文件内的兜底，新增字段先改类型。守住位置：类型声明与 as const；改错故障：只在字面量里多写一个键，消费方按类型读不到。
// INV-15 文案面向用户，用完整单句说明行为；命令名与用法保留英文原文。守住位置：details、summary、usage 文本；改错故障：混入内部术语或占位符，会原样展示给用户。
// INV-16 usage 里列出的参数枚举必须与可执行分支一致，新增取值时两边同步。守住位置：mode、model、locale 等带枚举的 usage；改错故障：提示里有、解析层不认，输入被判未知。
// INV-17 本文件是纯数据模块：不做 I/O、不读配置、不判断灰度。守住位置：整个文件体；改错故障：把门控搬进来，单测与嵌入方无法覆盖另一分支。
// INV-18 没有别名时省略 aliases 字段，消费方用空值兜底读取。守住位置：无别名条目的字段集合；改错故障：写空数组虽等价，但会让有无别名的检查多绕一层。
//
// 模块职责：内置斜杠命令的帮助元数据表，name/summary/usage/details/aliases 五项即对外契约。
// 状态所有权：纯静态常量，没有运行时状态；唯一写入点在本文件，所有调用方只读。
// 阅读顺序：先看类型定义，再看 20 个条目，最后对照 apps/zcode-cli 下的保留名、TUI 与协议消费点。
export type BuiltinZCodeSlashCommandHelpEntry = {
  // 类型是本表的唯一契约：五个字段全必填，只有 aliases 可省略。
  // details 与 aliases 声明为 readonly 数组：调用方拿到共享值，不得原地修改。
  // usage 带前导斜杠与方括号可选段，会被直接当作输入提示展示。
  // 字段顺序在类型里固定为 aliases、details、name、summary、usage，便于逐条对照。
  aliases?: readonly string[];
  details: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

// 元素类型显式写成 readonly 数组，导出形状不依赖类型推导。
// 它防止字面量被拓宽、数组被就地改写，不改变导出的元素类型。
// 20 个条目按数组顺序遍历，但 App 面板顺序另有白名单，两者不是一回事。
// 保留名、TUI 补全、App 目录与 /help 共读此表，任何一端另立名单都会漂移。
export const BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES: readonly BuiltinZCodeSlashCommandHelpEntry[] = [
  // help 与 logout 只在本机生效：不创建会话，也不发模型请求。
  // help 的 command 参数允许带或不带前导斜杠，由命令面归一化后再查表。
  // logout 的承诺只有删除共享 Z.ai OAuth 凭据，不要在此追加清理模型或会话的说法。
  {
    details: [
      "Shows command-center help locally without creating a session or sending a model prompt.",
      "Pass a command name with or without the leading slash for command-specific help.",
    ],
    name: "help",
    summary: "Show this slash command help.",
    usage: "/help [command]",
  },
  // login 无参时先开 Coding Plan 选择器，而不是直接登录某个 provider。
  // Z.ai 与 BigModel 走浏览器登录并轮询授权，成功后保存凭据并刷新可用模型。
  // 两个 api-key 变体把密钥作为参数传入，调用时直接给值。
  // usage 列出四种调用形态，details 说明各自走哪条路径；新增变体必须同时改这两处。
  {
    details: [
      "Opens a Coding Plan setup picker when called without arguments.",
      "Z.ai and BigModel browser login poll for authorization, then securely save credentials and refresh available models.",
      "Manual API key variants accept the API key as an argument.",
    ],
    name: "login",
    summary: "Set up a Coding Plan provider.",
    usage:
      "/login [zai-coding-plan|bigmodel-coding-plan|zai-coding-plan-api-key <api-key>|bigmodel-coding-plan-api-key <api-key>]",
  },
  {
    details: ["Deletes Z.ai OAuth credentials from the shared ZCode credential store."],
    name: "logout",
    summary: "Remove the shared Z.ai login credentials.",
    usage: "/logout",
  },
  // compact 只转发可选的摘要指令，压缩动作由核心手动压缩路径完成。
  // init 走普通 agent 回合：模型先检查工作区，再创建或更新 AGENTS.md。
  // init 的目标是工作区根的 AGENTS.md，不是用户目录下的同名文件；已存在时应当编辑而非覆盖。
  {
    details: ["Runs the core manual compaction path and forwards optional summary instructions."],
    name: "compact",
    summary: "Compact the current conversation with optional instructions.",
    usage: "/compact [instructions]",
  },
  {
    details: [
      "Runs a normal agent turn that inspects the current workspace and creates or updates AGENTS.md.",
      "Existing AGENTS.md files should be edited rather than overwritten.",
      "This command targets the workspace root, not the user default ~/.zcode/AGENTS.md.",
    ],
    name: "init",
    summary: "Create or update workspace AGENTS.md instructions.",
    usage: "/init [notes]",
  },
  // expert 带任务时以 yolo 模式启动一段可持久化的专家工作流。
  // status、resume、stop 管理最近一次或具名的那次运行，不是新开会话。
  // dwf 列出本会话的动态工作流运行，是否可恢复由服务端判定。
  // dwf 的 cancel 不带 runId 时只取消唯一在飞的运行，有多个则改为列出候选。
  {
    details: [
      "Starts a durable expert workflow in yolo mode when called with a task.",
      "Use status, resume, or stop to manage the latest or a named workflow run.",
    ],
    name: "expert",
    summary: "Run or manage the expert workflow.",
    usage: "/expert [status|resume|stop|<task>]",
  },
  // effort 的 variant 是历史别名，两者落到同一条目。
  // 不带参数或 list 只展示当前与可选档位，真正切换要给出列表中的某一档。
  // model 选中模型时带上该模型的默认推理档位；改档位是 effort 的职责，两者不互相覆盖。
  {
    aliases: ["variant"],
    details: [
      "In the TUI, type /effort or /variant to open composer suggestions.",
      "Submitting the empty command or list shows the current and selectable efforts as text.",
      "Use a listed level to switch the current session reasoning effort.",
    ],
    name: "effort",
    summary: "Show or switch the current session reasoning effort.",
    usage: "/effort [list|<level>]",
  },
  {
    details: [
      "Lists this session's dynamic workflow runs with server-decided status and resumability.",
      "cancel without a run id cancels the only in-flight run, or lists candidates when there are several.",
      "resume asks the server; a run the server refuses reports the structured reason.",
    ],
    name: "dwf",
    summary: "List, cancel, or resume dynamic workflow runs.",
    usage: "/dwf [list|cancel [runId]|resume <runId>]",
  },
  {
    details: [
      "In the TUI, opens a checkpoint picker when called without arguments.",
      "Use latest or a specific checkpoint id to bypass the picker.",
    ],
    name: "fork",
    summary: "Fork a new session from a workspace checkpoint.",
    usage: "/fork [latest|checkpointId]",
  },
  {
    aliases: ["language"],
    details: [
      "Shows the current UI locale when called without arguments.",
      "Use auto, en-US, or zh-CN to switch and persist the UI locale.",
    ],
    name: "locale",
    summary: "Show or switch the UI locale.",
    usage: "/locale [auto|en-US|zh-CN]",
  },
  // mcp 默认列出服务器状态；connect 与 disconnect 只作用于当前会话的连接。
  // mcp 的参数必须是已配置的服务器名，取自现有配置。
  // plugins 不带参数时打开 TUI 插件面板，列表用 ✓ 与 ○ 区分启用和禁用。
  // plugins 的 enable 与 disable 会写进用户配置，能力变化只对新会话生效。
  {
    details: [
      "Lists MCP server status by default.",
      "Use connect or disconnect with a configured server name to manage the session connection.",
    ],
    name: "mcp",
    summary: "Show or manage configured MCP servers.",
    usage: "/mcp [list|status|connect <server>|disconnect <server>]",
  },
  {
    aliases: ["plugin"],
    details: [
      "Opens a TUI plugin panel when called without arguments.",
      "Rows show ✓ for enabled plugins and ○ for disabled plugins.",
      "Use enable or disable with a plugin id to persist the switch in user config.",
      "Plugin capability changes apply to new sessions.",
    ],
    name: "plugins",
    summary: "Open the plugin manager.",
    usage: "/plugins [list|enable <plugin>|disable <plugin>]",
  },
  // mode 不带参数时展示当前权限模式；TUI 里输入斜杠会先弹本地选择器再提交。
  // 可切换模式固定为 plan、build、edit、yolo、guarded 五种，usage 与 details 必须同改。
  // locale 不带参数只展示当前语言；auto、en-US、zh-CN 会写回用户配置并持久化。
  {
    details: [
      "Shows the current permission mode when submitted without arguments.",
      "Interactive TUI composer input opens a local picker before submit.",
      "Switchable modes are plan, build, edit, yolo, and guarded.",
      "Picker rows and explicit input submit /mode <mode> commands.",
    ],
    name: "mode",
    summary: "Show or switch the current permission mode.",
    usage: "/mode [plan|build|edit|yolo|guarded]",
  },
  {
    details: [
      "Shows the current and selectable models when called without arguments or with list.",
      "Use a provider/model id to select a model with its default reasoning effort; use /effort to change the effort.",
    ],
    name: "model",
    summary: "Show or switch the current session model.",
    usage: "/model [list|provider/model]",
  },
  // 该命令 new 新建根会话并重置 TUI 的会话投影，clear 是它的别名。
  // resume 省略参数时弹会话选择器；continue 直接恢复当前目录最近的根会话。
  // fork 从工作区检查点分叉出新会话，rewind 则是回看或就地恢复检查点。
  // resume、fork、rewind 无参时都弹选择器，但恢复对象分别是会话与检查点，不能互相替代。
  {
    aliases: ["clear"],
    details: ["Starts a fresh root session and resets the TUI session projection."],
    name: "new",
    summary: "Start a fresh session in the TUI.",
    usage: "/new",
  },
  {
    aliases: ["continue"],
    details: [
      "In the TUI, opens a session picker when called without arguments.",
      "Resumes a specific session id when provided.",
      "/continue resumes the latest root session for the current directory.",
    ],
    name: "resume",
    summary: "Resume a saved session.",
    usage: "/resume [sessionId]",
  },
  {
    details: [
      "In the TUI, opens a checkpoint picker when called without arguments.",
      "Use status to show the latest checkpoint, or latest/a checkpoint id to restore directly.",
    ],
    name: "rewind",
    summary: "Inspect or restore workspace checkpoints.",
    usage: "/rewind [latest|checkpointId]",
  },
  // skill 不带名字时只列出当前工作目录可见的技能。
  // skill 带名字时改写下一条 prompt，要求模型先经 Skill 工具加载该技能正文。
  // goal 设置新目标会覆盖已有目标，replace 只是显式的同义写法。
  // workflow 先加载动态工作流技能再提交 CreateWorkflow；桌面端只在灰度开启时提供该命令。
  {
    details: [
      "Without a name, lists discoverable skills for the current working directory.",
      "With a name, rewrites the next prompt so the Skill tool must load that skill first.",
    ],
    name: "skill",
    summary: "List skills, or force the next prompt to load one.",
    usage: "/skill [<skill-name> [task]]",
  },
  {
    aliases: ["target"],
    details: [
      "Shows the current session goal when called without arguments.",
      "Setting a new objective overwrites an existing goal; replace is an explicit alias.",
      "Use pause, resume, or clear to manage the current goal.",
    ],
    name: "goal",
    summary: "Show or set the current session goal.",
    usage: "/goal [pause|resume|clear|replace <objective>|<objective>]",
  },
  {
    details: [
      "Loads the dynamic-workflows skill, then writes a workflow script and submits it with CreateWorkflow.",
      "Runs as a normal agent turn; the workflow starts only after you confirm the script.",
      "In the desktop app the command is offered only while dynamic workflows are enabled for this client.",
    ],
    name: "workflow",
    summary: "Design and launch a dynamic workflow for a task.",
    usage: "/workflow [what the workflow should accomplish]",
  },
] as const;
