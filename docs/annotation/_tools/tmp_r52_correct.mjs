// R52 断言修正：在 35 个错误出现点的原句之后插入一行「修正（键 …）：…」。
// 只增行、不改原句；沿用文件自身换行符；锚点用原句实际文本，避免行号漂移误插。
// 用法：node tmp_r52_correct.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';

const dry = process.argv.includes('--dry');
const ROOT = 'd:\\code\\opensource\\drizzle-orm\\';
const errors = JSON.parse(fs.readFileSync('R52-errors.json', 'utf8'));

const FIX = {
	'3492d44b': '「必然失败」不成立——存量行该列全非空时加 NOT NULL 可以直接成功，只有存在 NULL 行才失败。',
	'ca47596f': 'MySQL 会用隐式默认值回填存量行，ADD COLUMN ... NOT NULL 并不必然失败；此处 truncate 是保守策略。',
	'8c30760a': 'prepareMigrateConfig 与 drizzleConfigFromFile 同样读文件系统（existsSync + require），触碰文件系统的不止那三个函数。',
	'bf9f7a7e': '「只有显式 --verbose」不成立——配置文件里的 verbose 会经 raw.verbose 合入（:389），同样打开打印。',
	'3ac806d7': 'up 只重写 out 下的元数据，不连库也不读 dbCredentials；「凭据来自配置文件」只对 push/generate 成立。',
	'428f5c09': '非字符串没有单独分支——一律落到 optional/undefined 输出，0 与 false 仍会显示成未提供。',
	'ee344be6': 'host 分支并不必然缺字段——url 与 host/database 同时给全、只是 url 非法时也会走到这里。',
	'56fd8b20': 'host 分支并不必然缺字段——url 与 host/database 同时给全、只是 url 非法时也会走到这里。',
	'a691a516': '白名单只过滤列类型 import，渲染侧对未识别类型仍输出 unknown(...)（:962），该构造器不在白名单、gel-core 里也没有。',
	'49894536': '「一律用带引号字符串」不成立——cycle 输出的是无引号布尔（:584-586）。',
	'b32c4955': '「全部列重命名」不成立——只有含大小写/下划线差异的列名会变，单词列名不受 casing 影响。',
	'23e31ed8': "schema 缺省时快照键用 'public'（:713），空串只出现在 Table.schema 字段；「存空串」不能理解为键。",
	'd407b679': '「同名一律静默覆盖」不成立——索引与唯一约束撞名会 process.exit(1)（:145、:249、:321）。',
	'2d9abbdf': '「所有 SQLite 命令都无法启动」不成立——只影响 .ts schema，.js schema 与其它方言命令不受影响。',
	'9bec6b38': '「只会落到其中一组」不成立——删旧主键并新增另一组主键时两组同时非空，不一定是误判。',
	'0fcb9222': 'SingleStore 表仍有 schema 字段（:3458 传给 columnsResolver），只是改名匹配只用 name。',
	'df7ac8f3': '「只有索引名」不成立——压缩快照的 index 含 columns 与 isUnique（singlestoreSchema.ts:6-12）。',
	'aa6a11e4': '「每个分支都重新输出 GENERATED」不成立——生成列片段只在 set_generated(stored) 与 set_type 兜底分支写入。',
	'fb2f760d': '「键由 EdgeQL 文本与参数决定」不成立——键优先取 cacheConfig.tag（:164），同 tag 可命中不同语句。',
	'3d5e1dba': '「Client 只在 transaction 里用到」不成立——GelClient 联合类型（:50）与构造函数形参（:62）都用到 Client。',
	'5dba5d34': '「一律返回 this 的交叉类型」不成立——unique()/references() 返回裸 this，generatedAlwaysAs 用 as any 擦掉类型。',
	'662202af': '「键由 SQL 文本与参数决定」不成立——键优先取 cacheConfig.tag（:176/:170），同 tag 可命中不同语句。',
	'a263f222': "「一律为 never」不成立——identity 'always' 在 OverrideT=true 时进入可写类型（:29）。",
	'e3d905a9': '第四实参是 isResponseInArrayMode（数组行模式），不是 prepared 通道；与第三实参 name 类型不同，写反会编译报错。',
	'bdaab434': '「键由 SQL 文本与 params 决定」不成立——键优先取 cacheConfig.tag（:174/:202），同 tag 可命中不同语句。',
	'30b69a53': '「all/get 等语义全部在这里分流」不成立——all() 是空实现（:202），get 未定义，分流只在 execute 内。',
	'0e1815ea': '「始终是布尔」不成立——config 存在但未写 unsigned 时此处落 undefined。',
	'cedb5d54': '「一律走 sql.param」不成立——onUpdateFn 返回 SQL 时直接内联（:179-181），只有非 SQL 值才包 param。',
	'3c4524c0': '「一律通过 sql.param 绑定」不成立——onUpdateFn 返回 SQL 时直接内联（:179-181）。',
	'85131e21': '「始终重抛原始 err」不成立——rollback 自身失败时抛出的是 rollback 的错误（:287）。',
	'f5724315': '「未知键一律返回 false」不成立——已知键命中即返回 true，未知键只在无任何已知键且非空时才导致 false。',
};

const byFile = new Map();
for (const e of errors) {
	if (!FIX[e.key]) { console.log(`  ! 缺修正文案：${e.key}`); continue; }
	const f = byFile.get(e.file) ?? [];
	f.push(e);
	byFile.set(e.file, f);
}

let inserted = 0, errorsN = 0;
for (const [rel, list] of byFile) {
	const file = path.join(ROOT, rel);
	const raw = fs.readFileSync(file, 'utf8');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.split(/\r?\n/);
	list.sort((a, b) => b.line - a.line);
	let n = 0;
	for (const e of list) {
		const idx = e.line - 1;
		const actual = lines[idx];
		const head = e.seg.slice(0, 10);
		if (actual === undefined || !actual.includes(head)) {
			console.log(`  ! ${rel}#${e.line} 锚点不匹配：实际=${JSON.stringify(actual)}`);
			errorsN++; continue;
		}
		const indent = (actual.match(/^\s*/) || [''])[0];
		lines.splice(idx + 1, 0, `${indent}// 修正（键 ${e.key}）：${FIX[e.key]}`);
		n++; inserted++;
	}
	if (!dry && n > 0) fs.writeFileSync(file, lines.join(eol), 'utf8');
	console.log(`${rel}: inserted=${n}`);
}
console.log(`TOTAL inserted=${inserted} errors=${errorsN}${dry ? ' (dry)' : ''}`);
process.exit(errorsN ? 1 : 0);
