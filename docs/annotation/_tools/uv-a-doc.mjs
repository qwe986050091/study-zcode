import fs from 'node:fs';

const body = fs.readFileSync('d:/code/_annot_baseline/uv-rework/a-table-203.md', 'utf8').trim().split(/\r?\n/);
const rows = body.slice(2);
const hdr = `# A 类 458 行：203 处字符串与总述台账

> 生成：\`d:/code/_annot_baseline/uv-a-table.mjs\`（输入 \`a-spans.json\` / \`a-plan.json\` + 当前工作树）。本表是 \`UNCOVERED 458\` 与「A 类 = 不可逐行注」的唯一台账，报告里的概括以本表为准。
>
> 定义：A 类 = 产品代码口径下未覆盖、且行首落在多行字符串内的 458 行（\`uv-prod-classify\` 的 \`A_inString\`）。逐行插 \`//\` 会改变运行内容（\`inStringAdd != 0\`），所以改为「每处在字符串外一行总述」。
>
> 列：\`区间\` 为当前工作树行号；\`行数\` 是该处落在字符串内且未覆盖的行数；\`总述行号\` 是字符串所属语句/属性紧邻注释块的块首行；\`来源\` 为「本次新增」（4.40 的 13 处）或「既有」（190 处）。
>
> 抽检：按 203 处顺序每 10 处取 1（第 0/10/.../190 处）共 20 处，逐处读总述并对照字符串：**0 处不成立**。其中 3 处（\`uv-pep508/src/lib.rs\`、\`uv-settings/src/settings.rs\` ×2）若只读「3 行窗口内的那一行」会得到块末断句或空 \`///\`，属窗口伪影，读紧邻注释块后均成立。全量 203 处按紧邻注释块重扫发现 1 处真不成立（\`uv-lock/src/lock/mod.rs\` 的 \`ConflictingExtra\`，窗口取到的是上一个变体的字段注释），已补一行。
>
> 合计：203 处 / 458 行；190 处既有 + 13 处本次新增。

| # | 文件 | 区间 | 行数 | 总述行号 | 来源 | 总述（首行） |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`;
fs.writeFileSync('d:/code/opensource/uv/docs/annotation/a-class-458-spans.md', hdr, 'utf8');
console.log('rows=' + rows.length);
