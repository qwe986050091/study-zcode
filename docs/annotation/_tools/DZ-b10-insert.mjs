// B10：给两个已达标的方言 dialect 追加「族内映射表」（不追高密度，仅建立与基准 INV-MD 的对应）。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/drizzle-orm';

const plan = {
  'drizzle-orm/src/pg-core/dialect.ts': [
    [1, [
      '// 【族内映射】本文件与 `mysql-core/dialect.ts`（基准）结构同构，通用不变量见 INV-MD#01~#10，',
      '// 本文不重复其表述，仅列 PG 的方言差异；上游 JSDoc 已覆盖公开 API 契约，故本文件不追高密度。',
      '//',
      '// 函数 → 基准 → 差异：',
      '// - escapeName/escapeParam/escapeString → INV-MD#02：占位符为 `$n` 而非 `?`，escapeParam 必须用编号。',
      '// - buildSelection → INV-MD#03：无差异（字段顺序仍由 fieldsFlat 决定）。',
      '// - buildSelectQuery → INV-MD#05/#10：支持 FOR UPDATE / FOR NO KEY UPDATE / SKIP LOCKED，锁子句仍在最外层。',
      '// - buildInsertQuery → INV-MD#04：原生 RETURNING，无需构建期回填自增 id；ON CONFLICT 支持 DO UPDATE。',
      '// - buildRelationalQuery → INV-MD#07/#08：可直接用 LATERAL 与 json_agg/jsonb_agg，别名规则不变。',
      '// - sqlToQuery → INV-MD#02/#09：编号占位符由此统一产出，sql.raw 仍不参与编号。',
      '//',
      '// [失败路径] PG 独有的类型归一化（numeric/timestamp/json）在 buildSelection 段静默改写表达式，',
      '// 不会抛错；真正的失败发生在驱动层参数绑定。',
    ]],
  ],
  'drizzle-orm/src/gel-core/dialect.ts': [
    [1, [
      '// 【族内映射】本文件与 `mysql-core/dialect.ts`（基准）共享表/列/关系的装配职责，',
      '// 但产出的是 EdgeQL 而非 SQL 文本，故只有部分 INV-MD 可沿用；上游 JSDoc 已达标，不追高密度。',
      '//',
      '// 函数 → 基准 → 差异：',
      '// - escapeName/escapeParam/escapeString → INV-MD#02：不适用，EdgeQL 使用 `$0,$1...` 命名参数。',
      '// - buildSelection → INV-MD#03：可沿用"输出顺序 = fieldsFlat 顺序"的契约，但投影语法完全不同。',
      '// - buildSelectQuery → INV-MD#05：不适用（无 join 限定符概念），shape 由 EdgeQL 的 select 表达式承担。',
      '// - buildInsertQuery / buildUpdateQuery / buildDeleteQuery → INV-MD#04：EdgeQL 统一用 insert/update/delete 表达式，无 RETURNING 关键字。',
      '// - buildRelationalQuery → INV-MD#07/#08：可沿用别名唯一与 One 限一的约束，实现改为嵌套 select。',
      '// - sqlToQuery → INV-MD#09：仍由它产出最终参数文本，但占位符是命名形式。',
      '//',
      '// [权衡] 与 SQL 方言保持同名方法而非另立抽象：让 query-builder 无需感知方言产出的是 SQL 还是 EdgeQL。',
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
