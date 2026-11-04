import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 文档门的**语料**唯一读取口：哪些文件进扫描面、怎么读、相对路径怎么解析，都在这一处。
 * 判据只消费这里给出的接口，不再各自摸根目录或再写一份走目录。
 */
export const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/** 报错信息里用相对路径，别把这台机器的绝对路径打进测试输出。 */
export function rel(file: string): string {
  return file.slice(ROOT.length + 1).replace(/\\/g, '/')
}

/** 生成快照与构建产物不是判据的家；`lib` 与 `.qoder` 一律不进语料。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git' || entry === '.qoder') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(md|ts|tsx|css)$/.test(entry)) out.push(p)
  }
  return out
}

/**
 * 被测的是手写的那几份 + 代码注释；生成的 `.qoder/repowiki` 不在内。
 * 自排除只针对 `docs-liveness.test.ts`：它的正文引用着被禁的称呼与历史文件名，扫自己必然自红。
 */
const targets = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CONTEXT.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'CHANGELOG.md'),
  ...walk(join(ROOT, 'docs')),
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'tests')),
].filter((f) => f !== join(ROOT, 'tests', 'docs-liveness.test.ts'))

export interface CorpusFile {
  file: string
  lines: string[]
}

/** 一次读进来，下面几道门共用这份语料。 */
export const CORPUS: CorpusFile[] = targets.map((file) => ({
  file,
  lines: readFileSync(file, 'utf8').split(/\r?\n/),
}))

/** 手写文档（根文档 + docs/**）；结构门只看这些，源码与测试的注释不参与。 */
export const ROOT_DOCS = new Set([
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CONTEXT.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'CHANGELOG.md'),
])
const DOCS_ROOT = join(ROOT, 'docs') + sep
export const DOC_CORPUS = CORPUS.filter(({ file }) => ROOT_DOCS.has(file) || file.startsWith(DOCS_ROOT))

export function eachLine(visit: (file: string, line: string, index: number) => void): void {
  for (const { file, lines } of CORPUS) lines.forEach((line, index) => visit(file, line, index))
}

/** 整份读一份手写文档；链接目标与 ADR 文件也走这里。 */
export function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

export function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function exists(path: string): boolean {
  const candidates = [
    path,
    // 代码注释里的 ESM 请求带 `.js`，源文件是 `.ts` / `.tsx`
    path.replace(/\.js$/, '.ts'),
    path.replace(/\.js$/, '.tsx'),
    path.replace(/\.ts$/, '.tsx'),
  ]
  return candidates.some((c) => {
    try {
      const s = statSync(join(ROOT, c))
      return s.isFile() || s.isDirectory()
    } catch {
      return false
    }
  })
}
