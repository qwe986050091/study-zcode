import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const off = 0;
const items = [];
const add = (line, lines) => items.push({ line: line + off, lines });

add(1, [
  '鉴权中间件：在 reqwest 的请求管线上透明地补上 Basic 认证信息。',
  '凭据来源按成本从低到高排列：请求自带、URL、缓存、netrc、文本凭据文件、云厂商签名、keyring。',
  '设计上尽量避免「先发一个注定 401 的请求」：已知需要认证的端点会直接先找凭据。',
  '本文件同时包含大量集成测试，用 wiremock 模拟带 Basic 认证的索引服务。',
]);

add(3, [
  'anyhow 用于包装不可分类的中间件错误；format_err 让错误信息里能直接带上下文。',
  'http 的 Extensions 与 StatusCode 分别承载请求扩展与 401/403/404 判定。',
  'reqwest 的 Request 与 Response 是管线输入输出；Middleware 与 Next 来自 reqwest-middleware。',
  'tokio 的 Mutex 保护惰性初始化的云厂商凭据状态，避免并发重复调用凭据助手。',
  'tracing 的 debug、trace、warn 三级分别对应「结论」「路径」「异常但可继续」三类事件。',
]);

add(10, [
  'uv_netrc 解析 ~/.netrc；Netrc 实例在首次访问时惰性加载。',
  'uv_preview 的 Preview 控制实验特性（如原生凭据存储）是否启用。',
  'SafeUrl 保证日志与错误信息里不会出现密码。',
  'uv_static 的 EnvVars 集中定义环境变量名，避免散落的字符串字面量。',
]);

add(15, [
  '四个云厂商提供者：Hugging Face 走令牌，S3/GCS/Azure 走各自 SDK 的签名。',
  '统一接口让 fetch_credentials 能用相同的分支结构处理三种对象存储。',
]);

add(18, [
  'CredentialsCache 是单次 uv 调用内跨客户端共享的缓存；FetchUrl 是去重键。',
  'Authentication 与 Credentials 区分「认证信息」与「用户名密码」两种形态。',
  'AuthPolicy 与 Indexes 决定某个 URL 是否应该认证、认证到什么程度。',
  'Realm 把同一主机下的一组 URL 归并，缓存可以按 realm 命中。',
]);

add(29, [
  'Dependabot 会拦截 HTTP 并在外部注入凭据，因此不能提前判定「缺少凭据」。',
  '用 LazyLock 缓存环境变量判断，避免每个请求都读一次进程环境。',
]);

add(33, [
  '把认证错误转成 reqwest-middleware 的中间件错误，便于在管线里统一传播。',
]);

add(39, [
  'URL 中解析凭据失败时同样包装为中间件错误，错误信息由上游格式化。',
]);

add(45, [
  'netrc 的加载策略：生产环境惰性读取一次，测试可强制启用或禁用。',
]);

add(47, [
  'Automatic 持有一个 LazyLock：只有真正需要查 netrc 时才读文件，避免无谓 IO。',
]);

add(48, [
  'Enabled 与 Disabled 只在测试编译时存在，用来隔离文件系统。',
]);

add(54, [
  '默认策略是惰性读取 netrc；读取失败不致命，只记录日志后当作不存在。',
]);

add(56, [
  '首次解引用时执行这段初始化，结果被 LazyLock 永久缓存。',
]);

add(58, [
  '文件不存在是最常见的情况，用 debug 级别即可，不应打扰用户。',
]);

add(62, [
  '解析错误仍然只警告：netrc 是可选的，格式错误不应阻断整个解析。',
]);

add(70, [
  '取已解析的 netrc；测试分支直接返回预置实例或 None，不触碰文件系统。',
]);

add(84, [
  '文本凭据文件的加载策略，结构与 NetrcMode 对称。',
]);

add(85, [
  'OnceCell 支持异步惰性初始化：多个并发请求只会真正读一次文件。',
]);

add(92, [
  '默认不预加载，等第一次查凭据时再读。',
]);

add(99, [
  '确定默认凭据文件路径并读取内容；任何失败都退化为「没有凭据」。',
]);

add(100, [
  '路径解析失败通常意味着无法确定用户主目录，记录警告后返回 None。',
]);

add(106, [
  '读取成功时同时拿到文件锁，锁在调用方存活期间保持，避免并发写坏文件。',
]);

add(111, [
  '文件不存在是正常情况，用 debug 而非 warn。',
]);

add(119, [
  '其余错误（权限、格式）只警告，凭据缺失不影响匿名访问。',
]);

add(131, [
  '取已加载的凭据存储；Automatic 分支会触发一次异步初始化。',
]);

add(135, [
  'get_or_init 保证并发调用共享同一次读取结果。',
]);

add(144, [
  '三种云厂商凭据状态结构相同：未初始化，或已初始化（可能是 None，表示该端点未配置）。',
  '用 Clone 是因为初始化后的 Arc 需要被多个请求共享。',
]);

add(146, [
  'Uninitialized 表示还没运行过凭据助手；首次命中 S3 端点时才会初始化。',
]);

add(148, [
  'Initialized(None) 表示已确认没有配置，后续请求直接跳过，不再重复探测。',
]);

add(153, [
  'GCS 状态与 S3 完全对称，分开定义是为了让类型系统阻止跨厂商误用。',
]);

add(162, [
  'Azure 状态同理；三个枚举不合并，是为了让锁的类型与厂商一一对应。',
]);

add(175, [
  '中间件本体：所有字段都是不可变配置或惰性状态，handle 只通过 &self 访问。',
  '多个客户端共享同一个 AuthMiddleware 时，缓存与云厂商状态也随之共享。',
]);

add(176, [
  'netrc 加载策略；Automatic 时首次查询才读文件。',
]);

add(177, [
  '文本凭据文件策略；与 netrc 并行，前者用于非标准位置。',
]);

add(178, [
  'keyring 提供者；None 表示用户禁用了系统钥匙串。',
]);

add(179, [
  '全局凭据缓存，跨所有 uv 客户端共享，避免同一凭据被反复查询。',
]);

add(182, [
  '按 URL 匹配的认证策略，来自配置里的 index 定义。',
]);

add(185, [
  '为 true 时永不发送匿名请求，直接先找凭据；用于明确要求认证的端点。',
]);

add(187, [
  '交互式兜底：找不到凭据时可以提示用户输入。',
]);

add(189, [
  'S3 凭据状态；放在 Mutex 里保证只初始化一次。',
]);

add(191, [
  'GCS 与 Azure 同理，各自独立加锁，互不阻塞。',
]);

add(194, [
  '实验特性开关，决定是否使用原生凭据存储。',
]);

add(197, [
  'Default 直接委托给 new，保持与手写构造一致。',
]);

add(204, [
  '构造一个未配置的中间件：所有凭据来源都处于「尚未查询」状态。',
]);

add(209, [
  '缓存必须先于各来源创建，因为 fetch_credentials 的去重表就挂在缓存上。',
]);

add(221, [
  '测试专用：注入预置 netrc；生产环境只能走 Automatic。',
]);

add(235, [
  '测试专用：注入预置凭据文件，用于验证文本存储的读取逻辑。',
]);

add(251, [
  '注入 keyring 提供者；None 表示显式禁用。',
]);

add(258, [
  '注入实验特性配置，测试里可强制开启或关闭 NativeAuth。',
]);

add(266, [
  '测试专用：替换整个缓存实例，便于构造预置状态。',
]);

add(280, [
  '注入索引定义，决定每个 URL 的认证策略。',
]);

add(288, [
  '强制所有端点都先认证；会跳过匿名探测这一步。',
]);

add(295, [
  '注入交互式提示器；None 表示不允许阻塞等待用户输入。',
]);

add(301, [
  '缓存访问器；handle 内部反复用到，抽成方法避免字段名重复。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-1.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
