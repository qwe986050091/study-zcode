import fs from "node:fs";

for (let i = 1; i <= 12; i++) {
  const p = `d:/code/_annot_baseline/ZC-deep-b67-spec-${String(i).padStart(2, "0")}.json`;
  const spec = JSON.parse(fs.readFileSync(p, "utf8"));
  const f = spec.files[0];
  const raw = f.items[0].raw || [];
  const invs = raw
    .filter((l) => l.startsWith("// INV-"))
    .slice(0, 6)
    .map((l) => l.replace(/^\/\/ INV-\d+\s*/, "").split("；守住位置")[0]);
  const brief = raw
    .filter((l) => l.startsWith("// 模块职责"))
    .map((l) => l.replace(/^\/\/ 模块职责：/, ""))[0];
  console.log(`### ${i} ${f.file}`);
  if (brief) console.log("职责: " + brief);
  for (const t of invs) console.log("- " + t);
  console.log(`anchors=${f.items.length} total=${raw.length + f.items.slice(1).reduce((a, b) => a + (b.lines || []).length, 0)}`);
}
