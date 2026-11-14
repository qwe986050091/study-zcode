import fs from 'node:fs';

const file = 'd:/code/opensource/uv/crates/uv-python-types/src/download_request.rs';
let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const hits = [];
for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*(#\[|\/\/\/)/.test(lines[i]) && /^\s*\/\/(?!\/)/.test(lines[i + 1])) {
        hits.push(i);
    }
}

for (const i of hits.reverse()) {
    const head = lines[i];
    let j = i + 1;
    while (j < lines.length && /^\s*\/\/(?!\/)/.test(lines[j])) j++;
    const block = lines.slice(i + 1, j);
    lines.splice(i, j - i, ...block, head);
}

fs.writeFileSync(file, lines.join('\n'));
console.log('moved ' + hits.length + ' blocks');
