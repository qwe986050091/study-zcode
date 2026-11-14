// 预批准主机白名单：命中即可跳过 WebFetch 的交互审批。
// 只做 hostname 精确匹配（URL 解析会小写化 host），不支持通配符/子域；
// 新增条目等于放宽审批面，必须确认该站点是稳定、可信的只读文档源。
const PREAPPROVED_HOSTS = new Set([
  "modelcontextprotocol.io",
  "agentskills.io",
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",
  "laravel.com",
  "symfony.com",
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",
  "asp.net",
  "dotnet.microsoft.com",
  "blazor.net",
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",
  "keras.io",
  "spark.apache.org",
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",
  "docs.getdbt.com",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "docs.stripe.com",
  "docs.netlify.com",
  "devcenter.heroku.com",
  "cypress.io",
  "selenium.dev",
  "docs.unity.com",
  "docs.unrealengine.com",
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org",
]);

// 仅对“文档路径”预批准的主机：只允许 pathname 等于前缀或以 `前缀/` 开头。
// 为什么按路径收紧：这些站点还有大量非文档内容（登录、搜索、用户页），
// 整站放行会让审批面过大。
const PREAPPROVED_PATH_PREFIXES = new Map([
  ["wordpress.org", ["/documentation"]],
  ["huggingface.co", ["/docs"]],
  ["www.kaggle.com", ["/docs"]],
  ["vercel.com", ["/docs"]],
]);

/**
 * 判断一个 WebFetch URL 是否属于预批准范围（命中则审批层可直接放行）。
 * 输入：原始 URL 字符串；解析失败一律 false（fail closed）。
 * 规则：先查整站白名单（hostname 精确匹配），再查路径前缀白名单；
 * 路径前缀要求边界完整（等于前缀或 `前缀/` 开头），并拒绝编码后的穿越字符。
 * 注意：只看 hostname/pathname，不校验 scheme（http 与 https 同权）；
 * 也不检查端口；重定向目标不会在这里重新判定——调用方只对原始入参 URL 调用。
 * 纯函数、无网络 I/O；消费者是 permission/service 与 webfetch handler。
 */
export function isWebFetchPreapprovedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // 非法 URL 无法建立可信的 host/path 事实，必须拒绝预批准而不是猜测。
    return false;
  }

  if (PREAPPROVED_HOSTS.has(url.hostname)) {
    return true;
  }

  const prefixes = PREAPPROVED_PATH_PREFIXES.get(url.hostname);
  if (!prefixes) {
    return false;
  }
  // 为什么额外拒绝编码字符：new URL 不解码 pathname，`%2f`/`%252f`/`%2e` 可让
  // 路径前缀检查与实际请求路径产生分歧，按“可能有穿越意图”直接拒绝。
  if (/%(25)*(2f|5c|2e)/iu.test(url.pathname)) {
    return false;
  }
  return prefixes.some(
    (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
  );
}
