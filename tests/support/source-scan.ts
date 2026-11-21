import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 客户端源码扫描面：`src/client` 的目录位置与逐文件文本（三份逐字副本的唯一实现）。
 *
 * 目录按 vitest 工作目录定位（恒为仓库根），不按 `import.meta.url`：该面同时被 node 与 jsdom
 * 两个环境的测试消费，而 jsdom 里 `import.meta.url` 不是 file 协议。扫描面只收 `.ts` / `.tsx`，
 * 不跟随目录软链。
 */
export const CLIENT_DIR = path.join(process.cwd(), 'src', 'client')

export interface ClientSource {
  /** 相对 `src/client/` 的 posix 路径：守卫的报错与白名单都按这个键说话。 */
  file: string
  text: string
}

/** 逐个 `.ts` / `.tsx` 读出 client 源码。 */
export function clientSources(): ClientSource[] {
  const out: ClientSource[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry.name)) {
        out.push({ file: path.relative(CLIENT_DIR, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') })
      }
    }
  }
  walk(CLIENT_DIR)
  return out
}
