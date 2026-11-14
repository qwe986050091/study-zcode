import fs from "fs";

const p = process.argv[2];
const src = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const lines = src.split("\n");
const out = [];
const re = /^(if |elif |for |while |return |raise |with |except |try:|assert )/;
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (!t || t.startsWith("#") || t.startsWith('"') || t.startsWith("'")) continue;
  if (!re.test(t)) continue;
  let j = i - 1;
  let has = false;
  let k = 0;
  while (j >= 0 && k < 2) {
    if (!lines[j].trim()) {
      j--;
      continue;
    }
    if (lines[j].trim().startsWith("#")) {
      has = true;
      break;
    }
    k++;
    j--;
  }
  if (!has) out.push(`${i + 1}: ${t.slice(0, 90)}`);
}
console.log("count", out.length);
console.log(out.join("\n"));
