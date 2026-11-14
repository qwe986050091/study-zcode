import fs from 'node:fs';

const file = 'd:\\code\\ZCode\\packages\\services\\src\\session\\taskIndexRepo.ts';
const text = fs.readFileSync(file, 'utf8');
const normalized = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
fs.writeFileSync(file, normalized);
console.log('converted to CRLF, bytes', Buffer.byteLength(normalized));
