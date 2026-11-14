import fs from 'node:fs';

const specs = [
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts',
    target: 37,
    header: [
      '// INV-01 脚本正文经 argv 传入：守住位置 base64url 载荷；改错故障 正文落盘污染工作目录。',
      '// INV-02 载荷单项编码整包：守住位置 JSON 序列化；改错故障 特殊字符被 shell 截断。',
      '// INV-03 执行目录只作 cwd：守住位置 spawn 选项；改错故障 相对路径解析到宿主目录。',
      '// INV-04 三路管道全部显式建立：守住位置 stdio 配置；改错故障 子进程写响应时阻塞。',
      '// INV-05 标准错误只留尾部：守住位置 trimStderr；改错故障 长日志撑爆宿主内存。',
      '// INV-06 标准输出按行解析：守住位置 readline 接口；改错故障 多行消息被拆碎。',
      '// INV-07 空行直接跳过：守住位置 trim 判断；改错故障 JSON 解析抛错。',
      '// INV-08 事件消息只观测不阻塞：守住位置 event 分支；改错故障 后续请求被拖住。',
      '// INV-09 请求必须回执：守住位置 writeResponse；改错故障 子进程永久等待。',
      '// INV-10 请求异常转成失败回执：守住位置 catch 分支；改错故障 异常逃逸导致整轮失败。',
      '// INV-11 取消优先于退出码：守住位置 aborted 判断；改错故障 报退出码而非取消原因。',
      '// INV-12 缺少完成消息视为失败：守住位置 completed 判断；改错故障 静默返回未定义值。',
      '// INV-13 完成消息标记失败即抛错：守住位置 ok 判断；改错故障 错误结果被当成功。',
      '// INV-14 非零退出码兜底报错：守住位置 exitCode 判断；改错故障 失败运行返回成功。',
      '// INV-15 标准输入关闭后不再写：守住位置 stdin 判空；改错故障 空指针异常。',
      '// INV-16 监听器在收尾时移除：守住位置 finally 分支；改错故障 重复注册导致泄漏。',
      '// INV-17 未结算则补杀子进程：守住位置 settled 判断；改错故障 异常路径遗留孤儿进程。',
      '// INV-18 协议行非法即整轮失败：守住位置 JSON.parse；改错故障 半截输出被忽略。',
      '//',
      '// 模块职责：把工作流脚本放进独立 Node 子进程执行，并把请求与事件回传给宿主。',
      '// 状态所有权：子进程、完成消息与结算标记均为单次调用的局部状态。',
      '// 阅读顺序：先看载荷与启动，再看逐行分发，最后看收尾与错误映射。',
    ],
    blocks: [
      {
        anchor: 'export interface ScriptWorkflowChildRequest {',
        lines: [
          '信封只含三个字段。',
          '类型决定宿主处理分支。',
          '载荷保持原始形态透传。',
          '标识用于把回执配对回等待方。',
          '宿主不解释载荷内容。',
        ],
      },
      {
        anchor: 'export async function runScriptWorkflowChild(input: {',
        lines: [
          '脚本正文与参数同包编码。',
          '执行目录只影响子进程 cwd。',
          '请求处理必须返回可序列化值。',
          '事件处理不参与控制流。',
          '取消信号在收尾时撤销注册。',
        ],
      },
      {
        anchor: 'async function handleChildLine(',
        lines: [
          '空行不产生任何副作用。',
          '事件消息先于请求分发。',
          '完成消息只记录不立即返回。',
          '请求处理成功写成功回执。',
          '请求处理失败写失败回执。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/bootstrap/src/auth-login.ts',
    target: 38,
    header: [
      '// INV-01 默认超时五分钟：守住位置 DEFAULT_LOGIN_TIMEOUT_MS；改错故障 无响应时长挂不退出。',
      '// INV-02 外部取消与超时合并：守住位置 AbortSignal.any；改错故障 两条取消来源互相覆盖。',
      '// INV-03 服务端过期时间收紧截止：守住位置 取较小值；改错故障 过期后仍在轮询。',
      '// INV-04 每步之后复查取消：守住位置 throwIfAborted；改错故障 迟到的成功仍写入凭据。',
      '// INV-05 无浏览器模式仍可轮询：守住位置 noBrowser 判断；改错故障 无头环境无法登录。',
      '// INV-06 打开浏览器失败不阻断：守住位置 可选回调；改错故障 浏览器异常导致登录失败。',
      '// INV-07 睡眠可被取消打断：守住位置 delay 的 signal；改错故障 退出后仍等待。',
      '// INV-08 访问材料换取同样可取消：守住位置 waitWithAbort；改错故障 网络卡住无法退出。',
      '// INV-09 登录身份按提供方分流：守住位置 providerId 判断；改错故障 跨提供方串用身份。',
      '// INV-10 凭据写入失败单独归因：守住位置 credential_write_failed；改错故障 提示用户重新授权。',
      '// INV-11 配置写入失败单独归因：守住位置 config_update_failed；改错故障 用户误以为登录未成功。',
      '// INV-12 BigModel 入口固定提供方：守住位置 返回值覆盖；改错故障 继承选项里的默认值。',
      '// INV-13 手填密钥先裁剪再校验：守住位置 trim；改错故障 纯空白密钥被接受。',
      '// INV-14 密钥身份由摘要派生：守住位置 createStandaloneAccountIdentityFromSecret；改错故障 同一密钥落到不同槽位。',
      '// INV-15 端点地址不在登录路径硬编码：守住位置 运行时派生；改错故障 私有化环境无法登录。',
      '// INV-16 网络出口沿用用户配置：守住位置 createDefaultHttpClient；改错故障 登录绕过代理。',
      '// INV-17 解析器可由调用方注入：守住位置 resolver 选项；改错故障 测试无法替换端点。',
      '// INV-18 计时器在收尾时清理：守住位置 finally 分支；改错故障 进程被悬挂定时器拖住。',
      '//',
      '// 模块职责：实现 OAuth 轮询登录、BigModel 专用入口与手填密钥三条配置路径。',
      '// 状态所有权：截止时间、计时器与信号均为单次登录调用的局部状态。',
      '// 阅读顺序：先看超时与信号合并，再看轮询与写凭据，最后看两个辅助入口。',
    ],
    blocks: [
      {
        anchor: 'const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;',
        lines: [
          '默认窗口只作起点。',
          '拿到服务端过期时间后必须收紧。',
          '超过窗口的轮询只会得到失败。',
          '调用方可显式覆盖该值。',
        ],
      },
      {
        anchor: 'export async function loginZCodeCli(',
        lines: [
          '三段流程共用一次登录会话。',
          '初始化只负责拿授权地址。',
          '轮询负责等待用户完成授权。',
          '换取材料只使用轮询得到的令牌。',
        ],
      },
      {
        anchor: 'const env = options.env ?? process.env;',
        lines: [
          '依赖全部从选项注入。',
          '缺省值只在入口处集中定义。',
          '时间源可被测试替换。',
          '提供方缺省为 zai。',
        ],
      },
      {
        anchor: 'export async function loginBigmodelCodingPlan(',
        lines: [
          '仅固定提供方标识。',
          '其余参数原样透传。',
          '返回值再次覆盖提供方。',
          '避免调用方误读继承值。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/cli/src/command-center/login-flow.ts',
    target: 36,
    header: [
      '// INV-01 登录入口固定四项：守住位置 items 数组；改错故障 缺少手填密钥入口。',
      '// INV-02 两项 OAuth 与两项密钥成对：守住位置 provider 维度；改错故障 只有一个提供方可登录。',
      '// INV-03 选择器不可过滤：守住位置 filterable 假值；改错故障 用户误用过滤丢掉入口。',
      '// INV-04 文案全部走 i18n：守住位置 getZCodeCopy；改错故障 出现硬编码英文。',
      '// INV-05 密钥输入必须掩码：守住位置 mask 为真；改错故障 密钥明文显示在终端。',
      '// INV-06 每项命令名即分发标识：守住位置 command 字段；改错故障 回车后无法路由。',
      '// INV-07 关键词覆盖提供方与方式：守住位置 keywords 数组；改错故障 搜索命中率下降。',
      '// INV-08 待定态文案四项齐全：守住位置 pending 对象；改错故障 等待时提示缺行。',
      '// INV-09 裸登录只返回引导文案：守住位置 loginSetupResponse；改错故障 无参数调用触发副作用。',
      '// INV-10 账号显示名有回退链：守住位置 name 到 user_id；改错故障 空名字显示空白。',
      '// INV-11 浏览器失败只提示不报错：守住位置 browserNote；改错故障 登录成功却报失败。',
      '// INV-12 结果拼接顺序固定：守住位置 数组顺序；改错故障 关键信息被截断。',
      '// INV-13 手填结果按提供方取名：守住位置 三元判断；改错故障 BigModel 显示成 Z.AI。',
      '// INV-14 授权事件缺少回调即跳过：守住位置 onEvent 判断；改错故障 无头场景抛错。',
      '// INV-15 展示序号不参与顺序保证：守住位置 sequenceNumber 常量；改错故障 调用方误判时序。',
      '// INV-16 事件标识随机生成：守住位置 randomUUID；改错故障 多次推送互相覆盖。',
      '// INV-17 参数首词决定分支：守住位置 kind 判断；改错故障 未知命令被吞进密钥。',
      '// INV-18 密钥允许含空白：守住位置 剩余参数拼接；改错故障 粘贴带空格密钥被截断。',
      '//',
      '// 模块职责：构造 /login 选择器，并格式化登录结果、授权消息与密钥参数。',
      '// 状态所有权：无状态；所有函数均为纯构造或纯格式化。',
      '// 阅读顺序：先看选择器四项，再看结果文案，最后看参数解析。',
    ],
    blocks: [
      {
        anchor: 'export function buildLoginSelection(locale?: string): TuiSelection {',
        lines: [
          '四项入口按提供方与方式排列。',
          'OAuth 项只带待定态。',
          '密钥项额外带掩码输入配置。',
          '文案对象整体来自 i18n。',
          '所选语言只影响展示。',
        ],
      },
      {
        anchor: 'export function formatLoginResult(result: CommandCenterLoginResult): string {',
        lines: [
          '账号名按优先级回退。',
          '浏览器失败追加独立说明。',
          '四行结果顺序固定。',
          '路径直接展示便于排查。',
          '这里不做任何脱敏改写。',
        ],
      },
      {
        anchor: 'export function parseApiKeyLoginArgs(args: string): {',
        lines: [
          '首词必须命中两种已知形式。',
          '未命中返回空交给其他分支。',
          '其余参数整体作为密钥。',
          '提供方由首词前缀推导。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts',
    target: 36,
    header: [
      '// INV-01 判别字段固定为 type：守住位置 两个分支；改错故障 分发时无法收窄类型。',
      '// INV-02 已知命令各自独立成员：守住位置 联合成员；改错故障 参数结构退化成字符串。',
      '// INV-03 命令名是唯一分发依据：守住位置 name 字段；改错故障 分支匹配错命令。',
      '// INV-04 原始名单独保留：守住位置 rawName 字段；改错故障 提示无法回显用户输入。',
      '// INV-05 参数已裁剪：守住位置 args 语义；改错故障 下游需要重复去空白。',
      '// INV-06 空参数允许存在：守住位置 args 类型；改错故障 无参数命令被判非法。',
      '// INV-07 技能分支多两个字段：守住位置 skillName 与 task；改错故障 技能无法定位。',
      '// INV-08 技能任务允许空串：守住位置 task 类型；改错故障 只加载技能的场景失败。',
      '// INV-09 未知分支只保留原始名：守住位置 unknown 成员；改错故障 未知命令丢失输入。',
      '// INV-10 每个成员都带参数与原始名：守住位置 公共字段；改错故障 分支处理时字段缺失。',
      '// INV-11 命令名集合封闭：守住位置 联合成员列表；改错故障 新增命令静默落到未知。',
      '// INV-12 不在此处做解析：守住位置 仅类型声明；改错故障 类型文件引入运行时依赖。',
      '// INV-13 不携带执行结果：守住位置 字段范围；改错故障 分发方依赖不该有的状态。',
      '// INV-14 不区分大小写规范化：守住位置 由解析器产出；改错故障 调用方各自转换不一致。',
      '// INV-15 未知分支不带参数：守住位置 成员字段；改错故障 未知命令被误传参执行。',
      '// INV-16 技能名单独成字段：守住位置 与任务分离；改错故障 名称与正文混在一起。',
      '// INV-17 联合保持扁平：守住位置 单层结构；改错故障 收窄需要多层嵌套判断。',
      '// INV-18 类型即契约：守住位置 导出点；改错故障 各方自建副本导致漂移。',
      '//',
      '// 模块职责：声明 slash 命令解析结果的判别联合，供分发层做穷尽匹配。',
      '// 状态所有权：纯类型，无运行时状态。',
      '// 阅读顺序：先看已知分支字段，再看技能分支，最后看未知分支。',
    ],
    blocks: [
      {
        anchor: 'export type SlashCommand =',
        lines: [
          '两个顶层判别值。',
          '已知分支逐命令展开。',
          '未知分支只带原始名。',
          '分发层按 type 与 name 收窄。',
        ],
      },
      {
        anchor: 'name: "skill";',
        lines: [
          '技能分支携带额外两个字段。',
          '技能名与任务是分离的。',
          '任务为空表示只加载技能。',
          '参数仍完整保留。',
          '其余字段与其他分支一致。',
        ],
      },
      {
        anchor: 'type: "unknown";',
        lines: [
          '未知分支不再展开命令名。',
          '原始名是唯一可用线索。',
          '交由自定义命令查找处理。',
          '不携带参数避免误执行。',
          '提示文案由上游决定。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b162-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
