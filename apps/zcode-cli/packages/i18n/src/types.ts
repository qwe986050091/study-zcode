// i18n 类型契约：定义 ZCode CLI 与 TUI 全部用户可见文案的结构化键集合，是语言包与渲染层共享的唯一契约。
// 职责边界：只声明键名、嵌套分组与插值函数签名，不承载具体文案、不做语言回退、不读运行期配置。
// 消费方：各语言字典按此结构实现，渲染层只经 ZCodeCopy 取文案，不得绕过类型直取字符串。
// INV-01 每个语言字典的键集合必须与 TuiCopy 以及 CliCopy 的字段声明完全一致，不多不少；守住位置：ZCodeCopy 全部分组；改错故障：缺键处渲染出 undefined 或英文串混入中文界面。
// INV-02 新增文案键必须先在类型里声明再补字典，禁止字典先行；守住位置：TuiCopy 各分组；改错故障：多余键被静默丢弃，界面回落为原始键名。
// INV-03 插值字段一律用函数签名而非字符串占位符；守住位置：TuiCopy.model.retryScheduled 等函数型键；改错故障：占位符未被替换，用户看到原样的花括号文本。
// INV-04 插值参数类型一经声明不可放宽为 string；守住位置：count 与 attempt 等 number 参数；改错故障：数字格式错乱或 NaN 直接展示给用户。
// INV-05 计数类键名必须带 count 语义后缀；守住位置：queuedMore 与 queuedTitle 以及 ended；改错故障：调用方传错参数顺序，单复数文案显示错误数量。
// INV-06 同一分组的空态、加载态、失败态键必须成套存在；守住位置：sidebar.mcp 与 fileMention；改错故障：加载中无文案可显示，界面留白被误认为卡死。
// INV-07 状态集合用 Record 或字面量联合锁定；守住位置：sidebar.subagents.status 与 transcript.workflow.status；改错故障：新增状态无文案，侧栏显示空白标签。
// INV-08 locale 只能来自 SupportedLocale 契约，本文件不得自行扩展取值；守住位置：ZCodeCopy.locale；改错故障：非法 locale 进入渲染层，找不到字典后整屏空白。
// INV-09 类型文件不得出现任何具体语言文案字面量；守住位置：TuiCopy 与 CliCopy 全部分组；改错故障：文案被硬编码，切换语言后部分界面不随之改变。
// INV-10 函数型键必须是纯插值，不得读取全局状态或当前时间；守住位置：CliCopy.errors.localeUnsupported；改错故障：同一输入渲染出不同结果，快照测试随机失败。
// INV-11 数字格式化由调用方或渲染层负责，类型层只收原始 number；守住位置：queuedTitle 与 tools 与 ended 的 count；改错故障：千分位与本地化数字规则在键实现里分裂成多套。
// INV-12 外部不可信文本必须作为参数传入，不得拼进键名；守住位置：toolName 系列键；改错故障：工具名中的特殊字符污染文案结构或导致渲染异常。
// INV-13 同一语义只保留一个键，禁止近似重复键并存；守住位置：copy.failed 与 model.requestFailed；改错故障：两处文案漂移，同一错误在不同界面表述不同。
// INV-14 分组层级只表达语义归属，不得为排版方便新建分组；守住位置：sidebar 与 transcript 子树；改错故障：同组文案分散，翻译时遗漏且难以发现。
// INV-15 可选属性一律禁用，所有键必须必填；守住位置：TuiCopy 全部字段；改错故障：语言包省字段仍能通过编译，运行期取值为 undefined。
// INV-16 键改名必须同步全部语言字典，类型层不做兼容别名；守住位置：TuiCopy 叶节点；改错故障：编译通过但运行期取不到值，出现空白提示。
// INV-17 本文件只导出类型与类型再导出，不导出实例对象；守住位置：文件顶层导出；改错故障：调用方误把类型模块当字典来源，得到空对象。
// INV-18 默认回退语言的选择在字典加载层完成，类型层不内建回退；守住位置：ZCodeCopy.locale 的使用点；改错故障：回退逻辑分裂到各渲染点，缺键行为不一致。
// INV-19 每个键的语义必须能从分组路径独立推断，不依赖相邻键上下文；守住位置：TuiCopy 全部叶节点；改错故障：翻译者按字面误解语义，产出相反含义的文案。
import type { SupportedLocale } from "@zcode/contracts";

// [设计] locale 类型由 contracts 包统一定义，本包只做再导出，避免出现第二套 locale 枚举
// UiLocale 与 SupportedLocale 分离，UI 层可用语言集合可能小于运行时支持集合
// [失败路径] 若在本文件重复声明联合，新增语言时两处不同步，会在字典查找处报错
// 调用方应从本包导入而不是穿透到 contracts，否则包边界与版本约束失去意义
export type { SupportedLocale, UiLocale } from "@zcode/contracts";

// 顶层契约：locale 决定取哪份字典，cli 与 tui 分流两类渲染场景，互不交叉
// cli 承载一次性命令输出，tui 承载持续重绘的交互界面，分组边界不可混用
// [约束] 三个字段全部必填，缺任一项意味着该视图无法渲染，应在编译期暴露
// 新增渲染域时扩展此处而不是在 tui 内部塞入无关分组
export interface ZCodeCopy {
  cli: CliCopy;
  // 渲染层据此选择字典，不允许调用方另行传入语言参数形成第二来源
  // [失败路径] 该值与可用字典不一致时表现为整片空白或英文兜底
  // 切换语言需要通过状态重算触发重渲染，类型层不提供可变写入入口
  locale: SupportedLocale;
  tui: TuiCopy;
}

// 非交互命令输出的最小文案集合，只覆盖错误提示与 help 正文
// [权衡] 故意保持极薄，避免 CLI 输出与 TUI 文案重复维护两份翻译
// 函数型键接收外部值作为参数，禁止在实现里拼接未转义输入
export interface CliCopy {
  errors: {
    localeUnsupported(value: string): string;
  };
  help(version: string): string;
}

// TUI 交互界面全部文案的根分组，按界面区域划分而非按组件文件划分
// 子分组顺序对应阅读顺序：复制、档位、输入框、登录、模型请求、侧栏
// [约束] 每个子分组内部键名唯一，跨分组可重名但不建议，以免翻译时混淆
// 新增侧栏面板时在 sidebar 下加分组，并补齐空态、加载态、失败态三件套
export interface TuiCopy {
  copy: {
    copied: string;
    failed: string;
    unavailable: string;
  };
  // 思考力度开关的两种状态文案，enabled 与 disabled 必须成对存在
  // [失败路径] 只实现一种状态会导致切换时显示上一种状态的残留文案
  // 状态词不要内嵌冒号或括号，由渲染层负责拼接装饰
  effort: {
    disabled: string;
    enabled: string;
  };
  input: {
    activeStatusHint: string;
    busyPlaceholder: string;
    placeholder: string;
    // 排队输入的超额提示，count 为剩余条数，调用方保证为非负整数
    // [约束] 单复数差异各语言字典内部处理，类型层不暴露 plural 分支
    // count 为 0 时不应调用本键，空队列应走无队列的渲染路径
    queuedMore(count: number): string;
    queuedSubmitHint: string;
    queuedTitle(count: number): string;
    title: string;
    noHistorySource: string;
    noPreviousInput: string;
    restoredPreviousInput: string;
    restoredPreviousInputWithAttachments(count: number): string;
    restorePreviousInputFailed: string;
    typePrompt: string;
  };
  loginRequired: {
    help: string;
    message: string;
    status: string;
    title: string;
  };
  // 登录引导向导的三段式文案：选项、等待、输入，缺一段则流程中断
  // options 下四个登录方式结构对称，便于渲染层统一遍历
  // [权衡] 结构重复而非泛型抽象，换取字典可读性与翻译上下文完整
  // 新增登录方式必须同时补 primary 与 secondary 两个层级
  loginSetup: {
    emptyMessage: string;
    help: string;
    options: {
      // API Key 登录方式的四段文案：主副标题、输入态主副文案
      // input 前缀标记输入阶段，无前缀标记已选但尚未开始输入
      // [约束] 其余三种方式必须保持同样四个字段，否则向导渲染分支失配
      bigmodelApiKey: {
        inputPrimary: string;
        inputSecondary: string;
        primary: string;
        secondary: string;
      };
      bigmodelOauth: {
        pendingPrimary: string;
        pendingSecondary: string;
        primary: string;
        secondary: string;
      };
      zaiApiKey: {
        inputPrimary: string;
        inputSecondary: string;
        primary: string;
        secondary: string;
      };
      zaiOauth: {
        pendingPrimary: string;
        pendingSecondary: string;
        primary: string;
        secondary: string;
      };
    };
    pending: {
      cancelStatus: string;
      help: string;
      status: string;
    };
    input: {
      cancelStatus: string;
      clearStatus: string;
      emptyStatus: string;
      help: string;
      placeholder: string;
      status: string;
      submitStatus: string;
    };
    prompt: string;
    response: string;
    title: string;
  };
  // 模型请求生命周期文案：失败、成功、成功含 token、重试、流中断
  // retryScheduled 收拢 attempt 与 delay 与 maxAttempts 与 reason 四个结构化参数
  // [设计] 参数用对象而非位置参数，避免调用点顺序错乱且便于后续扩展
  // [失败路径] reason 未本地化时会把上游英文原因直接带给用户
  model: {
    requestFailed(message: string): string;
    responseReceived: string;
    responseReceivedWithTokens(tokens: string): string;
    retryScheduled(input: {
      attempt: number;
      delay: string;
      maxAttempts: number;
      reason: string;
    }): string;
    streamStalled: string;
  };
  // 侧栏面板文案总入口，每个子分组对应一个独立面板视图
  // 分组名与面板语义一一对应，禁止为复用文案而跨面板引用
  // [约束] 面板标题统一走 sections 下的短名，避免标题与面板内文案不一致
  sidebar: {
    subagents: {
      title: string;
      empty: string;
      emptyOutput: string;
      back: string;
      readonly: string;
      loading: string;
      unavailable: string;
      retry: string;
      more: string;
      pendingMain: string;
      ended(count: number): string;
      // 子代理状态集合用 Record 锁死，键必须与状态机取值完全一致
      // [失败路径] 状态机新增取值而此处未更新，渲染层取到 undefined 后显示空白
      // [权衡] 用 Record 而非逐字段声明，可在编译期强制穷尽全部状态
      status: Record<
        // 七个状态互斥，lost 表示失联且不可恢复，与 cancelled 的语义边界不可混用
        // 新增状态时先改状态机再改此联合，两侧顺序不同步不影响类型但极易漏改
        "running" | "waiting" | "blocked" | "success" | "failed" | "cancelled" | "lost",
        string
      >;
    };
    api: {
      empty: string;
      model: string;
      more(count: number): string;
      requests: string;
      server: string;
    };
    cache: {
      hit: string;
      lastHit: string;
      lastMiss: string;
      // 缓存读写量合并展示，两个值已由调用方格式化为带单位的字符串
      // [约束] 类型层只收 string，若传入原始数字会丢失单位信息
      // [失败路径] 任一值为空时渲染层仍会拼接，需保证调用方传入占位符
      readWrite(input: { read: string; write: string }): string;
      total: string;
    };
    context: {
      cache: string;
      cacheReadWrite: string;
      inputOutput: string;
      reason: string;
      tokens: string;
      used: string;
      window: string;
    };
    modifiedFiles: {
      empty: string;
      more(count: number): string;
    };
    mcp: {
      empty: string;
      loadFailed: string;
      loading: string;
      more(count: number): string;
      servers: string;
      status: {
        connected: string;
        connecting: string;
        disabled: string;
        disconnected: string;
        failed: string;
        untrusted: string;
      };
      // MCP 连接概览，connected 恒不大于 total，该不变量由调用方保证
      // [约束] 分母为 0 时不应调用本键，无服务器状态应走 empty
      // 数量口径为服务器数而非工具数，与 tools 键的计数语义不同
      summary(input: { connected: number; total: number }): string;
      tools(count: number): string;
    };
    request: {
      complete: string;
      error: string;
      errorWithStatus(statusCode: number): string;
      pending: string;
    };
    status: {
      last: string;
    };
    // 当前运行态概览行：草稿、消息、模式、模型、供应商、思考、轨迹、轮次、工作区
    // [设计] 全部为短标签，渲染层负责分隔符与数值拼接，类型层不预设标点
    // draft 拆成三键是为了区分有内容、有字符数、为空三种展示形态
    run: {
      draft: string;
      draftChars(count: number): string;
      draftEmpty: string;
      messages: string;
      mode: string;
      model: string;
      provider: string;
      thought: string;
      trace: string;
      turn: string;
      workspace: string;
    };
    // 侧栏分区标题集合，键名与面板分组一一对应
    // [约束] 这里是唯一允许存放分区短标题的位置，禁止在面板内重复定义
    // 新增分区必须同时在本分组与对应面板分组下加键，否则标题缺文案
    sections: {
      apis: string;
      context: string;
      mcp: string;
      modifiedFiles: string;
      run: string;
      status: string;
      todos: string;
    };
    shellSubtitle: string;
    title: string;
    todos: {
      empty: string;
      more(count: number): string;
      progress: string;
    };
  };
  status: {
    compactFailed: string;
    compacted: string;
    compacting: string;
    interruptedStreamDiscarded: string;
    modelCalling: string;
    // 权限状态行，toolName 来自工具注册表，属外部值必须以参数传入
    // [约束] 权限相关键覆盖请求、已决、运行、完成、失败五种状态，缺一态则渲染断档
    // [失败路径] 直接用工具名拼接键名会引入未定义键，取值恒为 undefined
    permissionRequested(toolName: string): string;
    permissionResolved(toolName: string): string;
    ready: string;
    recoveringStream: string;
    retryingStream: string;
    sessionResumed: string;
    targetChanged(action: string): string;
    thinking: string;
    toolCompleted(toolName: string): string;
    toolFailed(toolName: string): string;
    toolPending(toolName: string): string;
    toolRunning(toolName: string): string;
    turnFailed: string;
  };
  terminal: {
    requiresInteractive: string;
    starting: string;
  };
  transcript: {
    compact: {
      completed: string;
      failed: string;
      interrupted: string;
      retry(command: string): string;
      retrying(input: { attempt: number; maxAttempts: number }): string;
      skipped: string;
      started: string;
    };
    roles: {
      agent: string;
      system: string;
      user: string;
    };
    thought: {
      complete: string;
      thinking: string;
    };
    title: string;
    workflow: {
      actors: string;
      actorRow(input: { name: string; status: string }): string;
      usage(input: { spentTokens: number }): string;
      collapsed(input: {
        label: string;
        status: string;
        nodesSettled: number;
        nodesTotal: number;
      }): string;
      error(message: string): string;
      expandHint: string;
      collapseHint: string;
      log: string;
      nodes(input: { nodesSettled: number; nodesTotal: number }): string;
      result(preview: string): string;
      status: {
        completed: string;
        errored: string;
        pending: string;
        running: string;
        stopped: string;
      };
      /** `stopped` 的原因词。 */
      // 工作中断原因词，user 与 model 与 provider 与 interrupted 与 superseded 五类互斥
      // [约束] 新增中断原因必须先加词再加状态机分支，否则展示为未知原因
      // 原因词为纯名词，渲染层自行拼接前缀，不在词内写完整句子
      stopReason: {
        user: string;
        model: string;
        provider: string;
        interrupted: string;
        superseded: string;
      };
      truncated: string;
      interruptedNotice(input: { label: string; runId: string }): string;
    };
  };
  // 通用列表选择器的文案骨架，filterLine 同时承载筛选词与帮助尾巴
  // [设计] help 在 filterLine 内可缺省，缺省时只渲染筛选词，避免空括号
  // [失败路径] 无匹配项时走 noFilter 而不是空字符串，否则界面没有任何提示
  // defaultHelp 与 disabled 分离，禁用态必须说明原因而非仅做灰显
  selection: {
    defaultHelp: string;
    disabled(reason: string): string;
    filterLine(input: { filter: string; help?: string }): string;
    noFilter: string;
  };
  // 文件提及弹层的空态、加载态、行模板与标题
  // [约束] row 同时接收路径与选中标记，选中态样式由渲染层决定
  // [失败路径] 加载中误用 empty 会让用户以为没有匹配文件
  fileMention: {
    empty: string;
    loading: string;
    row(input: { path: string; selected: boolean }): string;
    title: string;
  };
  // 斜杠命令弹层，row 需要名称、选中标记与摘要三段信息
  // [约束] summary 由命令注册表提供，属外部值，类型层不校验内容
  // [设计] 只保留标题与行模板，排序与过滤交给调用方，类型层不承载策略
  slash: {
    title: string;
    row(input: { name: string; selected: boolean; summary: string }): string;
  };
}
