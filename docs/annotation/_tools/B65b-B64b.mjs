import fs from 'node:fs';
import { execSync } from 'node:child_process';
function mk(name, rel, E) {
  const DIR = `d:/code/_annot_baseline/${name}`;
  fs.mkdirSync(`${DIR}/orig/src`, { recursive: true });
  const head = execSync(`git -C d:/code/opensource/valkey show HEAD:${rel}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
  fs.writeFileSync(`${DIR}/orig/${rel}`, head);
  fs.writeFileSync(`${DIR}/_files.txt`, rel + '\n');
  fs.copyFileSync('d:/code/_annot_baseline/VK-B61/annot-shim.h', `${DIR}/annot-shim.h`);
  const src = head.split(/\r?\n/);
  const spec = [{ file: rel, ops: E.map(([line, text]) => ({ line, expect: src[line - 1].trim(), lines: [`// ${text}`] })) }];
  fs.writeFileSync(`${DIR}/spec.json`, JSON.stringify(spec, null, 2));
  fs.writeFileSync(`${DIR}/out-${rel.split('/').pop().replace(/\.c$/, '')}.json`, JSON.stringify(E.map(([line, text]) => ({ line, c: [text] })), null, 2));
  console.log(name, 'entries', E.length);
}
mk('VK-B65b', 'src/fuzzer_client.c', [
  [135, '声明在定义之前，供 `threadConnectAndFuzz` 退出时先回收错误列表；释放顺序见定义处。'],
  [136, '声明先于使用，`startProgressReporting` 只按 `pthread_t` 建线程，不关心入口细节。'],
  [137, '声明先于使用；调用方只给命令总数，分母与起点由实现自己写。'],
  [138, '声明先于使用，`runClients` 在释放 `thread_data` 之前必须调用它。'],
  [139, '声明先于使用，`runFuzzerClients` 在起线程前调用，保证统计从 0 开始。'],
  [140, '声明先于使用；实现要在 `cleanupFuzzer` 之前调用，否则命令名表已释放。'],
]);
mk('VK-B64b', 'src/throttle.c', [
  [104, '`hashtableFind` 只做查找不接管 key，命中路径必须在这里 `sdsfree` 临时 key。'],
  [105, '返回的条目由 `metricsDestructor` 释放，调用方只读不 free。'],
]);
