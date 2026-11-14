import fs from "node:fs";

const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b62-spec-12.json";
const repoRoot = "d:\\code\\ZCode";
const expectedTotal = 68;

const fail = (msg) => {
  console.error("FAIL: " + msg);
  process.exit(1);
};

if (!fs.existsSync(specPath)) fail("spec file missing: " + specPath);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
if (!spec.files || !Array.isArray(spec.files) || spec.files.length === 0) fail("files empty");

const forbiddenPrefixes = [
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
const callPattern = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

let grandTotal = 0;
let anchorCount = 0;

for (const entry of spec.files) {
  const target = repoRoot + "\\" + entry.file.replace(/\//g, "\\");
  if (!fs.existsSync(target)) fail("target file missing: " + target);
  const sourceLines = fs.readFileSync(target, "utf8").split(/\r?\n/);
  const trimmedSource = sourceLines.map((l) => l.trim());

  if (!Array.isArray(entry.items) || entry.items.length === 0) fail("items empty");

  entry.items.forEach((item, idx) => {
    const isFirst = idx === 0;
    if (typeof item.anchor !== "string" || item.anchor.length === 0) {
      fail("item " + idx + " missing anchor");
    }

    let contents = [];
    if (isFirst) {
      if (!Array.isArray(item.raw) || item.raw.length === 0) fail("first item must have raw");
      for (const line of item.raw) {
        if (!(line.startsWith("// ") || line === "//" || line.startsWith("//"))) {
          fail("raw line not a comment: " + line);
        }
        if (line.startsWith("// ")) contents.push(line.slice(3));
        else contents.push(line.slice(2).trim());
      }
      grandTotal += item.raw.length;
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        fail("item " + idx + " must have non-empty lines");
      }
      for (const line of item.lines) {
        if (typeof line !== "string" || line.trim().length === 0) {
          fail("item " + idx + " has empty line content");
        }
        if (line.trimStart().startsWith("//")) {
          fail("item " + idx + " line must not start with //: " + line);
        }
        contents.push(line);
      }
      grandTotal += item.lines.length;
    }

    // anchor uniqueness / nth bound
    const anchorTrim = item.anchor.trim();
    const matches = trimmedSource.filter((l) => l === anchorTrim).length;
    if (matches < 1) fail("anchor not found: " + item.anchor);
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches) {
        fail("nth out of range for anchor (matches=" + matches + ", nth=" + item.nth + "): " + item.anchor);
      }
    } else if (matches !== 1) {
      fail("anchor not unique (matches=" + matches + "): " + item.anchor);
    }
    anchorCount += 1;

    // banned content
    for (const text of contents) {
      const t = text.trim();
      if (t.includes("*/")) fail("contains */: " + t);
      if (t.includes("=>")) fail("contains =>: " + t);
      if (t.endsWith(";")) fail("ends with ;: " + t);
      const firstWord = t.split(/\s+/)[0].toLowerCase();
      if (forbiddenPrefixes.includes(firstWord)) fail("starts with keyword " + firstWord + ": " + t);
      if (callPattern.test(t)) fail("contains member call pattern: " + t);
    }
  });
}

if (grandTotal !== expectedTotal) {
  fail("total inserted lines = " + grandTotal + ", expected " + expectedTotal);
}

console.log("OK total=" + grandTotal + " anchors=" + anchorCount + " files=" + spec.files.length);
