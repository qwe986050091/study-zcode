import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const items = [];
const add = (anchor, lines) => items.push({ anchor, lines });

add('let request_credentials = Credentials::from_request(&request)?.map(Authentication::from);', [
  '入口第一步：把 URL 或 Authorization 头里的凭据解析出来。',
  '解析失败不忽略，直接以中间件错误返回，避免带病请求。',
]);
add('let url = tracing_url(&request, request_credentials.as_ref());', [
  '日志用 URL 只在这里构造一次，后续所有分支复用它。',
]);
add('let index = self.indexes.index_for(request_url);', [
  '索引信息决定缓存键与认证策略，找不到时为 None。',
]);
add('let auth_policy = self.indexes.auth_policy_for(request_url);', [
  '策略与索引分开查询：即使不认识这个 URL，也可能有全局策略。',
]);
add('let must_authenticate = self.only_authenticated', [
  '强制认证的判定集中在一处，后续分支只读这个布尔值。',
  'Dependabot 例外让「策略 Always」不至于在凭据由外部注入时误报。',
]);
add('let (mut retry_request, response) = if !must_authenticate {', [
  '两个分支的产物一致：一个可重试的请求，以及可能存在的首次响应。',
]);
add('let attempt_has_username = credentials', [
  '记录首次尝试是否带用户名，决定最后是否需要用缓存用户名再试。',
]);
add('let retry_request_url = SafeUrl::ref_cast(retry_request.url());', [
  '重试请求与原始请求 URL 相同，用它作为 realm 缓存键。',
]);
add('let mut fetched_credentials = self', [
  '回源查询是最后一道来源，可能启动 keyring 子进程。',
  '这次查询可能命中缓存中的去重结果，因此开销通常很低。',
]);
add('if let Some(credentials) = fetched_credentials {', [
  '拿到回源结果就重试，并把凭据交给收尾流程写缓存。',
]);
add('if let Some(response) = response {', [
  '有首次响应就原样返回，保留真实状态码。',
]);

add('let is_s3_endpoint =', [
  '端点判断放在最前面：非对象存储请求不会触碰任何云厂商 SDK。',
]);
add('if is_s3_endpoint {', [
  'S3 分支：先取状态锁，再决定是否创建签名器。',
]);
add('if is_gcs_endpoint {', [
  'GCS 与 S3 互斥，同一请求最多命中一个分支。',
]);
add('if is_azure_endpoint {', [
  'Azure 分支同样先锁后初始化，避免并发重复创建。',
]);
add('let mut s3_state = self.s3_credential_state.lock().await;', [
  '锁在这里被持有到分支结束，期间其他请求会等待初始化完成。',
]);
add('let mut gcs_state = self.gcs_credential_state.lock().await;', [
  'GCS 的锁独立，因此不会与 S3 的初始化互相阻塞。',
]);
add('let mut azure_state = self.azure_credential_state.lock().await;', [
  'Azure 的锁同样独立，三个云厂商互不影响。',
]);
add('S3CredentialState::Uninitialized => {', [
  '首次命中才创建签名器；未配置时写入 Initialized(None) 以免反复探测。',
]);
add('GcsCredentialState::Uninitialized => {', [
  'GCS 初始化与 S3 同构，只是签名器类型不同。',
]);
add('AzureCredentialState::Uninitialized => {', [
  'Azure 初始化同样只执行一次。',
]);

add('let key = if let Some(index) = index {', [
  '去重键在回源前确定，保证同一来源的并发请求只执行一次查询。',
]);
add('let credentials = credentials.map(Authentication::from).map(Arc::new);', [
  '回源结果统一包装，既用于返回也用于登记去重表。',
]);

add('type Error = Box<dyn std::error::Error>;', [
  '测试错误统一装箱，省去为每个错误类型写 From。',
]);
add('static RETRY_PROMPTS: AtomicUsize = AtomicUsize::new(0);', [
  '提示计数是跨异步任务的共享状态，用原子类型避免数据竞争。',
]);
add('fn test_client_builder() -> reqwest_middleware::ClientBuilder {', [
  '所有测试共用同一个客户端构造器，只在中间件配置上做区分。',
]);

add('/// Prompted credentials survive a failed request without prompting again on retry.', [
  '提示一次后结果进入缓存，重试与后续请求都不应再次提示。',
]);
add('// A username discovered at another path in the same realm still needs a password.', [
  '预置的凭据只有用户名，借此验证同 realm 内可以补全密码。',
]);
add('/// Explicit credentials must not be replaced by interactive input, even when incomplete.', [
  '用户显式提供的凭据优先级最高，提示器不能被调用。',
]);
add('// Works for a URL without credentials now', [
  '成功一次后，同 realm 的无凭据 URL 应直接命中缓存。',
]);
add('let mut url_1 = base_url_1.clone();', [
  '从索引 URL 派生带用户名的 URL，保持端口与路径不变。',
]);
add('// It will throw a 401 if it receives credentials', [
  '带凭据访问公开路径会被刻意拒绝，从而暴露错误的凭据附加。',
]);
add('// Create a text credential store with matching credentials', [
  'store 的键是 Service（由 URL 解析），值是用户名密码。',
]);
add('// Request with matching username should succeed', [
  '用户名匹配时文本 store 返回对应记录。',
]);
add('// Request with non-matching username should fail', [
  '用户名不匹配时 store 不应「模糊匹配」到唯一记录。',
]);
add('// Request without username should succeed', [
  '没有用户名时不加筛选，按服务即可命中唯一记录。',
]);
add('// Subsequent requests to the same realm should also succeed (credentials cached)', [
  '空用户名 + 密码的成功结果同样会写入缓存，按 realm 复用。',
]);

// 把「去缩进锚点」解析成唯一的完整行，并用 line + anchor 双重校验
const lines = fs.readFileSync('d:\\code\\opensource\\uv\\' + file, 'utf8').split('\n');
const resolved = [];
for (const item of items) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '').trim() === item.anchor) hits.push(i);
  }
  if (hits.length !== 1) {
    console.error(`SKIP anchor x${hits.length}: ${item.anchor}`);
    continue;
  }
  resolved.push({ line: hits[0] + 1, anchor: lines[hits[0]].replace(/\r$/, ''), lines: item.lines });
}
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-9.json', JSON.stringify([{ file, items: resolved }], null, 2));
console.log('items', resolved.length, 'lines', resolved.reduce((n, i) => n + i.lines.length, 0));
