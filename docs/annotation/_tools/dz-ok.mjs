// 输出已达标（need30=0）文件清单：文件名/密度/行数
import fs from 'node:fs';
import path from 'node:path';
const ROOT = 'D:/code/opensource/drizzle-orm';
const EX = new Set(['drizzle-seed/src/datasets/lastNames.ts','drizzle-seed/src/datasets/cityNames.ts','drizzle-seed/src/datasets/firstNames.ts','drizzle-seed/src/datasets/adjectives.ts','drizzle-seed/src/datasets/loremIpsumSentences.ts','drizzle-seed/src/datasets/phonesInfo.ts','drizzle-seed/src/datasets/companyNameSuffixes.ts','drizzle-seed/src/datasets/emailDomains.ts','drizzle-seed/src/datasets/states.ts']);
const EXD = new Set(['node_modules','dist','tests','type-tests','__tests__','coverage','build','scripts','datasets']);
function walk(d,o){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){if(!EXD.has(e.name))walk(p,o);}else if(/\.(ts|tsx|js|mjs)$/.test(e.name)&&!/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(e.name)&&!e.name.endsWith('.d.ts'))o.push(p);}}
function st(f){const L=fs.readFileSync(f,'utf8').split(/\r?\n/);if(L[L.length-1]==='')L.pop();let total=L.length,blank=0,com=0,inB=false;for(const r of L){const t=r.trim();if(!t){blank++;continue;}let c=false;if(inB){c=true;if(t.includes('*/'))inB=false;}else if(t.startsWith('//'))c=true;else if(t.startsWith('/*')){c=true;if(!t.includes('*/'))inB=true;}if(c)com++;}const code=total-blank-com;return{total,code,com,need:Math.max(0,Math.ceil(code*0.30)-com),ratio:code?com/code*100:0};}
const files=[];for(const g of ['drizzle-orm','drizzle-kit','drizzle-zod','drizzle-valibot','drizzle-typebox','drizzle-arktype','drizzle-seed','eslint-plugin-drizzle']){const d=path.join(ROOT,g,'src');if(fs.existsSync(d))walk(d,files);}
const ok=files.map(f=>({rel:path.relative(ROOT,f).replace(/\\/g,'/'),...st(f)})).filter(r=>!EX.has(r.rel)&&r.need===0);
ok.sort((a,b)=>b.ratio-a.ratio);
for(const r of ok)console.log(`${r.ratio.toFixed(1)}\t${r.total}\t${r.code}\t${r.com}\t${r.rel}`);
console.log('count',ok.length);
