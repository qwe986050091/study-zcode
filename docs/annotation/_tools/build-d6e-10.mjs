import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const items = [];
const add = (anchor, lines) => items.push({ anchor, lines });

add('let result = next.run(request, extensions).await;', [
  '请求在收尾阶段才真正执行，此前所有逻辑只做凭据准备。',
]);
add('// If we don\'t find a password, we\'ll still attempt the request with the existing credentials', [
  '找不到密码时仍发送已有用户名，服务端可能只需要身份而不校验密码。',
  '这是「尽量不阻塞用户」的体现：失败结果由调用方决定。',
]);
add('if credentials.is_some() {', [
  '去重表返回 Some 表示已有结论，无论成功失败都直接复用。',
]);
add('trace!("Initializing S3 credentials for `{url}`");', [
  '首次命中 S3 才创建签名器，未使用对象存储的用户不付这个成本。',
  '初始化结果写入状态，None 表示该端点确认未配置凭据。',
]);
add('debug!("Checking netrc for credentials for `{url}`");', [
  'netrc 查询会带上已知用户名，避免返回其他主机的条目。',
]);
add('match text_store.get_credentials(', [
  '文本存储查询可能失败，失败只记录 debug 并继续下一个来源。',
]);
add('Ok(credentials) => credentials.cloned(),', [
  '返回的是引用，需要克隆成拥有所有权的凭据才能继续传递。',
]);
add('let native_store = KeyringProvider::native();', [
  '原生存储是实验特性，只有 preview 开启时才会执行到这一行。',
]);
add('let display_username = if let Some(username) = username {', [
  '日志里把用户名渲染成 user@ 前缀，没有用户名时留空。',
]);
add('native_store.fetch(&index.root_url, username).await', [
  '原生存储只做精确匹配，因此用根 URL 而不是完整索引 URL。',
]);
add('native_store.fetch(url, username).await', [
  '无索引时直接按请求 URL 查询，覆盖非索引类服务的场景。',
]);
add('Some(ref keyring) => {', [
  'keyring 子进程较慢，只有前面所有来源都失败后才会走到这里。',
]);
add('keyring.fetch(&index.url, Some(username)).await', [
  '有用户名时按索引 URL 精确查询，避免同 realm 内串用凭据。',
]);
add('keyring.fetch(&index.url, None).await', [
  'Always 策略允许无用户名查询，这是强制认证场景的兜底。',
]);
add('let mut url = SafeUrl::from_url(request.url().clone());', [
  '从请求 URL 复制一份；后续只修改用户名密码，不影响原请求。',
]);
add('if let Some(Authentication::Credentials(creds)) = credentials {', [
  '只有用户名密码形态才能写回 URL；签名类凭据没有可展示字段。',
]);
add('if let Some(password) = creds.password() {', [
  '密码写回后由 SafeUrl 的展示层负责脱敏。',
]);

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
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-10.json', JSON.stringify([{ file, items: resolved }], null, 2));
console.log('items', resolved.length, 'lines', resolved.reduce((n, i) => n + i.lines.length, 0));
