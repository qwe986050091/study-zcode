// 深注基线快照（40 个核心文件）
import fs from 'node:fs';
import path from 'node:path';
const repo = 'd:/code/opensource/xv6-riscv';
const base = 'd:/code/_annot_baseline/XV-deep-b1';
export const FILES = [
  'kernel/bio.c', 'kernel/console.c', 'kernel/exec.c', 'kernel/file.c', 'kernel/fs.c',
  'kernel/kalloc.c', 'kernel/log.c', 'kernel/main.c', 'kernel/pipe.c', 'kernel/plic.c',
  'kernel/printk.c', 'kernel/proc.c', 'kernel/sleeplock.c', 'kernel/spinlock.c',
  'kernel/start.c', 'kernel/string.c', 'kernel/syscall.c', 'kernel/sysfile.c',
  'kernel/sysproc.c', 'kernel/trap.c', 'kernel/uart.c', 'kernel/virtio_disk.c', 'kernel/vm.c',
  'kernel/entry.S', 'kernel/kernelvec.S', 'kernel/swtch.S', 'kernel/trampoline.S',
  'kernel/defs.h', 'kernel/riscv.h', 'kernel/proc.h', 'kernel/fs.h', 'kernel/file.h',
  'kernel/buf.h', 'kernel/virtio.h', 'kernel/sleeplock.h', 'kernel/spinlock.h',
  'user/init.c', 'user/sh.c', 'user/printf.c', 'user/ulib.c',
];
for (const f of FILES) {
  const d = path.join(base, f);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(path.join(repo, f), d);
}
console.log('copied ' + FILES.length);
console.log(FILES.join(','));
