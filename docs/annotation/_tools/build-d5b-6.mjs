import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

function L(needle) {
  const hits = [];
  src.forEach((l, i) => {
    if (l.trim() === needle.trim()) hits.push(i);
  });
  if (hits.length !== 1) throw new Error(`not unique (${hits.length}): ${needle}`);
  return hits[0];
}

const defs = [
  ['impl PartialOrd for TagCompatibility {', [
    '为兼容结论提供偏序入口。',
    '[不变量] 直接复用 Ord 的实现，保证两种比较结果一致。',
    '[边界] 不存在不可比较的情况，因此永远返回 Some。',
    '[维护] 若未来引入部分不可比状态，需重新审视此处约定。',
  ]],
  ['fn cmp(&self, other: &Self) -> cmp::Ordering {', [
    '兼容结论的全序比较实现。',
    '[不变量] 兼容优先于不兼容，兼容之间比较优先级。',
    '[边界] 同为不兼容时按原因枚举顺序决定相对大小。',
    '[维护] 该顺序决定了多个候选轮子的选优结果。',
    '[不变量] 比较是传递的，可安全用于排序。',
  ]],
  ['impl TagCompatibility {', [
    '兼容结论的便捷判定方法。',
    '[不变量] 只提供「是否兼容」，不暴露内部优先级。',
    '[边界] 调用方若需要优先级应直接模式匹配。',
    '[维护] 该方法与 Ord 的兼容段语义保持一致。',
  ]],
  ['let mut tags = BTreeSet::new();', [
    '用有序集合收集全部标签，便于按优先级稳定输出。',
    '[不变量] 集合按「优先级加字符串」排序，天然去重。',
    '[边界] 优先级唯一时字符串只用于打破并列。',
    '[维护] 该集合仅用于展示，不影响内部索引结构。',
    '[权衡] 排序成本可接受，因为 Display 只在诊断时调用。',
  ]],
  ['for (_, tag) in tags.iter().rev() {', [
    '反向遍历以实现从高优先级到低优先级输出。',
    '[不变量] rev 对应优先级数值从大到小。',
    '[边界] 每行一个标签，末尾带换行。',
    '[维护] 若调整排序键，需确认反向遍历仍然表达「优先级降序」。',
  ]],
  ['use std::slice;', [
    '引入 slice 用于从单个元素构造切片。',
    '[不变量] 仅在兼容性等价测试中使用。',
    '[边界] 该导入不影响生产代码。',
  ]],
  ['use insta::{assert_debug_snapshot, assert_snapshot};', [
    '引入 insta 的两种快照断言。',
    '[不变量] debug 版本用于带引号的字符串列表。',
    '[边界] 普通版本用于 Display 输出的整段文本。',
    '[维护] 快照更新需人工确认，避免掩盖真实回归。',
    '[权衡] 内联快照免去额外文件，但会拉长源文件。',
  ]],
  ['use super::*;', [
    '导入被测模块的全部公开与私有项。',
    '[不变量] 测试直接调用 compatible_tags 与 Tags。',
    '[边界] 该导入使测试可以访问内部类型而不需额外导出。',
  ]],
];

const items = defs.map(([needle, lines]) => {
  const idx = L(needle);
  return { line: idx + 1, anchor: src[idx], lines };
});

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d5b-6.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
