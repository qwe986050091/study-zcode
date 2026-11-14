import fs from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b63-spec-02.json";
const ROOT = "d:/code/ZCode";
const SPEC = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));

const TOTAL_EXPECTED = 71;
const FORBIDDEN_PREFIX = [
  "const",
  "let",
  "var",
  "function",
  "class",
  "import",
  "export",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "try",
  "catch",
  "await",
  "async",
  "throw",
  "new",
  "interface",
  "type",
  "enum",
];
const MEMBER_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];
const fail = (msg) => errors.push(msg);

if (!Array.isArray(SPEC.files) || SPEC.files.length === 0) {
  fail("files is empty");
  console.log(errors.join("\n"));
  process.exit(1);
}

let totalLines = 0;
let anchorCount = 0;

for (const fileEntry of SPEC.files) {
  const abs = `${ROOT}/${fileEntry.file}`;
  if (!fs.existsSync(abs)) {
    fail(`missing target file: ${abs}`);
    continue;
  }
  const rawSrc = fs.readFileSync(abs, "utf8");
  const fileLines = rawSrc.split(/\r?\n/).map((line) => line.trim());

  const items = fileEntry.items;
  if (!Array.isArray(items) || items.length === 0) {
    fail(`${fileEntry.file}: items is empty`);
    continue;
  }

  items.forEach((item, idx) => {
    const tag = `${fileEntry.file} item[${idx}]`;
    anchorCount += 1;

    // ---- shape checks ----
    if (idx === 0) {
      if (!Array.isArray(item.raw) || item.raw.length === 0) {
        fail(`${tag}: first item must have non-empty raw`);
      } else {
        for (const line of item.raw) {
          if (!(line.startsWith("// ") || line === "//")) {
            fail(`${tag}: raw line must start with "// " or "//": ${line}`);
          }
        }
      }
      if (item.lines !== undefined) fail(`${tag}: first item should not use lines`);
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        fail(`${tag}: must have non-empty lines`);
      }
      if (item.raw !== undefined) fail(`${tag}: only first item may use raw`);
    }

    const payload = idx === 0 ? item.raw || [] : item.lines || [];
    const body = payload.map((line) => (line.startsWith("//") ? line.replace(/^\/\/ ?/, "") : line));

    for (const text of body) {
      if (text.includes("*/")) fail(`${tag}: contains "*/": ${text}`);
      if (text.trimEnd().endsWith(";")) fail(`${tag}: ends with ";": ${text}`);
      if (text.includes("=>")) fail(`${tag}: contains "=>": ${text}`);
      if (MEMBER_CALL.test(text)) fail(`${tag}: contains member call: ${text}`);
      const head = text.trimStart();
      for (const kw of FORBIDDEN_PREFIX) {
        if (head.startsWith(`${kw} `) || head === kw || head.startsWith(`${kw}(`)) {
          fail(`${tag}: starts with forbidden keyword "${kw}": ${text}`);
          break;
        }
      }
    }

    totalLines += payload.length;

    // ---- anchor checks ----
    if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
      fail(`${tag}: anchor missing`);
      return;
    }
    const needle = item.anchor.trim();
    const matches = fileLines.reduce((acc, line, i) => (line === needle ? [...acc, i + 1] : acc), []);
    if (matches.length === 0) {
      fail(`${tag}: anchor not found: ${JSON.stringify(item.anchor)}`);
      return;
    }
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches.length) {
        fail(`${tag}: nth out of range (nth=${item.nth}, matches=${matches.length}): ${needle}`);
      }
    } else if (matches.length > 1) {
      fail(`${tag}: anchor not unique (${matches.length} matches): ${needle}`);
    }
  });
}

if (totalLines !== TOTAL_EXPECTED) {
  fail(`total inserted lines = ${totalLines}, expected ${TOTAL_EXPECTED}`);
}

if (errors.length > 0) {
  console.log(errors.join("\n"));
  process.exit(1);
}

console.log(`anchors=${anchorCount} lines=${totalLines}`);
console.log("OK");
