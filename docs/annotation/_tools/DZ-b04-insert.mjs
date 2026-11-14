// B04 插入脚本：column / column-builder / casing / subquery / operations / migrator。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/drizzle-orm';

const plan = {
  'drizzle-orm/src/column.ts': [
    [1, [
      '// 列（Column）基类与类型层契约：把建表期的 ColumnBuilder 配置落成运行期可渲染的列对象。',
      '// 链路位置：column-builder 的 BuildColumn 按方言产出具体列类 → 本文件定义公共基类 →',
      '// sql/ 渲染列名与占位符 → 方言 dialect 用 getSQLType() 生成 DDL。',
      '//',
      '// INV-01：Column 只接受完整配置；部分配置的推断一律用 AnyColumn，两者不可混用。',
      '// INV-02：name/notNull/primary/default 等在构造期一次性快照，之后只读。',
      '// INV-03：列名与表名的映射由 CasingCache 负责，列对象自身不感知 casing 策略。',
    ]],
    [13, [
      '// 列配置基线：方言列类型在其上追加自己的运行时配置（精度、长度、枚举值等）。',
      '// [不变量] notNull/hasDefault/isPrimaryKey 等布尔位是类型层推导的输入，',
      '// 一旦与运行期 config 不一致，insert/select 模型就会与实际 DDL 脱节。',
    ]],
    [25, [
      '// 对外暴露的类型配置（即 column[\'_\']）：逐字段从 ColumnBaseConfig 复制，',
      '// 目的是让 GetColumnData 一类工具只依赖 `_` 而不接触运行期对象。',
    ]],
    [44, [
      '// 运行期配置 = 构建器配置，二者共用同一形状，避免 build 时再做字段搬运。',
    ]],
    [49, [
      '// 接口与类同名合并：接口只描述类型层（data ↔ driverParam 映射 + SQLWrapper），',
      '// 运行实现全部在下面的抽象类里。',
    ]],
    [63, [
      '// 列基类：所有方言列（PgColumn/MySqlColumn/SQLiteColumn/SingleStoreColumn/GelColumn）都继承它。',
      '// 构造期把 builder 的 config 摊平成只读字段，查询构建阶段只读这些字段。',
      '// [不变量] this.config 保留原始引用（protected），供 shouldDisableInsert 等内部判断使用。',
    ]],
    [91, [
      '// STEP-1 config 原样保存；STEP-2 逐字段拷贝到只读属性（浅拷贝，列选项对象不复制）。',
      '// [权衡] 不做深拷贝：枚举值等选项在方言层是常量，复制只会增加内存。',
    ]],
    [113, [
      '// 方言 DDL 类型串（如 "varchar(255)"）：只由方言列类实现，基类不给默认值。',
    ]],
    [115, [
      '// 驱动值 → 应用值：默认恒等，日期/JSON/自定义类型在方言列里覆写。',
    ]],
    [119, [
      '// 应用值 → 驱动值：默认恒等；必须与上一个方法成对覆写，否则往返会失真。',
    ]],
    [123, [
      '// 生成列（GENERATED ALWAYS AS）在 insert 时必须跳过，否则数据库报错。',
      '// [不变量] 仅 generated.type !== \'byDefault\' 才禁用；byDefault 允许显式写入。',
    ]],
    [129, [
      '// 类型工具：用 Partial 配置覆盖完整列配置。',
    ]],
    [134, [
      '// 部分配置的列类型：泛型参数是"待覆盖的字段"，其余字段取基类默认值。',
    ]],
    [138, [
      '// 读取列的应用层类型：query 模式下 notNull=false 补 null，raw 模式返回底层类型。',
      '// [不变量] 这是 ORM 结果类型的唯一来源，不要在别处手写 data | null。',
    ]],
    [146, [
      '// 表列集合 → 行类型：逐列套 GetColumnData(\'query\')。',
    ]],
  ],
  'drizzle-orm/src/column-builder.ts': [
    [1, [
      '// 列构建器类型层：定义"列配置在 build 前"的形状，并经 BuildColumn 映射成各方言列类。',
      '// 链路位置：方言 columns/*.ts 继承 ColumnBuilder → 方言 table() 调 BuildColumns →',
      '// BuildColumn 按 Dialect 选出 PgColumn/MySqlColumn/SQLiteColumn/SingleStoreColumn/GelColumn。',
      '//',
      '// INV-01：builder 的 `_` 是唯一类型载体，运行期 config 必须能承载 `_` 推出的形状。',
      '// INV-02：链式方法只改 config 并返回交叉类型，不产生新的类实例。',
      '// INV-03：BuildColumn 的方言分支必须与 Dialect 联合穷尽对应，缺一支即推导成 never。',
    ]],
    [11, [
      '// 应用层数据类型：决定 data/driverParam 的默认映射，与物理类型无关（后者由 getSQLType 决定）。',
    ]],
    [28, [
      '// 方言标识：BuildColumn / BuildColumns / ChangeColumnTableName 用它做类型分派。',
    ]],
    [30, [
      '// 生成列的存储方式：virtual 不落盘、stored 落盘，仅 SQLite/PG 的部分方言支持。',
    ]],
    [34, [
      '// 生成列配置：as 可为值、SQL 或惰性 SQL 工厂，工厂形态用于引用同表其他列。',
      '// [不变量] type 缺省等价于 \'always\'（数据库 12+ 的默认语义）。',
    ]],
    [40, [
      '// 标识列（Gel/PG identity）：sequenceName 与 sequenceOptions 交由方言生成 DDL。',
    ]],
    [46, [
      '// 构建器的最小配置：name/dataType/columnType 三要素 + 数据与驱动参数类型。',
      '// [不变量] enumValues 只有枚举列有值，其余保持 undefined，不能退化成空数组。',
    ]],
    [55, [
      '// 把 builder 的 `_` 铺平成列配置：表名由 BuildColumns 注入，其余字段透传。',
      '// [不变量] data 优先取 $type 覆盖，其次才是 data —— 这就是 $type() 影响结果类型的路径。',
      '// baseColumn 仅当 builder 带 baseBuilder 时存在（如 PG 的 serial 基于 integer）。',
    ]],
    [81, [
      '// builder 的类型配置：与 ColumnTypeConfig 的区别是 notNull/hasDefault 等可能还未确定，',
      '// 因此用条件类型回退成 boolean，待链式方法收窄。',
    ]],
    [102, [
      '// 运行期配置：构造时写入，链式方法就地修改；字段集合与 Column 的只读属性一一对应。',
    ]],
    [120, [
      '// 方言专属的附加开关：如 SQLite 的主键隐含默认值，用来调整 primaryKey() 的返回类型。',
    ]],
    [124, [
      '// 以下五个类型工具都只"追加 `_` 上的一个标记"，用于把链式调用的效果带进类型推导。',
    ]],
    [130, [
      '// default/$defaultFn 都会置 hasDefault=true，但对 insert 模型的影响不同（前者静态、后者运行期）。',
    ]],
    [136, [
      '// primaryKey 同时隐含 notNull，因此类型上是 IsPrimaryKey<NotNull<this>> 的叠加。',
    ]],
    [142, [
      '// autoincrement 只影响 DDL 与 insert 默认值，不改变可空性。',
    ]],
    [148, [
      '// 有运行期默认值的列在 insert 时可省略，但数据库侧没有 DEFAULT 子句。',
    ]],
    [154, [
      '// $type：仅改写 `_` 上的 $type，不触碰 data/driverParam 的映射。',
      '// [权衡] 品牌类型靠它实现，代价是运行期完全无校验。',
    ]],
    [160, [
      '// 生成列必然有默认值（由表达式产生），故同时置 hasDefault=true。',
    ]],
    [167, [
      '// 标识列：隐含 notNull + hasDefault + identity 三标记，用于 insert 跳过与 DDL 生成。',
    ]],
    [177, [
      '// 构建器接口：只暴露 `_`，使一切类型推导都基于纯类型信息。',
    ]],
    [184, [
      '// 构建器基类：链式 API 的最终实现点；config 在构造时给定默认值。',
      '// [不变量] keyAsName = (name === \'\')：列名留空时，表定义阶段用对象键名回填。',
    ]],
    [197, [
      '// 构造只登记 name/dataType/columnType，其余开关保持"未设置"的保守默认值。',
    ]],
    [214, [
      '// $type 覆盖应用层类型，常用于 json 列与品牌类型。',
    ]],
    [225, [
      '// 只改 `_` 上的 $type，运行期 config 不变。',
    ]],
    [234, [
      '// notNull 同时影响 select 模型的 nullable 与 DDL 的 NOT NULL。',
    ]],
    [246, [
      '// 静态默认值：写入 config.default 并标记 hasDefault，使 insert 模型可选。',
    ]],
    [258, [
      '// 运行期默认值：函数在插入时调用，不进入 drizzle-kit 的 DDL。',
    ]],
    [278, [
      '// 运行期更新值：仅在 update 未显式给值且无默认值时兜底。',
    ]],
    [296, [
      '// 主键隐含 notNull；TExtraConfig 为 true 的方言（SQLite 整数主键）额外带回 hasDefault。',
      '// [失败路径] 复合主键不允许在此声明，需走 table 级的 primaryKey()。',
    ]],
    [305, [
      '// 生成列在方言层实现：基类只声明签名，保证所有方言都有同一入口。',
    ]],
    [312, [
      '// 表定义阶段回填列名：仅当 name 为空串时生效，故可安全重复调用。',
    ]],
    [319, [
      '// Builder → Column 的核心映射：按 Dialect 选出具体列类，并把剩余类型参数 Omit 掉。',
      '// [不变量] 必须 Omit brand/dialect 以及 config 已覆盖的键，否则交叉类型会冲突。',
      '// [权衡] 用条件类型链而非映射表：保持零运行期成本，但每加一个方言就要加一支。',
    ]],
    [373, [
      '// extraConfig 里的列引用：只有 PG/Gel 有可链式追加的索引列类型（asc/desc/op）。',
    ]],
    [386, [
      '// 建表入口的类型层：逐键 BuildColumn，并在 name 为空时用键名 Assume 成字符串字面量。',
    ]],
    [400, [
      '// extraConfig 列的映射：只按方言给出可参与索引声明的列类型。',
    ]],
    [410, [
      '// 表别名化时把列改挂到新表名：只换 tableName，其余配置原样保留。',
    ]],
  ],
  'drizzle-orm/src/casing.ts': [
    [1, [
      '// 标识符命名风格转换（snake_case / camelCase）与进程内缓存。',
      '// 链路位置：方言 dialect 在渲染列名/表名时读 CasingCache → 结果进入 SQL 文本。',
      '// [不变量] 转换只发生在 DB 标识符上，不影响 JS 侧的 tsName（用户对象键）。',
      '// [并发] 缓存挂在 db 实例上，单线程内共享；跨实例不共享，故无需跨线程同步。',
    ]],
    [6, [
      '// snake_case：按"数字串 / 连续大写 / 驼峰词"切词后小写并用下划线连接。',
      '// [权衡] 用正则切词而非逐字符状态机：可读性优先，且大小写缩略词（HTTPServer）处理正确。',
    ]],
    [7, [
      '// 先去掉撇号再切词，避免 \'s 这类所有格被拆成独立词。',
    ]],
    [14, [
      '// camelCase：与 snake_case 共用切词规则，仅连接方式不同。',
    ]],
    [19, [
      '// 首词全小写，其余词首字母大写，保持原始大小写形态。',
    ]],
    [25, [
      '// 未配置 casing 时的恒等转换，保证调用方无需判空。',
    ]],
    [29, [
      '// 列名/表名转换缓存：column 级别的查询每次都走这里，故必须 O(1)。',
    ]],
    [33, [
      '// cache 键为 schema.table.column；cachedTables 记录已整体铺开的表，避免重复遍历列。',
    ]],
    [37, [
      '// 构造期固定转换函数，之后不可变；非法 casing 值退化为恒等。',
    ]],
    [45, [
      '// 列名是否需要转换只由 keyAsName 决定：显式命名的列按用户写法原样输出。',
      '// [不变量] schema 缺省为 public，保证不同 schema 下的同名表不会共用缓存键。',
      '// [失败路径] 缓存未命中时先铺整表再取；若仍缺失说明列不属于该表，返回 undefined 会被断言拦下。',
    ]],
    [58, [
      '// 整表铺开：一次遍历列集合，把每个列名转换结果写入缓存并标记表已处理。',
    ]],
    [72, [
      '// 清空缓存：schema 变更或迁移后调用，避免旧标识符残留。',
    ]],
  ],
  'drizzle-orm/src/subquery.ts': [
    [1, [
      '// 子查询与 CTE（WITH）的载体：包装一段 SQL 并附带别名与选中字段类型。',
      '// 链路位置：query-builders 的 as() 构造 Subquery → sql/ 渲染时按 alias 输出别名。',
    ]],
    [4, [
      '// 接口仅承载类型参数，运行实现见下方类；SQLWrapper 由 sql/sql.ts 在运行期补齐。',
    ]],
    [12, [
      '// 子查询类：`_` 上的字段全部只读，渲染只依赖 sql 与 alias。',
      '// [不变量] usedTables 供日志与依赖收集，不参与渲染。',
    ]],
    [18, [
      '// isWith 区分 CTE 与普通子查询：CTE 需要提前声明 WITH 子句，普通子查询内联即可。',
    ]],
  ],
  'drizzle-orm/src/operations.ts': [
    [1, [
      '// 写操作（insert/update）的键分类工具：把表列集合拆成"必填键"与"可选键"。',
      '// 链路位置：query-builders/insert|update 的 values()/set() 参数类型由这里推导。',
      '// [不变量] 必填 = notNull && !hasDefault；生成列与 identity 列在 insert 中不可写。',
    ]],
    [6, [
      '// 必填键：非空且无默认值，insert 时必须提供。',
    ]],
    [12, [
      '// 可选键：排除必填键后，再按 generated/identity 细分。',
      '// [失败路径] 生成列与 identity always 一律为 never，从类型层禁止写入。',
    ]],
    [27, [
      '// 扁平选择字段：允许列、SQL 表达式、别名 SQL 与子查询。',
    ]],
    [32, [
      '// 不含子查询的扁平选择：用于 union/except 等要求形状一致的场景。',
    ]],
    [37, [
      '// 选择字段：扁平字段之外还允许整表（展开为全部列）与嵌套对象。',
    ]],
    [42, [
      '// 排序后的选择项：path 记录输出键路径，field 是待渲染的表达式，供行还原按下标对齐。',
      '// [不变量] 数组顺序即 SQL 选择列顺序，任何重排都会破坏 mapRelationalRow 的下标契约。',
    ]],
  ],
  'drizzle-orm/src/migrator.ts': [
    [1, [
      '// 迁移文件读取器：解析 drizzle-kit 生成的 meta/_journal.json 与逐条 .sql 文件。',
      '// 链路位置：方言 migrator 在 migrate() 开始时调用它，得到按 journal 顺序排列的迁移列表。',
      '// 产出 MigrationMeta：拆分后的 SQL 语句数组 + 时间戳 + sha256 hash + breakpoints 标记。',
      '// [资源] 同步读文件（CLI/启动期），不缓存、不持有句柄；调用方负责按序执行。',
      '// [失败路径] journal 缺失、某条 .sql 缺失均抛错，禁止跳过——跳过的迁移会破坏 hash 链。',
    ]],
    [4, [
      '// drizzle.config.ts 中与迁移相关的最小配置（out 目录、schema 入口）。',
    ]],
    [9, [
      '// 迁移运行参数：目录必填，表名与 schema 可覆盖默认的 __drizzle_migrations。',
    ]],
    [15, [
      '// 单条迁移的运行期形态：sql 已按 statement-breakpoint 切分，bps 决定是否按断点逐条执行。',
    ]],
    [22, [
      '// 读取入口：journal 决定顺序，缺文件即失败（fail-closed）。',
    ]],
    [27, [
      '// journal 是迁移顺序的唯一来源；不存在说明项目从未生成过迁移。',
    ]],
    [34, [
      '// entries 按 idx 递增写入，读取时保持原序，不做排序。',
    ]],
    [38, [
      '// 按 journal 顺序逐条读取，顺序即执行顺序。',
    ]],
    [41, [
      '// 单条迁移：整文件读入后按断点切分，hash 基于原始全文而非切分结果。',
    ]],
    [44, [
      '// 断点标记由 drizzle-kit 写入；split 后不 trim，保留文件原始排版。',
    ]],
    [54, [
      '// [失败路径] 读失败统一转成带路径的错误，屏蔽 ENOENT/EACCES 的差异。',
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
