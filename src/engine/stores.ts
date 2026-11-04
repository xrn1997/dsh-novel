/** `downloadFile` 的进程级暂存表：条数上限 + 单文件字节上限。
 *
 *  为什么单独立一处：上限与淘汰顺序必须住在可单测的构造器里，不能埋在 js-protocol 的模块级 Map
 *  与 interface 之外。生产仍是模块级单例（只有一处 adapter，不造注入 seam）。
 *
 *  如实说清边界：这两道闸限的是**条目数与单文件大小**，不是总常驻字节——上限相乘后的最坏情况
 *  仍达 4GB，要收总盘子得再加一道字节计数淘汰；当前没加——输入里下载的是 KB 级密钥图，两道闸够用。 */

export interface FileStore {
  put(path: string, bytes: Uint8Array): void
  get(path: string): Uint8Array | undefined
}

export function createFileStore(opts: { entries: number; bytes: number }): FileStore {
  const m = new Map<string, Uint8Array>()
  return {
    put(path, bytes) {
      // 淘汰次序钉死：先判单文件字节上限（超了不入表），再在条数满时淘汰最旧，
      // 最后写入。覆盖已有键也照此次序——「哪一条被挤掉」的可观测结果就绑在这条次序上，换序即换行为。
      if (bytes.byteLength > opts.bytes) {
        throw new Error(`文件超过 ${opts.bytes / 1024 / 1024}MB 上限`)
      }
      if (m.size >= opts.entries) {
        const oldest = m.keys().next().value
        if (oldest !== undefined) m.delete(oldest)
      }
      m.set(path, bytes)
    },
    get: (path) => m.get(path),
  }
}
