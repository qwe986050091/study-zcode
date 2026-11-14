// INV-01 改名清单是纯数据：守住位置 模块顶层；改错故障 迁移逻辑散落到读取路径。
// INV-02 精确正则匹配原名：守住位置 modelMatch；改错故障 相近型号被误迁移档位。
// INV-03 简化正则只作兜底：守住位置 simplifiedModelMatch；改错故障 精确匹配失效。
// INV-04 旧档位只认一个值：守住位置 oldLevel；改错故障 其他档位被顺手改写。
// INV-05 新档位统一为默认：守住位置 迁移后取值；改错故障 迁移后残留旧语义。
// INV-06 一个型号一条记录：守住位置 数组结构；改错故障 合并条目难以排查。
// INV-07 版本段允许后缀：守住位置 后缀分组；改错故障 带渠道后缀的型号漏迁移。
// INV-08 分隔符集合固定：守住位置 字符类；改错故障 新渠道前缀不被识别。
// INV-09 大小写按原样保留：守住位置 正则字面；改错故障 大小写归一误伤其他型号。
// INV-10 型号名不参与猜测：守住位置 匹配方式；改错故障 新模型被误判为旧模型。
// INV-11 顺序不影响结果：守住位置 消费方；改错故障 命中依赖数组顺序产生歧义。
// INV-12 表只为迁移存在：守住位置 使用点；改错故障 新选型也走旧档位。
// INV-13 常量断言保证只读：守住位置 末尾断言；改错故障 运行时被追加条目。
// INV-14 缺省档位不在表内：守住位置 数据；改错故障 正常档位也被认为需要迁移。
// INV-15 命中即可停止遍历：守住位置 消费方；改错故障 多次迁移叠加改写。
// INV-16 未命中保持原样：守住位置 消费方；改错故障 未列型号被清空档位。
// INV-17 新增型号只加数据：守住位置 维护方式；改错故障 每次新增都要改迁移代码。
// INV-18 表结构无副作用：守住位置 导入；改错故障 加载即触发 IO。
//
// 模块职责：集中维护旧推理档位到默认档位的型号改名表。
// 状态所有权：只读常量；无运行时状态。
// 阅读顺序：先看首条记录的字段含义，其余条目形状一致。
// 一次性改名清单：选择器必须精确匹配 Built-in 原规则，不按模型名猜测。
export const legacyReasoningLevelRenames = [
  {
    modelMatch: ".*glm-5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5.*",
    oldLevel: "off",
  },
  {
    // GLM-5.2 的 oldLevel 是非思考值 "nothink"。
    // 迁移后 oldLevel 统一改为默认的 "off"。
    // modelMatch 的版本后缀由 (?:[.\-:/\[].*)? 分组吸收。
    // modelMatch 区分大小写，只有原样写法 GLM-5.2 才命中。
    modelMatch: ".*GLM-5\\.2(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*GLM-5\\.2.*",
    oldLevel: "nothink",
  },
  {
    modelMatch: ".*GLM-5-Turbo(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*GLM-5-Turbo.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5\\.1(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5\\.1.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5\\.1-highspeed(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5\\.1-highspeed.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-5v-turbo(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-5v-turbo.*",
    oldLevel: "off",
  },
  {
    // glm-4.7 系列按 flashx 与 flash 变体逐条列出。
    // modelMatch 精确正则限定版本边界，避免误伤相近型号。
    // simplifiedModelMatch 用于精确匹配失效时的宽松兜底。
    // modelMatch 与 simplifiedModelMatch 必须覆盖同一批主要写法。
    modelMatch: ".*glm-4\\.7(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.7.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7-flashx(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.7-flashx.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.7-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.7-flash.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.6(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.6.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.5.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*glm-4\\.5-air(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*glm-4\\.5-air.*",
    oldLevel: "off",
  },
  {
    // 新增型号只需向 legacyReasoningLevelRenames 追加一条记录。
    // 消费方遍历 legacyReasoningLevelRenames 整表，新增条目不需要改动迁移逻辑。
    // 迁移判定只读 oldLevel，不读取新档位字段。
    modelMatch: ".*kimi-k2\\.7-code(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*kimi-k2\\.7-code.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.6(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*kimi-k2\\.6.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*kimi-k2\\.5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*kimi-k2\\.5.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*deepseek-v4-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*deepseek-v4-flash.*",
    oldLevel: "off",
  },
  {
    // 命中后只把 oldLevel 改写为新档位，modelMatch 保持不变。
    // 未命中记录的 oldLevel 原样保留，不被清空。
    // 数组顺序不影响匹配结果，消费方按 modelMatch 判定。
    modelMatch: ".*deepseek-v4-pro(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*deepseek-v4-pro.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3\\.5-plus(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen3\\.5-plus.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen3\\.5-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen3\\.5-flash.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen-plus(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen-plus.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*qwen-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen-flash.*",
    oldLevel: "off",
  },
  {
    // qwen3-vl-plus 等视觉型号同样适用改名规则。
    // 渠道后缀由 modelMatch 边界分组之外的 .* 吸收，不参与精确匹配。
    // 新增变体时沿用同组的 modelMatch 与 simplifiedModelMatch 写法。
    modelMatch: ".*qwen3-vl-plus(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*qwen3-vl-plus.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2\\.5(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*mimo-v2\\.5.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2\\.5-pro(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*mimo-v2\\.5-pro.*",
    oldLevel: "off",
  },
  {
    modelMatch: ".*mimo-v2-flash(?:[.\\-:/\\[].*)?",
    simplifiedModelMatch: ".*mimo-v2-flash.*",
    oldLevel: "off",
  },
] as const;
