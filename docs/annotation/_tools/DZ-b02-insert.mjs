// B02 插入脚本：按 1-based 行号在目标行前插入整行 // 注释，倒序应用，保持 CRLF。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/drizzle-orm';

const plan = {
  'drizzle-orm/src/alias.ts': [
    [1, [
      '// 表 / 列 / 关系的别名代理层：用 Proxy 把物理对象包装成另一个逻辑名，',
      '// 供自连接、子查询、CTE 与 relations 查询共享同一份元数据而不复制结构。',
      '// 链路位置：query-builders 调用 aliasedTable/aliasedTableColumn；relations 走 aliasedRelation。',
      '//',
      '// INV-01：列代理读 table 必须返回带别名的表代理，否则 SQL 限定符退回原表名。',
      '// INV-02：IsAlias/Name/OriginalName/Columns 四类 Symbol 随别名同步改写。',
      '// INV-03：Columns 每次重新构造，禁止把上一次的别名结果缓存回原表。',
      '// INV-04：SQL 树中的列引用必须递归替换，含嵌套 SQL 与 SQL.Aliased。',
      '// 守住位置：INV-01/02 在 TableAliasProxyHandler.get；INV-04 在 mapColumnsInSQLToAlias。',
    ]],
    [10, [
      '// 列级代理：仅覆写 table 读取，其余属性原样透传，保证列对象身份语义不变。',
      '// [权衡] 用 Proxy 而非克隆：克隆会切断与列上自定义 Symbol 元数据的引用一致性。',
    ]],
    [15, [
      '// STEP-1 命中 table 时返回外层别名表；STEP-2 其余属性原样透传，不做深拷贝。',
      '// [不变量] 此处不拦截写入；别名对象只读，写操作会穿透到原表。',
    ]],
    [24, [
      '// 表/视图级代理：按属性名分派到别名语义，未命中则透传原值。',
      '// 复用方：aliasedTable（replaceOriginalName=false）与列代理内部构造的别名表。',
    ]],
    [29, [
      '// 分支顺序即优先级：IsAlias → Name → OriginalName → ViewBaseConfig → Columns。',
      '// 越靠前的越是结构标识，放到后面会被通用透传分支提前吞掉。',
    ]],
    [50, [
      '// 列集合分支：逐列包一层 ColumnAliasProxyHandler，并把 table 指向本次别名表。',
      '// [资源] 每次读取都新建 Proxy 对象，故不可在热路径反复访问 Columns。',
    ]],
    [68, [
      '// 普通属性透传；若值本身是列则升级为别名列，保证 orderBy/where 中的列同样带别名。',
      '// [失败路径] 非列对象按原值返回，调用方仍需自行判断是否为 SQL 片段。',
    ]],
    [77, [
      '// 关系级代理：仅改 sourceTable 指向别名表，字段映射与目标表保持原样。',
      '// 这样同一关系可同时用于原表与别名表的多条 join 分支。',
    ]],
    [82, [
      '// [不变量] sourceTable 每次读取都重新包一层代理，避免别名互相覆盖。',
    ]],
    [91, [
      '// 对外入口：replaceOriginalName=false，保留 OriginalName 供迁移/诊断使用。',
      '// [权衡] 保留原表名可让错误信息指向真实表，但要求下游用 Name 而非 OriginalName 做限定。',
    ]],
    [98, [
      '// 对外入口：关系别名，等价于给 sourceTable 换名。',
    ]],
    [102, [
      '// 列别名入口：表别名与列别名必须成对构造，只改列仍会指向原表。',
      '// [不变量] 传入列必须已有 table，否则 Proxy 读 table 时拿到 undefined。',
    ]],
    [109, [
      '// SQL.Aliased 改写：只替换内部 sql，保留 fieldAlias（输出列名不受别名影响）。',
    ]],
    [113, [
      '// STEP-1 遍历 queryChunks 逐块判型；',
      '// STEP-2 列→别名列，SQL→递归，SQL.Aliased→走上一函数，其余原样保留；',
      '// STEP-3 用 sql.join 重组，保持原有分隔符语义。',
    ]],
  ],
  'drizzle-orm/src/entity.ts': [
    [1, [
      '// 实体身份识别：以 Symbol.for 注册的全局 Symbol 作类令牌，替代 instanceof。',
      '// 动机：monorepo 内多份包实例（重复安装、ESM/CJS 双载）时 instanceof 会因',
      '// 构造器引用不同而失效，Symbol.for 走全局注册表故跨实例稳定。',
      '//',
      '// INV-01：每个 Drizzle 实体类必须自带 entityKind 静态属性，否则 is() 抛错而非返回 false。',
      '// INV-02：判定先走 instanceof 快速命中，再沿原型链比对 entityKind 兜住跨实例场景。',
      '// 守住位置：INV-01 在 hasOwnProperty 检查；INV-02 在原型链 while 循环。',
    ]],
    [12, [
      '// [权衡] 不缓存判定结果：实体类可被 Proxy 包装（见 alias.ts），缓存会误伤动态别名。',
      '// [失败路径] 非对象直接 false；传入未标记的类则抛错，把编程错误暴露在开发期。',
    ]],
  ],
  'drizzle-orm/src/session.ts': [
    [3, [
      '// 预编译查询契约：getQuery 供日志/重放，mapResult 归一化驱动返回值，isFromBatch 区分批量与单条的结果形态。',
    ]],
  ],
  'drizzle-orm/src/query-promise.ts': [
    [3, [
      '// 惰性查询 Promise：构造时只登记查询，真正执行发生在 then/catch/finally 首次订阅时。',
      '// 链路位置：db.select()/insert()/execute() 的返回类型都继承它，execute 由 session 层实现。',
      '// INV-01：execute() 必须可重入——同一 thenable 可被多次 await，结果复用由 session 决定。',
      '// INV-02：then 是唯一执行入口，catch/finally 只能经 then 派生，不能绕过执行。',
    ]],
    [8, [
      '// catch 派生自 then，保证"只订阅 catch"也会触发 execute。',
    ]],
    [14, [
      '// finally 需在成功/失败两条分支都回调，且不吞掉原值/原错误。',
    ]],
    [27, [
      '// [并发] 每次 then 都会调用 execute()，是否合并同一查询由 session 的 promise 缓存决定。',
      '// [失败路径] 拒绝原因原样透传，包装成 DrizzleQueryError 的动作在 session 层完成。',
    ]],
    [34, [
      '// 子类实现的真实执行点：返回驱动原始 Promise 的结果。',
    ]],
  ],
  'drizzle-orm/src/errors.ts': [
    [1, [
      '// 错误层：把驱动/SQL 层失败统一成可判别的错误类型，供上层做重试与事务回滚判断。',
      '// 链路位置：session 捕获驱动异常后包成 DrizzleQueryError 抛出。',
      '// INV-01：所有错误类都带 entityKind，跨包实例可用 is() 判别而非 instanceof。',
    ]],
    [6, [
      '// cause 单独保存为字段（不依赖 ES2022 Error.cause），兼容旧 target 的编译产物。',
      '// [权衡] name 显式赋值为类名，保证序列化/日志里不显示笼统的 "Error"。',
    ]],
    [13, [
      '// 查询失败载体：保留原始 SQL 与参数，便于定位是语句问题还是绑定问题。',
    ]],
    [19, [
      '// [失败路径] message 内联 SQL 与参数；captureStackTrace 移除本帧，堆栈从调用点起算。',
    ]],
    [22, [
      '// [资源] 手动赋 cause 而非走 super 传参，兼容不支持 Error options 的运行环境。',
    ]],
    [27, [
      '// 回滚哨兵错误：仅用于事务内控制流（catch 后决定 commit 还是 rollback），不直接面向用户。',
    ]],
  ],
  'drizzle-orm/src/logger.ts': [
    [1, [
      '// 日志接口层：session 在执行前调用 logQuery，实现可替换（控制台/自定义 writer/静默）。',
      '// [并发] 实例被同进程所有连接共享，实现须无状态或自行同步，禁止缓存上一条查询。',
    ]],
    [3, [
      '// 最小日志契约：只接收最终 SQL 与参数数组，不暴露 session 内部结构。',
    ]],
    [7, [
      '// 输出通道抽象，便于把日志接到文件或结构化采集而非 stdout。',
    ]],
    [11, [
      '// 默认写入器：直接 console.log，保证零配置可用。',
    ]],
    [19, [
      '// 组合式默认实现：格式化交给 Logger，输出交给 LogWriter。',
    ]],
    [24, [
      '// [权衡] writer 允许注入但不可为空，构造期即完成绑定，避免运行期判空分支。',
    ]],
    [28, [
      '// STEP-1 逐个 JSON.stringify 参数；STEP-2 失败回退 String；STEP-3 拼接后交给 writer。',
    ]],
    [29, [
      '// [失败路径] 循环引用/BigInt 会让 stringify 抛错，回退 String 保证日志不中断查询。',
    ]],
    [36, [
      '// [不变量] 无参数时不输出 "-- params: []"，避免日志噪声与误判。',
    ]],
    [41, [
      '// 静默实现：用于基准测试与关闭日志的生产配置，保持接口一致。',
    ]],
  ],
};

for (const [rel, inserts] of Object.entries(plan)) {
  const file = path.join(REPO, rel);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('\r\n')) throw new Error('not CRLF: ' + rel);
  const lines = text.split('\r\n');
  const sorted = [...inserts].sort((a, b) => b[0] - a[0]);
  for (const [lineNo, comments] of sorted) {
    lines.splice(lineNo - 1, 0, ...comments);
  }
  fs.writeFileSync(file, lines.join('\r\n'));
  const added = inserts.reduce((n, x) => n + x[1].length, 0);
  console.log(`${rel} +${added}`);
}
