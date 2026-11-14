// officeSuggestedPrompts —— 官方办公、开发、金融推荐语料的唯一数据源
// 职责边界：
//   一是只提供静态推荐语料与一个纯重排函数，不取数、不持久化、不发请求
//   二是每条语料由 id、category、iconUrl、双语 label、双语 prompt、插件归属组成
//   三是排序函数只重排不裁剪，返回池长度恒等于可入选条目数
//   四是文末默认语料不依赖插件，单独成池，不与官方语料合并
// 下列断言均由真实语料与筛选分支推导，改动前逐条核对：
// INV-01 断言：id 从 official-0 连续到 official-16 且互不重复 —— 守住它的位置：每个元素的 id 字段 —— 改错故障：列表 key 冲突，推荐卡片渲染错位或状态复用错乱
// INV-02 断言：category 只出现 development、office、finance、utility 四种取值 —— 守住它的位置：RecommendedPrompt 联合类型与每个元素的 category —— 改错故障：首选集合为空，排序静默退化为原序
// INV-03 断言：四类数量为 development 六条、office 六条、finance 三条、utility 两条 —— 守住它的位置：officeSuggestedPrompts 元素顺序 —— 改错故障：非办公模式首屏推荐条数与设计稿不符
// INV-04 断言：金融语料仅在身份等于 finance 时可入选 —— 守住它的位置：eligible 的过滤条件 —— 改错故障：普通用户看到企业尽调与现金流预测，产生越权感知
// INV-05 断言：首选分类的判定顺序是先金融、再办公、最后开发 —— 守住它的位置：preferred 的三元表达式 —— 改错故障：金融身份在办公模式下被判成办公，专属语料沉底
// INV-06 断言：首选分类整体前置，其余分类保持原有相对顺序 —— 守住它的位置：两次 filter 拼接 —— 改错故障：换成 sort 后稳定序丢失，语料顺序在浏览器间漂移
// INV-07 断言：返回池长度恒等于可入选条目数，不得截断 —— 守住它的位置：函数末尾的数组展开 —— 改错故障：加 slice 后调用方拿到空池，兜底语料被误当成官方推荐
// INV-08 断言：不得就地修改模块级语料常量 —— 守住它的位置：filter 产生新数组这一事实 —— 改错故障：原地排序污染常量，热更新后顺序持续错乱
// INV-09 断言：金融语料对非金融身份仍留在池中，只是排在后面 —— 守住它的位置：分类不等的第二段过滤 —— 改错故障：误把金融语料从非金融池剔除，身份切换后语料消失
// INV-10 断言：每条语料的中文标签与中文提示词必须逐字一致 —— 守住它的位置：同一元素内的 label.cn 与 prompt.cn —— 改错故障：卡片展示与实际发送不一致，用户点出意外指令
// INV-11 断言：每条语料的英文标签与英文提示词同样逐字一致 —— 守住它的位置：同一元素内的 label.en 与 prompt.en —— 改错故障：英文文案漂移，弯引号被改成直引号导致审校失败
// INV-12 断言：官方语料的图标地址全部是 https 绝对地址 —— 守住它的位置：每个元素的 iconUrl —— 改错故障：相对路径在 Web 端解析失败，卡片裂图
// INV-13 断言：插件稳定标识统一以 @zcode-plugins-official 结尾 —— 守住它的位置：每个元素的 plugin.stableId —— 改错故障：插件跳转解析不到，推荐项点击无响应
// INV-14 断言：默认语料元素不含 category 与 plugin 字段 —— 守住它的位置：文末常量的类型标注 —— 改错故障：误套推荐语料类型，渲染分支拿不到插件信息而异常
// INV-15 断言：身份为空与任意非 finance 字符串在筛选上等价 —— 守住它的位置：身份与 finance 的相等判断 —— 改错故障：改成真值判断后空字符串身份被当成金融用户
// 以上十五条互相独立，任一条被改都会单独触发对应故障，不要合并断言
import finderIcon from "@/onboarding/assets/finder.png";
import terminalIcon from "@/onboarding/assets/terminal.png";
import feishuIcon from "@/onboarding/assets/feishu.png";
// [契约] 本文件只消费 DraftSuggestedPromptItem 的字段形状，不复制它的运行期校验
// 看起来该改：把类型来源换成本文件自己的局部类型
// 其实不能改：调用方按 DraftSuggestedPromptItem 消费返回值，改窄后赋值方向断裂
// 边界：新增字段先加到 draftSuggestedPromptItems，本文件只跟随，不反向声明
// 迁移成本：类型下沉到本文件会让推荐语料与草稿会话模型重新耦合
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

// [契约] 该交叉类型是语料表与通用草稿项之间的窄化桥，多出的只有 category
// 看起来该改：把 category 提为必填放进 DraftSuggestedPromptItem
// 其实不能改：通用草稿项来自会话链路，不应知道推荐分类这种展示概念
// 边界：需要新分类时扩这里的联合，不要改成 string，否则筛选分支失去穷尽性
type RecommendedPrompt = DraftSuggestedPromptItem & {
  category: "development" | "office" | "finance" | "utility";
};

// [资源] 模块级常量在导入时一次性构造，十七条语料常驻内存，禁止在渲染期重建
// 看起来该改：改成分页或懒加载以减小首包
// 其实不能改：推荐位需要在首屏同步可点，异步补数会先闪空骨架再跳变
export const officeSuggestedPrompts: RecommendedPrompt[] = [
  {
    // [契约] official-0 到 official-5 是开发类，插件全部指向官方仓库工具
    // 看起来该改：按插件商店上架状态动态过滤
    // 其实不能改：语料是离线常量，动态化会让首屏推荐依赖网络结果
    id: "official-0",
    category: "development",
    // [资源] 开发类图标全部来自同一 CDN 前缀，路径按插件名分目录
    // 看起来该改：把前缀抽成常量拼接，减少重复
    // 其实不能改：抽常量后单条图标无法单独替换，回滚一张图要改代码
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/github/icon.png",
    label: {
      cn: "帮我看看这个仓库最近的改动，有哪些值得关注",
      en: "Review recent changes in this repository and highlight what matters.",
    },
    prompt: {
      cn: "帮我看看这个仓库最近的改动，有哪些值得关注",
      en: "Review recent changes in this repository and highlight what matters.",
    },
    plugin: {
      stableId: "github@zcode-plugins-official",
      label: {
        cn: "GitHub",
        en: "github",
      },
    },
  },
  {
    // [权衡] 同一分类内按维护者认可度排序，GitLab 紧随 GitHub
    // 调整顺序等于调整产品曝光，不是纯粹的美化，改动需产品确认
    id: "official-1",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/gitlab/icon.png",
    label: {
      cn: "帮我检查当前分支的改动，找出提交 MR 前需要修复的问题",
      en: "Review this branch and find issues to fix before submitting a merge request.",
    },
    prompt: {
      cn: "帮我检查当前分支的改动，找出提交 MR 前需要修复的问题",
      en: "Review this branch and find issues to fix before submitting a merge request.",
    },
    plugin: {
      stableId: "gitlab@zcode-plugins-official",
      label: {
        cn: "GitLab",
        en: "gitlab",
      },
    },
  },
  {
    // [契约] 安全扫描语料固定指向 mimosa 插件，文案承诺只做扫描与修复建议
    // 看起来该改：把文案扩成包含自动修复，以显得更强
    // 其实不能改：插件实际能力边界是扫描加建议，越界承诺会制造失败预期
    id: "official-2",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/mimosa/icon.png",
    label: {
      cn: "帮我扫描这个项目的安全隐患，优先修复高风险问题",
      en: "Scan this project for security issues and prioritize high-risk fixes.",
    },
    prompt: {
      cn: "帮我扫描这个项目的安全隐患，优先修复高风险问题",
      en: "Scan this project for security issues and prioritize high-risk fixes.",
    },
    plugin: {
      stableId: "mimosa@zcode-plugins-official",
      label: {
        cn: "代码安全防护",
        en: "mimosa",
      },
    },
  },
  {
    // [资源] CloudBase 语料依赖云端环境，图标走 docs.cloudbase.net 域名
    // 该域名与其他 CDN 不同源，替换成统一 CDN 前先确认可访问性
    id: "official-3",
    category: "development",
    iconUrl: "https://docs.cloudbase.net/en/img/favicon.png",
    label: {
      cn: "帮我做一个带登录和数据存储的待办小程序",
      en: "Build a to-do mini program with sign-in and data storage.",
    },
    prompt: {
      cn: "帮我做一个带登录和数据存储的待办小程序",
      en: "Build a to-do mini program with sign-in and data storage.",
    },
    plugin: {
      stableId: "cloudbase-skills@zcode-plugins-official",
      label: {
        cn: "CloudBase",
        en: "cloudbase-skills",
      },
    },
  },
  {
    // [失败路径] 录屏还原语料要求用户自备视频，缺失素材时插件会直接报错
    // 看起来该改：加一句兜底提示，其实不能改，文案已由插件侧对齐
    id: "official-4",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/video2code/icon.png",
    label: {
      cn: "把我提供的网页录屏还原成一个可交互的页面",
      en: "Recreate my website recording as an interactive page.",
    },
    prompt: {
      cn: "把我提供的网页录屏还原成一个可交互的页面",
      en: "Recreate my website recording as an interactive page.",
    },
    plugin: {
      stableId: "video2code@zcode-plugins-official",
      label: {
        cn: "Video2Code",
        en: "video2code",
      },
    },
  },
  {
    // [并发] 浏览器操作类语料会驱动真实浏览器，同一会话内不可并发执行
    // 推荐位只负责投递指令，串行约束由运行时负责，不在此处加锁
    id: "official-5",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/browser-use/icon.png",
    label: {
      cn: "帮我检查本地网页，找出布局和交互上的问题",
      en: "Check my local website for layout and interaction issues.",
    },
    prompt: {
      cn: "帮我检查本地网页，找出布局和交互上的问题",
      en: "Check my local website for layout and interaction issues.",
    },
    plugin: {
      stableId: "browser-use@zcode-plugins-official",
      label: {
        cn: "浏览器操作",
        en: "browser-use",
      },
    },
  },
  {
    // [契约] official-6 到 official-11 是办公类，覆盖飞书、腾讯会议、企业微信、文档、表格、视频
    // 看起来该改：把办公类语料挪到开发类前面，让办公模式优先命中
    // 其实不能改：前置由筛选函数按身份重排，语料表内的物理顺序是稳定序基准
    id: "official-6",
    // [契约] 办公类语料统一排在开发类之后，靠分类前置完成首屏命中
    // 看起来该改：直接把办公类元素整体上移
    // 其实不能改：物理上移会改变非办公模式下的组内相对顺序，影响稳定序
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/lark-cli/icon.png",
    label: {
      cn: "帮我整理昨天的飞书工作记录，列出今天需要跟进的事项",
      en: "Review yesterday’s Lark work records and list today’s follow-ups.",
    },
    prompt: {
      cn: "帮我整理昨天的飞书工作记录，列出今天需要跟进的事项",
      en: "Review yesterday’s Lark work records and list today’s follow-ups.",
    },
    plugin: {
      // [权衡] 飞书语料用 CLI 插件而非文档插件，因为要读工作记录而非编辑文档
      // 看起来该改：换成文档插件以复用已有能力
      // 其实不能改：读聊天与日程需要 CLI 作用域，文档插件没有这些权限
      stableId: "lark-cli@zcode-plugins-official",
      label: {
        cn: "飞书 CLI",
        en: "lark-cli",
      },
    },
  },
  {
    // [权衡] 腾讯会议语料只取最近一次会议，不提供跨会议汇总
    // 跨会议汇总需要额外权限，语料刻意收敛在单次会议范围内
    id: "official-7",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/tencent-meeting-cli/icon.png",
    label: {
      cn: "帮我整理最近一次会议的参会情况，生成一份简报",
      en: "Summarize attendance at my most recent Tencent Meeting.",
    },
    prompt: {
      cn: "帮我整理最近一次会议的参会情况，生成一份简报",
      en: "Summarize attendance at my most recent Tencent Meeting.",
    },
    plugin: {
      stableId: "tencent-meeting-cli@zcode-plugins-official",
      label: {
        cn: "腾讯会议 CLI",
        en: "tencent-meeting-cli",
      },
    },
  },
  {
    // [资源] 企业微信语料的日程与待办来自同一插件，避免跨插件拼接
    // 拆成两条语料会让同一份日程被请求两次，浪费配额
    id: "official-8",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/wecom-cli/icon.png",
    label: {
      cn: "帮我查看今天的日程和待办，安排一下工作顺序",
      en: "Review today’s WeCom calendar and to-dos and organize my work.",
    },
    prompt: {
      cn: "帮我查看今天的日程和待办，安排一下工作顺序",
      en: "Review today’s WeCom calendar and to-dos and organize my work.",
    },
    plugin: {
      stableId: "wecom-cli@zcode-plugins-official",
      label: {
        cn: "企业微信 CLI",
        en: "wecom-cli",
      },
    },
  },
  {
    // [契约] Word 文档语料与 Excel 语料共用 document-skills 图标，但插件标识不同
    // 看起来该改：合并成同一插件以减少条目
    // 其实不能改：documents 与 spreadsheets 是两个独立插件，合并后跳转指向错误能力
    id: "official-9",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/document-skills/icon.png",
    label: {
      cn: "把我的笔记整理成一份排版清晰的 Word 文档",
      en: "Turn my notes into a clearly formatted Word document.",
    },
    prompt: {
      cn: "把我的笔记整理成一份排版清晰的 Word 文档",
      en: "Turn my notes into a clearly formatted Word document.",
    },
    plugin: {
      stableId: "documents@zcode-plugins-official",
      label: {
        cn: "Word文档",
        en: "documents",
      },
    },
  },
  {
    // [契约] Excel 语料承诺趋势分析与图表生成，两者都在电子表格插件能力内
    // 看起来该改：把图表描述改成可视化报表，听起来更完整
    // 其实不能改：文案已与插件实际能力逐字对齐，改写会破坏一致性
    id: "official-10",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/document-skills/icon.png",
    label: {
      cn: "分析这份 Excel，找出关键趋势并生成图表",
      en: "Analyze this Excel file, identify key trends and create charts.",
    },
    prompt: {
      cn: "分析这份 Excel，找出关键趋势并生成图表",
      en: "Analyze this Excel file, identify key trends and create charts.",
    },
    plugin: {
      stableId: "spreadsheets@zcode-plugins-official",
      label: {
        cn: "电子表格",
        en: "spreadsheets",
      },
    },
  },
  {
    // [失败路径] 长视频剪辑语料默认输入是一段长视频，超长素材会触发插件超时
    // 超时由插件侧兜底，语料不承诺时长上限，避免写死后无法调整
    id: "official-11",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/video-agent/icon.png",
    label: {
      cn: "帮我把这段长视频剪成一分钟精华版，加上字幕",
      en: "Edit this long video into a one-minute highlight reel with subtitles.",
    },
    prompt: {
      cn: "帮我把这段长视频剪成一分钟精华版，加上字幕",
      en: "Edit this long video into a one-minute highlight reel with subtitles.",
    },
    plugin: {
      stableId: "video-agent-kit@zcode-plugins-official",
      label: {
        cn: "Video Agent Kit",
        en: "video-agent-kit",
      },
    },
  },
  {
    // [事务] official-12 到 official-14 是金融类，整组只在金融身份下出现
    // 看起来该改：拆成单条按需放行，让普通用户也能看到尽调
    // 其实不能改：金融语料涉及付费数据源，越权展示等于承诺未授权能力
    id: "official-12",
    // [失败路径] 金融分类的过滤只在 eligible 处生效，排序阶段不再判断身份
    // 看起来该改：在排序里再加一次身份判断做双保险
    // 其实不能改：重复判断会把金融语料从池中彻底移除，身份切换后无法恢复
    category: "finance",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/corporate-due-diligence/icon.png",
    label: {
      cn: "帮我对这家公司做一份尽调，重点看看关联关系和经营风险",
      en: "Perform due diligence on this company, focusing on relationships and business risks.",
    },
    prompt: {
      cn: "帮我对这家公司做一份尽调，重点看看关联关系和经营风险",
      en: "Perform due diligence on this company, focusing on relationships and business risks.",
    },
    plugin: {
      stableId: "vet-companies@zcode-plugins-official",
      label: {
        cn: "企业尽调",
        en: "vet-companies",
      },
    },
  },
  {
    // [契约] 现金流预测语料固定十三周口径，与经营分析插件的默认模型一致
    // 看起来该改：把十三周改成可配置区间
    // 其实不能改：插件模板按十三周建模，改口径会让输出与文案不符
    id: "official-13",
    category: "finance",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/business-analysis/icon.png",
    label: {
      cn: "根据这份收支数据，做一份未来 13 周的现金流预测",
      en: "Use this income and expense data to forecast cash flow for the next 13 weeks.",
    },
    prompt: {
      cn: "根据这份收支数据，做一份未来 13 周的现金流预测",
      en: "Use this income and expense data to forecast cash flow for the next 13 weeks.",
    },
    plugin: {
      stableId: "run-fpa@zcode-plugins-official",
      label: {
        cn: "经营分析",
        en: "run-fpa",
      },
    },
  },
  {
    // [资源] 持仓跟踪语料依赖用户自选股列表，空列表时插件返回空结果
    // 语料不写兜底分支，是因为空结果在插件侧已有明确提示
    // 边界：持仓数据只在插件会话内读取，推荐位不感知任何账户信息
    id: "official-14",
    category: "finance",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/portfolio-tracking/icon.png",
    label: {
      cn: "帮我整理自选股今天的表现，以及值得关注的公告",
      en: "Summarize today’s watchlist performance and notable announcements.",
    },
    prompt: {
      cn: "帮我整理自选股今天的表现，以及值得关注的公告",
      en: "Summarize today’s watchlist performance and notable announcements.",
    },
    plugin: {
      stableId: "watch-positions@zcode-plugins-official",
      label: {
        cn: "持仓跟踪",
        en: "watch-positions",
      },
    },
  },
  {
    // [权衡] official-15 与 official-16 归入 utility，既可复用也与业务无关
    // 归类为工具而非开发，是为了让它们在任意模式下都排在业务语料之后
    id: "official-15",
    category: "utility",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/skill-creator/icon.png",
    label: {
      cn: "把我经常重复的工作流程做成一个可复用的技能",
      en: "Turn my recurring workflow into a reusable skill.",
    },
    prompt: {
      cn: "把我经常重复的工作流程做成一个可复用的技能",
      en: "Turn my recurring workflow into a reusable skill.",
    },
    plugin: {
      stableId: "skill-creator@zcode-plugins-official",
      label: {
        cn: "技能创建器",
        en: "skill-creator",
      },
    },
  },
  {
    // [契约] ZCode 配置检查语料指向使用指南插件，不直接读写本地配置文件
    // 看起来该改：让语料直接执行配置修改
    // 其实不能改：配置写入属于应用设置链路，推荐位只做只读诊断
    id: "official-16",
    category: "utility",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-guide/icon.png",
    label: {
      cn: "帮我检查当前的 ZCode 配置，看看有哪些可以调整",
      en: "Review my ZCode configuration and suggest useful adjustments.",
    },
    prompt: {
      cn: "帮我检查当前的 ZCode 配置，看看有哪些可以调整",
      en: "Review my ZCode configuration and suggest useful adjustments.",
    },
    plugin: {
      stableId: "zcode-guide@zcode-plugins-official",
      label: {
        cn: "ZCode 使用指南",
        en: "zcode-guide",
      },
    },
  },
];

// [契约] 该函数是唯一出口，输入身份与模式，输出稳定排序后的候选池
// 看起来该改：把入参收成一个配置对象，方便以后扩展
// 其实不能改：调用方都已按两个位置参数接线，改签名需要同步所有调用点
// 边界：入参只影响顺序与可见性，绝不参与语料内容生成
// 失败路径：身份传入未知字符串时按非金融处理，不抛错
export function getRecommendedPromptPool(
  isOfficeMode: boolean,
  occupation?: string | null,
): DraftSuggestedPromptItem[] {
  // [权衡] 首选分类的优先级是金融高于办公、办公高于开发
  // 看起来该改：让 isOfficeMode 优先于身份，语义更直观
  // 其实不能改：金融身份通常同时处于办公场景，先判金融才能命中专属语料
  // 改错故障：顺序反转后金融用户在办公模式下永远看不到尽调与预测
  const preferred = occupation === "finance" ? "finance" : isOfficeMode ? "office" : "development";
  // [契约] eligible 是唯一一次可见性收敛，之后只做排序不再增删
  // 看起来该改：把过滤条件也搬进筛选函数的返回表达式里内联
  // 其实不能改：可见性与排序混在一条表达式后，两段过滤容易漏掉同一条件
  // 守卫：金融条件的例外只作用于金融语料，其他分类不得跟随身份变化
  const eligible = officeSuggestedPrompts.filter(
    (item) => item.category !== "finance" || occupation === "finance",
  );
  // [并发] 该函数是纯函数，无共享可变状态，可被多个渲染入口同时调用
  // 看起来该改：在外面缓存一次结果，避免重复过滤
  // 其实不能改：缓存键要同时包含模式与身份，缓存错了会把金融池漏给普通用户
  // 边界：返回新数组，调用方自行排序不会回写模块常量
  return [
    // [契约] 第一段取首选分类，第二段取其余分类，拼接即完整池
    // 看起来该改：合并成一次排序比较器
    // 其实不能改：比较器无法同时保证首选前置与组内原序，等价于丢掉稳定序
    ...eligible.filter((item) => item.category === preferred),
    ...eligible.filter((item) => item.category !== preferred),
  ];
}

// [资源] 默认语料是官方语料不可用时的兜底，图标走本地打包资源
// 看起来该改：把默认语料并入官方语料表统一维护
// 其实不能改：两者字段形状不同，默认语料没有分类与插件，合并会污染筛选类型
// 边界：默认语料只在无插件场景使用，不与推荐池拼接
// 失败路径：本地图标缺失时构建期即失败，不会静默降级为远程地址
export const defaultSuggestedPrompts: DraftSuggestedPromptItem[] = [
  {
    // [契约] office-organize 用访达图标，语义是查看磁盘占用
    // 看起来该改：换成通用文件夹图标更中性
    // 其实不能改：图标是三条默认语料唯一的视觉区分，换掉后三张卡片无法快速辨认
    id: "office-organize",
    iconUrl: finderIcon,
    label: {
      cn: "帮我看看我现在电脑上什么文件占用了主要空间？",
      en: "Help me see which files are taking up the most space on my computer.",
    },
    prompt: {
      cn: "帮我看看我现在电脑上什么文件占用了主要空间？",
      en: "Help me see which files are taking up the most space on my computer.",
    },
  },
  {
    // [契约] office-clean 文案点名 Mole CLI，指令里必须保留命令名
    // 看起来该改：把工具名隐去，让文案更通用
    // 其实不能改：默认语料无插件归属，agent 只能靠文案里的命令名选中工具
    id: "office-clean",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我使用 Mole CLI 清理下电脑的冗余文件",
      en: "Use Mole CLI to clean redundant files on my computer.",
    },
    prompt: {
      cn: "帮我使用 Mole CLI 清理下电脑的冗余文件",
      en: "Use Mole CLI to clean redundant files on my computer.",
    },
  },
  {
    // [契约] office-review 的飞书图标与官方飞书 CLI 语料同源，但走本地资源
    // 看起来该改：复用语料表里的飞书 CDN 地址
    // 其实不能改：默认语料要在离线与内网可用，远程图标会在这里断链
    id: "office-review",
    iconUrl: feishuIcon,
    label: {
      cn: "帮我用飞书 CLI 获取下我昨天的工作情况，梳理今日工作待办",
      en: "Use Feishu CLI to review my work from yesterday and organize today’s to-dos.",
    },
    prompt: {
      cn: "帮我用飞书 CLI 获取下我昨天的工作情况，梳理今日工作待办",
      en: "Use Feishu CLI to review my work from yesterday and organize today’s to-dos.",
    },
  },
// [权衡] 默认语料固定三条，覆盖查看、清理、回顾三种高频动作
// 增删条目会改变兜底位的密度，三条是产品确认过的下限
];
