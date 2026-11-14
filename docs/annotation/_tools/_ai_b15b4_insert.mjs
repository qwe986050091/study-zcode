import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/ui/validate-ui-messages.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const text = [
  '// 【坑】两点最容易踩：',
  '//   1) 这个文件有两套表达同一结构的 schema（dynamic-tool 与 tool-*），',
  '//      改字段必须成对改，否则同一条历史消息在校验前后会得到不同结论；',
  '//   2) 校验会就地替换 parts 里的元素（降级为 dynamic-tool），调用方若',
  '//      缓存了 part 引用，会看到"对象还在但类型变了"的怪现象。',
  '//',
  '// 【失败路径】所有失败都以返回值或异常两种形式之一暴露，不存在"静默修正"',
  '//   除外的处理；唯一的自动修正就是终态工具的降级，且会打上不可用标记。',
];

const hits = lines.reduce((acc, l, i) => (l.includes('// 【不变量】') ? [...acc, i] : acc), []);
if (hits.length !== 1) {
  console.error('HITS ' + hits.length);
  process.exit(1);
}

lines.splice(hits[0], 0, ...text);
fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', text.length);
