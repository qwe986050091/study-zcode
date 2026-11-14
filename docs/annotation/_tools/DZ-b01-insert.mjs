// DZ-b01 注释插入：按 1-based 行号在目标行之前插入整行 // 注释（CRLF 源，插入行同样用 CRLF）
import fs from 'node:fs';

const REPO = 'D:/code/opensource/drizzle-orm/';
const ops = [
  {
    file: 'drizzle-orm/src/sql/sql.ts',
    inserts: [
      [1, [
        '// 文件职责：Drizzle 的 SQL 片段代数（SQL AST）。ORM 不拼接 SQL 字符串，而是把表、列、参数、',
        '// 子查询、占位符统一表示成 SQLChunk 树，由 buildQueryFromSourceParams 一次性渲染成',
        '// { sql, params, typings }。方言差异（转义符、占位符编号）只经由 BuildQueryConfig 注入，',
        '// 本文件不出现任何具体数据库的语法。',
        '// 在链路中的位置：table/column/relations → sql/（本文件）→ 方言 dialect.buildQuery → session → driver。',
        '//',
        '// 不变量表：',
        '// INV-01：参数编号只能由 paramStartIndex 单调递增产生，任何分支不得自行拼接占位符文本；否则',
        '//   prepared statement 的绑定顺序与实际参数数组错位（守住它的位置：Param / Placeholder 分支）。',
        '// INV-02：同一次渲染中 params 与 typings 必须等长同序 —— typings[i] 描述 params[i] 的编码方式；',
        '//   漏推会让驱动把 JSON/日期参数当字符串（守住它的位置：所有返回 typings 的分支）。',
        '// INV-03：标识符走 escapeName、值走 escapeParam/escapeString，两条路径不可互换（守住它的位置：',
        '//   Name/Table/Column/View 与 Param/兜底分支）。',
        '// INV-04：inlineParams 只能逐层继承并累加（子树可开不可关），否则同一查询会同时出现内联值与绑定值，',
        '//   参数编号错位（守住它的位置：函数入口的 config 派生与 is(chunk, SQL) 分支）。',
      ]],
      [32, [
        '// 渲染上下文：方言把转义与占位符规则注入这里，buildQuery 内部因此不出现方言分支。',
        '// [失败路径] escapeName/escapeParam 由方言实现，抛错直接冒泡；本层不捕获——',
        '// 转义失败意味着方言实现有 bug，静默降级会产出可执行但语义错误的 SQL。',
      ]],
      [74, [
        '// STEP-1 合并：按 chunk 原顺序拼接 sql，params/typings 同步展开。',
        '// [不变量] 只做顺序拼接与数组展开，不重排、不去重：参数下标就是驱动侧的绑定契约。',
      ]],
      [118, [
        '// STEP-0 构造即收集 usedTables：只识别顶层 chunk 里的 Table，不递归下钻。',
        '// [权衡] 不递归：深层子查询的 SQL 实例已各自收集，本字段只服务单条语句日志；',
        '// 递归会引入循环引用（表 → 默认值 SQL → 表）。',
        '// [不变量] usedTables 仅供日志，渲染路径不得依赖它。',
      ]],
      [132, [
        '// [不变量] append 直接拼入对方 chunks、不复制：两个 SQL 实例此后共享 chunk 引用，',
        '// 因此只允许在独占的构建期调用；渲染后再 append 会让已缓存的 toQuery 结果失效。',
      ]],
      [148, [
        '// STEP-3 核心渲染：逐 chunk 分派到具体分支，再合并片段。',
        '// [不变量] config 是一次性快照：函数内不改 _config，只在入口派生 inlineParams/paramStartIndex；',
        '// 递归必须传同一份（或其副本），否则各子树会各自从 0 编号。',
        '// [权衡] 用运行时 is() 判别而非给 chunk 类加 render 方法：渲染依赖方言配置，',
        '// 挂到类上会让 sql/ 反向依赖方言类型，形成循环依赖。',
      ]],
      [176, [
        '// 数组语义是"值列表"：自动补括号并以 ", " 连接，即 sql`in (${[1,2]})` 的展开规则。',
        '// [权衡] 不递归拍平嵌套数组：嵌套应显式用 sql.join，否则分隔符语义不可预测。',
      ]],
      [195, [
        '// 表名渲染：非别名表带 schema 前缀，别名表只用自身名字。',
        '// [不变量] 别名一旦设置（IsAlias）必须吞掉 schema，否则 `schema."t" as "a"` 会渲染成',
        '// `schema."a"`，在多 schema 库里指向不存在的表。',
      ]],
      [206, [
        '// 列名默认带表限定（`t"."c`），避免 join 后同名列歧义。',
        '// [权衡] invokeSource === "indexes" 时去掉表前缀：索引定义不允许出现表限定名，',
        '// 否则 CREATE INDEX 会被数据库拒绝；该分支只允许索引构建器触发。',
        '// [不变量] 列名必须经 casing 缓存求值，直接读列对象上的名字会绕开命名策略。',
      ]],
      [233, [
        '// STEP-4 参数分派：值先经 encoder 映射成驱动值（列类型可把 Date 变成字符串/数字）。',
        '// [不变量] 内联模式不占参数位、直接内联；绑定模式必须 escapeParam 且同步推 typings。',
        '// [失败路径] encoder 抛错即向上冒泡，本层不兜底：错误的编码结果比失败更难排查。',
      ]],
      [248, [
        '// typings 与 params 等长：驱动据此决定是否做 JSON/日期解码；prepareTyping 缺失时降级为 "none"。',
      ]],
      [256, [
        '// 占位符渲染期不解析：按参数位输出并把 Placeholder 本身放进 params，执行前由 fillPlaceholders 替换；',
        '// 编号必须与普通 Param 共用同一条 paramStartIndex。',
      ]],
      [264, [
        '// 子查询两形态：WITH 里已命名的只输出别名；否则渲染成 `(子查询) "别名"`.',
        '// [不变量] 括号与尾随空格是语义的一部分：少了空格会与后续 token 粘连。',
      ]],
      [276, [
        '// PG 枚举是"名字"而非参数（有独立的 CREATE TYPE），渲染成带 schema 的标识符；',
        '// 放在 SQLWrapper 兜底之前，避免被当成表达式多包一层括号。',
      ]],
      [283, [
        '// 兜底的可渲染对象：默认包括号保证运算优先级；只有自身已是原子表达式时实现方才应',
        '// 让 shouldOmitSQLParens() 返回 true。',
      ]],
      [302, [
        '// 内联规则：null → 字面 null；number/boolean → toString；string → escapeString；对象先试 toString，',
        '// 退化到 JSON.stringify。',
        '// [失败路径] 循环引用等序列化失败必须抛错：写成 [object Object] 会产出语法正确但语义错误的 SQL。',
      ]],
      [349, [
        '// 只影响"驱动 → 应用"的读回方向，不影响发送；可传对象或单个函数。',
        '// [不变量] 就地改 this.decoder 并返回 this：链式调用共享实例，不要在多个查询间复用同一 SQL 后改 decoder。',
      ]],
      [478, [
        '// STEP-0 模板标签：strings 与 params 交错拼成 chunks，仅在首段非空时省略它。',
        '// [不变量] strings[i] 与 params[i] 严格交替，末尾必有 strings[len(params)]；',
        '// 中间的空白段必须保留，否则相邻参数会失去分隔。',
        '// [权衡] 实现签名用 any[] 而非 SQLChunk[]：运行时用户传的是原始值，',
        '// FakePrimitiveParam 只存在于类型层。',
      ]],
      [528, [
        '// join 只插分隔符、不包括号：括号语义由调用方决定（IN 列表的括号来自数组分派）。',
        '// [不变量] 分隔符与元素同权重参与渲染：若分隔符是 Param，它会额外占用参数位并推进编号。',
      ]],
      [612, [
        '// STEP-5 执行前填充：把 params 中的 Placeholder 换成实参。',
        '// [失败路径] 缺值直接抛错：未填占位符会以错误参数执行，静默用 undefined 更危险。',
        '// [不变量] Param 包着的 Placeholder 必须先过 encoder 再替换，保证与普通参数的驱动值形态一致。',
      ]],
      [709, [
        '// Column/Table/Subquery 的 getSQL 在这里补挂：三者都在本文件之前定义，',
        '// 写进类里会形成 sql.ts ↔ table.ts 的循环依赖。',
        '// [权衡] 牺牲"定义处可见"换取模块图无环；子类覆写时必须仍返回 SQL。',
      ]],
    ],
  },
  {
    file: 'drizzle-orm/src/sql/index.ts',
    inserts: [[1, [
      '// sql/ 的公共出口：表达式构造器、SQL 函数与 SQL 片段代数一并导出，',
      '// 上层只从这里取，不直接引用子文件，避免内部文件改名时四处漏改。',
    ]]],
  },
  {
    file: 'drizzle-orm/src/primary-key.ts',
    inserts: [[1, [
      '// 主键抽象：只持有表与列列表，不参与渲染。真正生成 `PRIMARY KEY (...)` 的是各方言 dialect 的',
      '// createTable 分支——它们读的正是 columns 的顺序。',
      '// [不变量] columns 顺序即 DDL 中的列顺序，复合主键的语义依赖它。',
    ]]],
  },
  {
    file: 'drizzle-orm/src/view-common.ts',
    inserts: [[1, [
      '// 视图配置的全局 Symbol：独立成文件是为了让 table.ts / sql.ts / 各方言 view.ts 共享同一符号，',
      '// 又不把任何一个实现模块拖进彼此的依赖图。',
    ]]],
  },
  {
    file: 'drizzle-orm/src/batch.ts',
    inserts: [[1, [
      '// 批量查询的类型层：BatchItem 约束元素必须是可 prepare 的 RunnableQuery，',
      '// BatchResponse 用映射类型按元组位置取出各自的 result。',
      '// [不变量] 返回类型与传入数组等长同序——驱动按顺序回包，类型若收成联合会丢失位置对应关系。',
    ]]],
  },
  {
    file: 'drizzle-orm/src/runnable-query.ts',
    inserts: [[1, [
      '// 可执行查询的最小契约：方言标记 + 结果类型 + _prepare()。',
      '// [资源] _prepare 返回的 PreparedQuery 持有驱动的语句句柄，生命周期由 session/驱动管理；',
      '// 本接口不承诺可重入——重复 prepare 是否复用缓存取决于方言实现。',
    ]]],
  },
];

for (const { file, inserts } of ops) {
  const p = REPO + file;
  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split('\r\n');
  inserts.sort((a, b) => b[0] - a[0]);
  for (const [lineNo, commentLines] of inserts) {
    const idx = lineNo - 1;
    if (idx < 0 || idx > lines.length) throw new Error(`${file}: line ${lineNo} out of range`);
    lines.splice(idx, 0, ...commentLines);
  }
  fs.writeFileSync(p, lines.join('\r\n'), 'utf8');
  console.log(`${file}: +${inserts.reduce((a, b) => a + b[1].length, 0)}`);
}
