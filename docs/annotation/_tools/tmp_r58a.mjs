// R58a：10 条裸函数内文（5 散件 + sqlgenerator 5 个 can）
import fs from 'node:fs';
const REPO = 'D:/code/opensource/drizzle-orm/';
const items = [
  ['drizzle-kit/src/index.ts', 348, 'return config;', '原样返回配置对象，运行期不做校验也不补默认值；存在的意义是让调用处拿到 Config 的类型推断。'],
  ['drizzle-kit/src/introspect-mysql.ts', 283, 'return mysqlImportsList.has(type);', '白名单过滤：列类型不在 mysqlImportsList 里就不生成 import，避免引入未使用的构造函数。'],
  ['drizzle-kit/src/introspect-pg.ts', 501, 'return pgImportsList.has(type);', '白名单过滤：pgImportsList 之外的列类型不导入，避免生成文件里出现未使用的构造器。'],
  ['drizzle-kit/src/introspect-singlestore.ts', 1077, 'return `table.${casing(c)}`;', '列引用写成 table.<casing 后的名字>，casing 决定导出变量里属性的拼写，与 columns 定义共用同一套命名。'],
  ['drizzle-kit/src/introspect-sqlite.ts', 165, 'return sqliteImportsList.has(type);', '视图列同样走 sqliteImportsList 白名单，PRAGMA 回报的类型名未必是已注册构造器。'],
  ['drizzle-kit/src/sqlgenerator.ts', 590, "return statement.type === 'create_table' && dialect === 'mysql';", '只认 mysql 方言的 create_table；dialect 不比对会让 postgres 的建表语句落进反引号渲染器。'],
  ['drizzle-kit/src/sqlgenerator.ts', 922, "return statement.type === 'mysql_create_view' && dialect === 'mysql';", 'mysql_create_view 只在 mysql 方言下匹配；fromJson 按 can 的返回顺序挑转换器，条件放宽会让 sqlite 的视图语句进入 ALGORITHM 分支。'],
  ['drizzle-kit/src/sqlgenerator.ts', 947, "return statement.type === 'sqlite_create_view' && (dialect === 'sqlite' || dialect === 'turso');", 'sqlite 与 turso 共用这条分支，两者的视图只有 name 与 definition 两个字段，漏掉 turso 会让该方言的视图找不到渲染器。'],
  ['drizzle-kit/src/sqlgenerator.ts', 960, "return statement.type === 'drop_view' && dialect === 'postgresql';", 'drop_view 在 postgresql 下走这条分支，普通视图与物化视图的区分留给 convert 的 materialized 判断。'],
  ['drizzle-kit/src/sqlgenerator.ts', 975, "return statement.type === 'drop_view' && dialect === 'mysql';", 'drop_view 的 mysql 分支只处理普通视图；与 postgresql 共用 type，必须靠 dialect 排他，否则物化视图的 DROP 会被渲染成 MySQL 形式。'],
];
const BAN = /都|全部|一律|始终|从不|必然|只会|唯一|没有一处|只有|仅有/;
const PRON = /它|其|该|此|这里|上述|相关/;
const err = [];
// 按文件分组，行号降序插入
const byFile = {};
for (const it of items) (byFile[it[0]] ||= []).push(it);
for (const [rel, list] of Object.entries(byFile)) {
  const p = REPO + rel;
  const raw = fs.readFileSync(p, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  list.sort((a, b) => b[1] - a[1]);
  for (const [r, lineNo, anchor, text] of list) {
    if (BAN.test(text)) err.push(`${rel}:${lineNo} 禁词`)
    if (PRON.test(text)) err.push(`${rel}:${lineNo} 禁代词`);
    const idx = lineNo - 1;
    if (!lines[idx] || !lines[idx].includes(anchor)) { err.push(`${rel}:${lineNo} 锚点不匹配: ${JSON.stringify((lines[idx]||'').trim())}`); continue; }
    const indent = lines[idx].match(/^[\t ]*/)[0];
    lines.splice(idx, 0, indent + '// ' + text);
  }
  fs.writeFileSync(p, lines.join(eol), 'utf8');
}
if (err.length) { console.error('FAIL\n' + err.join('\n')); process.exit(1); }
console.log('inserted', items.length);
