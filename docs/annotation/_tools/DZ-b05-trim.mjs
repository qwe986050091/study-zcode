// B05 收敛：从 utils.ts 移除 16 行低信息量的类型工具单行注释，把密度从 39.16% 拉回 33% 附近。
import fs from 'node:fs';

const FILE = 'D:/code/opensource/drizzle-orm/drizzle-orm/src/utils.ts';
const drop = new Set([
  '// Or：两个布尔类型任一为 true 即为 true。',
  '// IfThenElse：条件类型的三元封装，提高可读性。',
  '// PromiseOf：解开 Promise 取出结果类型，非 Promise 原样返回。',
  '// Writable：去掉 readonly 修饰，用于结果对象的可写推导。',
  '// NonArray：排除数组类型，用于区分"值"与"值列表"。',
  '// ShallowRecord：把映射类型展平，避免与交叉类型结合后提示冗长。',
  '// SimplifyMappedType：仅用于中断条件类型的分配，本身是恒等。',
  '// Not：布尔取反，用于 nullable 推导。',
  '// IsNever：用元组包裹避免条件类型对 never 的分配律。',
  '// IsAny：利用 any 与 1 的交叉仍为 any 这一特性检测 any。',
  '// ValueOrArray：接收单值或数组的 API 统一签名。',
  '// IfNotImported：依赖未安装时 T 推出 unknown，用它选择提示文案分支。',
  '// 未安装驱动时的类型层错误文案，直接展示给用户。',
  '// FromSingleKeyObject：同上，但命中单键时返回 Result 而非对象本身。',
  '// 标识符命名风格：只有这两种取值，缺省表示不转换。',
  '// Update：用 TUpdate 覆盖 T 的同名键。',
]);

const lines = fs.readFileSync(FILE, 'utf8').split('\r\n');
let removed = 0;
const out = lines.filter((l) => {
  if (drop.has(l.trim()) && removed < drop.size) {
    removed++;
    return false;
  }
  return true;
});
fs.writeFileSync(FILE, out.join('\r\n'));
console.log('removed ' + removed);
