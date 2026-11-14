import fs from 'node:fs';
import { execSync } from 'node:child_process';
const DIR = 'd:/code/_annot_baseline/VK-SRVCHK';
fs.mkdirSync(`${DIR}/orig/src`, { recursive: true });
fs.writeFileSync(`${DIR}/orig/src/server.c`, execSync('git -C d:/code/opensource/valkey show HEAD:src/server.c', { encoding: 'utf8', maxBuffer: 1 << 28 }));
fs.writeFileSync(`${DIR}/_files.txt`, 'src/server.c\n');
fs.copyFileSync('d:/code/_annot_baseline/VK-B61/annot-shim.h', `${DIR}/annot-shim.h`);
console.log('ok');
