import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const off = 271;
const items = [];
const add = (line, lines) => items.push({ line: line + off, lines });

add(1658, [
  'keyring 的键包含端口：同一主机上不同端口的服务视为不同凭据域。',
  '这能防止本地多个索引服务共用 localhost 时凭据互相覆盖。',
]);

add(1689, [
  'keyring 结果写入缓存后，同 realm 的其他路径应直接命中缓存而不再查询。',
]);

add(1746, [
  '两个不同端口的服务属于不同 realm，缓存必须彼此隔离。',
  '测试先分别 seed，再交叉请求，确认不会把 A 的凭据发给 B。',
]);

add(1755, [
  '第一个服务使用 user1/password1，监听自己的随机端口。',
]);

add(1762, [
  '第二个服务使用完全不同的凭据，端口不同即 realm 不同。',
]);

add(1765, [
  '按 URL 分别写入缓存；realm 由主机与端口推导，因此两条记录不会冲突。',
]);

add(1813, [
  '与上一个测试相同，但凭据来自 keyring 而非预置缓存。',
  '重点验证 keyring 查询同样按 realm 隔离。',
]);

add(1915, [
  '同一 realm 内混合了需要认证与公开的前缀，验证凭据不会被错误附加。',
  '公开前缀在收到凭据时故意返回 401，这样「多发凭据」会立刻暴露。',
]);

add(1916, [
  '两个用户分别对应两个私有前缀，密码不同。',
]);

add(1921, [
  '只用一台 MockServer，因此所有前缀共享同一个 realm。',
]);

add(1923, [
  'prefix_1 只接受 user1，用于验证按前缀命中的缓存。',
]);

add(1930, [
  'prefix_2 只接受 user2，与 prefix_1 形成对照。',
]);

add(1937, [
  '公开前缀：带任何凭据都返回 401，匿名才返回 200。',
]);

add(1939, [
  '显式拒绝 user1 的凭据，防止中间件把 realm 级凭据发给公开路径。',
]);

add(1945, [
  '同样拒绝 user2 的凭据。',
]);

add(1951, [
  '匿名请求返回 200，这是公开前缀的期望行为。',
]);

add(1957, [
  '未匹配任何前缀时返回 401，保证其余路径仍然需要认证。',
]);

add(1962, [
  '构造三个前缀 URL，分别作为缓存键与请求目标。',
]);

add(1967, [
  '空缓存起步，凭据改由 seed 显式写入，便于精确控制归属。',
]);

add(1969, [
  '按前缀 URL 写入各自凭据；注意不是按 realm 写入，因此公开前缀没有凭据。',
]);

add(1985, [
  '只挂载缓存与中间件，不配置 keyring 与 netrc，隔离变量。',
]);

add(2226, [
  '同一 realm、相同用户名但不同密码：keyring 必须按 URL 精确取值。',
  '若错误地按 realm 缓存，第二次请求会复用第一次的密码而失败。',
]);

add(2346, [
  '同一 realm 下配置两个索引，各自有独立密码，验证索引维度优先于 realm。',
  '两个索引共用主机与端口，只有路径不同，这是最容易串用凭据的场景。',
]);

add(2347, [
  '两个索引使用相同用户名但不同密码，刻意制造「仅靠用户名无法区分」的情况。',
]);

add(2352, [
  '单台 MockServer 承载两个索引前缀。',
]);

add(2354, [
  'prefix_1 只接受 password1。',
]);

add(2361, [
  'prefix_2 只接受 password2。',
]);

add(2368, [
  '兜底 401：没有用户名时两个索引都不可访问。',
]);

add(2374, [
  '构造两个 Index，root_url 与 url 相同，策略为 Auto。',
  '有了索引信息，fetch_credentials 才会用索引 URL 作为 keyring 查询键。',
]);

add(2391, [
  'dummy keyring 按索引 URL 分别记录密码，模拟真实钥匙串的精确匹配。',
]);

add(2400, [
  '先验证无用户名时两个索引都 401，排除「匿名可读」的干扰。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-6.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
