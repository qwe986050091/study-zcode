// 一次性探测：对 VK-B1 候选文件做 clang -fsyntax-only，不做任何修改。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\valkey';
const NDK = 'D:\\program\\android-env\\android-sdk\\ndk\\27.1.12297006\\toolchains\\llvm\\prebuilt\\windows-x86_64';
const CLANG = path.join(NDK, 'bin', 'clang.exe');
const SYSROOT = path.join(NDK, 'sysroot');
const SHIM = 'd:\\code\\_annot_baseline\\VK-B1\\annot-shim.h';

const files = process.argv.slice(2);
const common = [
  '-fsyntax-only',
  '--target=aarch64-linux-android21',
  '--sysroot=' + SYSROOT,
  '-Isrc', '-Ideps', '-Ideps/hdr_histogram', '-Ideps/fpconv', '-Ideps/fast_float',
  '-Ideps/lz4', '-Ideps/linenoise', '-Ideps/lua/src', '-Ideps/libvalkey/include',
  '-include', SHIM,
  '-DDEFAULT_CONFIG_FILE="valkey.conf"',
];

for (const f of files) {
  const r = spawnSync(CLANG, [...common, f], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  const err = (r.stderr || '').split(/\r?\n/).filter((l) => /error:/.test(l))[0] || '';
  console.log(`${r.status === 0 ? 'OK  ' : 'FAIL'} ${f} ${err}`);
}
