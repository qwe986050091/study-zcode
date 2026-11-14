// B06 插入脚本：selection-proxy + 两个 barrel 文件。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/drizzle-orm';

const plan = {
  'drizzle-orm/src/selection-proxy.ts': [
    [8, [
      '// 选择字段代理：把子查询/视图的 selectedFields 暴露成"带别名、且区分 SQL 与 SQL.Aliased"的视图。',
      '// 链路位置：.as() 返回的 Subquery/View 被再次 select 时，本 Proxy 决定每个字段返回什么。',
    ]],
    [47, [
      '// `_` 与 ViewBaseConfig 之外的读取都走字段解析：先定位列集合，再按 SQL / SQL.Aliased / Column 分派。',
    ]],
    [79, [
      '// [不变量] 子查询里已选中的 SQL.Aliased 不再返回底层 sql（否则会丢失外层别名），只能 clone 并标记。',
    ]],
  ],
  'drizzle-orm/src/sql/expressions/index.ts': [
    [1, [
      '// 表达式构造器的统一出口：条件与 select 两族函数的 re-export，保持导入路径稳定。',
    ]],
  ],
  'drizzle-orm/src/sql/functions/index.ts': [
    [1, [
      '// SQL 函数族的统一出口：聚合与向量函数的 re-export，不在此处增加运行期逻辑。',
    ]],
  ],
};

for (const [rel, inserts] of Object.entries(plan)) {
  const file = path.join(REPO, rel);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('\r\n')) throw new Error('not CRLF: ' + rel);
  const lines = text.split('\r\n');
  for (const [lineNo, comments] of [...inserts].sort((a, b) => b[0] - a[0])) {
    lines.splice(lineNo - 1, 0, ...comments);
  }
  fs.writeFileSync(file, lines.join('\r\n'));
  console.log(`${rel} +${inserts.reduce((n, x) => n + x[1].length, 0)}`);
}
