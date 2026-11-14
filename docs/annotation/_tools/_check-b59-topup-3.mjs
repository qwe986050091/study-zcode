import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "d:/code/ZCode";
const SPEC = "d:/code/_annot_baseline/ZC-deep-b59-topup-3.json";

const expected = {
  "packages/ui/src/v4/conversationTurnRenderUnits.ts": 4,
  "packages/ui/src/v4/conversationCuaGroups.ts": 3,
  "packages/desktop/scripts/mcp-apps-host-fixture/rows-main.ts": 3,
  "packages/desktop/scripts/mcp-apps-host-fixture/chain-combinations.ts": 2,
};

const forbiddenStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log("FAIL " + msg);
};
const ok = (msg) => console.log("OK   " + msg);

for (const entry of spec.files) {
  const file = entry.file;
  const want = expected[file];
  if (!want) {
    fail(`${file}: 不在预期文件列表`);
    continue;
  }
  const text = readFileSync(resolve(REPO, file), "utf8");
  const sourceLines = text.split("\n");

  let commentCount = 0;
  for (const [i, item] of entry.items.entries()) {
    const tag = `${file} item#${i + 1}`;
    if (typeof item.anchor !== "string" || item.anchor.length === 0) {
      fail(`${tag}: anchor 缺失`);
      continue;
    }
    if ("raw" in item) fail(`${tag}: 出现禁用 raw item`);
    const hits = [];
    for (let n = 0; n < sourceLines.length; n++) {
      if (sourceLines[n].trim() === item.anchor.trim()) hits.push(n + 1);
    }
    if (hits.length === 0) fail(`${tag}: anchor 未匹配 -> ${item.anchor}`);
    else if (hits.length > 1 && !item.nth) fail(`${tag}: anchor 重复 ${hits.join(",")} 且未指定 nth`);
    else if (item.nth && hits[item.nth - 1] === undefined) fail(`${tag}: nth=${item.nth} 越界`);
    else ok(`${tag}: anchor 命中 ${hits.length} 处`);

    if (!Array.isArray(item.lines)) {
      fail(`${tag}: lines 非数组`);
      continue;
    }
    for (const line of item.lines) {
      commentCount++;
      const body = line.startsWith("//") ? line.slice(2) : line;
      const trimmed = body.trim();
      if (line.includes("*/")) fail(`${tag}: 注释含 */`);
      if (trimmed.endsWith(";")) fail(`${tag}: 注释以 ; 结尾 -> ${trimmed}`);
      if (line.includes("=>")) fail(`${tag}: 注释含 =>`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(line)) fail(`${tag}: 注释呈调用形态 -> ${trimmed}`);
      const first = trimmed.split(/\s+/)[0];
      if (forbiddenStart.includes(first)) fail(`${tag}: 注释以禁词 ${first} 开头`);
    }
  }
  if (commentCount !== want) fail(`${file}: 新增注释 ${commentCount} 行，期望 ${want} 行`);
  else ok(`${file}: 注释行数 ${commentCount} 符合期望`);
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
