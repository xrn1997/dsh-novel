/**
 * 字节上限 → 用户可读文案（错误信息共用）。为什么分档：本地导入上限可在插件页热改到 1 MiB
 * 以下，若一律按 MB 四舍五入，一次「超过 512KB」的拒绝会被写成「超过 0MB」——拒绝发生了，
 * 理由却读不出来。判定与文案必须用**同一个**上限值（见 `LocalBooks.import` 与本地导入的
 * 传输层），否则两个读数之间配置变了，用户看到的上限与实际拒绝的口径对不上。
 */
export function formatByteLimit(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${Math.round(bytes / 1024 / 1024)}MB`
}
