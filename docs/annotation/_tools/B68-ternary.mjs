import fs from 'node:fs';
import { execSync } from 'node:child_process';
const REPO = 'd:/code/opensource/valkey';
const jobs = [
  {
    dir: 'd:/code/_annot_baseline/VK-B68a',
    rel: 'src/compression_stream.c',
    E: [
      [268, '剩余量不足一块时取 `remaining`，最后一块可以不满。'],
      [269, '否则取 1MB 上限，避免超大输入放大 `OutputBound`。'],
      [341, '低于下限时取 `STREAM_READER_BUFFER_SIZE_MIN`，保证解码器有前进空间。'],
      [342, '否则用调用方给的 `cfg->buffer_size`。'],
      [351, 'magic 尚未凑满 3 字节时，只补 magic 的剩余部分。'],
      [352, 'magic 齐了之后按整个 `VCS_ENVELOPE_SIZE` 补齐。'],
      [659, '`eof_mid_frame_is_truncation` 为真时归 TRUNCATED。'],
      [660, '否则归 CORRUPT：不是提前结束，而是内容本身不合法。'],
    ],
  },
  {
    dir: 'd:/code/_annot_baseline/VK-B68b',
    rel: 'src/compression_lz4.c',
    E: [
      [126, '`STREAM_CHECKSUM_BLOCK` 置位时的取值：帧内每块附 4 字节校验和。'],
      [127, '未置位时显式写 `LZ4F_noBlockChecksum`，不依赖 prefs 的默认值。'],
      [130, '`STREAM_CHECKSUM_CONTENT` 置位时写帧尾 4 字节 content hash。'],
      [131, '未置位时写 `noContentChecksum`，帧尾因此没有 hash。'],
    ],
  },
];
for (const job of jobs) {
  const head = execSync(`git -C ${REPO} show HEAD:${job.rel}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const src = head.split(/\r?\n/);
  fs.mkdirSync(`${job.dir}/orig/${job.rel.replace(/\/[^/]+$/, '')}`, { recursive: true });
  fs.writeFileSync(`${job.dir}/orig/${job.rel}`, head);
  fs.writeFileSync(`${job.dir}/_files.txt`, job.rel + '\n');
  fs.copyFileSync('d:/code/_annot_baseline/VK-B61/annot-shim.h', `${job.dir}/annot-shim.h`);
  const spec = [{
    file: job.rel,
    ops: job.E.map(([line, text]) => ({ line, expect: src[line - 1].trim(), lines: [`// ${text}`] })),
  }];
  fs.writeFileSync(`${job.dir}/spec.json`, JSON.stringify(spec, null, 2));
  console.log(job.rel, 'entries', job.E.length);
}
