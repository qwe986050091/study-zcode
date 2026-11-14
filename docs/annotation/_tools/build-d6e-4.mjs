import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const off = 183;
const items = [];
const add = (line, lines) => items.push({ line: line + off, lines });

add(892, [
  '统一转成 Authentication 并包进 Arc；后续分支会多次克隆这个引用。',
]);

add(894, [
  '无论成功还是失败都要登记：失败也要让等待中的请求立刻得到结论，而不是重复探测。',
]);

add(901, [
  '生成用于日志的脱敏 URL：密码不会出现在输出里，但用户名会保留以便定位问题。',
]);

add(902, [
  '从请求 URL 复制一份；SafeUrl 在 Debug 与 Display 时会自动隐藏密码。',
]);

add(903, [
  '只有 Credentials 变体才含用户名密码；其他认证方式（如签名）没有可展示的字段。',
]);

add(905, [
  '用户名写回 URL 供日志使用；返回错误被忽略，因为这只影响日志可读性。',
]);

add(907, [
  '密码同样写回，但 SafeUrl 在展示时会替换成占位符。',
]);

add(911, [
  '返回脱敏后的 URL；调用方直接把它插入 trace 日志。',
]);

add(914, [
  '测试区使用 #[cfg(test)]，因此上面的 with_netrc 等方法在生产构建中不存在。',
]);

add(915, [
  '集成测试：用 wiremock 起一个只接受 Basic 认证的假索引，逐条验证凭据来源的优先级。',
]);

add(916, [
  'assert_matches 用于断言错误变体；io 与 Write 服务于凭据提示的模拟输入。',
]);

add(917, [
  'AtomicUsize 统计提示次数，验证「只提示一次」这类行为。',
]);

add(918, [
  '原子计数器在多个异步任务间共享，SeqCst 足以保证断言前的可见性。',
]);

add(920, [
  'http::Method 与 reqwest::Client 是构造真实请求所需的最小依赖。',
]);

add(921, [
  'Client 不带任何中间件，由 test_client_builder 负责挂载被测的 AuthMiddleware。',
]);

add(922, [
  'NamedTempFile 用于构造临时 netrc 与凭据文件，测试结束自动删除。',
]);

add(923, [
  'test_log 的 test 宏让 #[test(tokio::test)] 同时初始化 tracing 订阅。',
]);

add(924, [
  'wiremock 的 basic_auth 匹配器直接校验 Authorization 头，method/path_regex 负责路由。',
]);

add(925, [
  'MockServer 提供真实 HTTP 端口，ResponseTemplate 构造状态码与 body。',
]);

add(927, [
  'Password 用于断言解析出的密码内容。',
]);

add(928, [
  'CredentialsPromptError 与 Index 分别服务于提示失败与索引策略两类测试。',
]);

add(930, [
  '把被测模块的全部符号引入作用域，测试里可以直接使用私有方法。',
]);

add(932, [
  '测试统一用 boxed error，避免为每种错误写转换。',
]);

add(934, [
  '全局提示计数器：测试串行执行，因此可以用一个静态变量。',
]);

add(936, [
  '启动假索引：正确凭据返回 200，其余 GET 一律 401。',
]);

add(937, [
  'MockServer::start 绑定随机端口，避免测试之间抢占固定端口。',
]);

add(939, [
  '高优先级 mock：路径与方法匹配且 Basic 凭据正确时返回 200。',
]);

add(945, [
  '兜底 mock：任何未命中上一条的 GET 都返回 401，模拟「需要认证」。',
]);

add(953, [
  '构造不带中间件的客户端构建器，方便每个测试按需挂载不同配置的中间件。',
]);

add(954, [
  'ClientBuilder 需要显式 build 出 reqwest::Client；失败视为测试环境问题。',
]);

add(962, [
  '基线测试：没有任何凭据来源时，两个不同路径都应以 401 结束。',
  '这里同时验证缓存不会凭空产生凭据。',
]);

add(963, [
  '启动只接受 user/password 的服务端。',
]);

add(964, [
  '只挂载默认中间件与一个空缓存，netrc、文本存储、keyring 全部未配置。',
]);

add(965, [
  'with_cache 注入空缓存，确保测试之间不会通过进程级状态互相污染。',
]);

add(973, [
  '第一个路径返回 401：说明匿名请求被服务端拒绝，且中间件没有伪造凭据。',
]);

add(989, [
  '第二个路径同样 401：验证失败结果不会让中间件缓存错误的凭据。',
]);

add(1005, [
  '提示得到的凭据要能跨请求复用：第一次提示后，第二次请求不应再次提示。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-4.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
