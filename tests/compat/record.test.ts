import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { recordBodyOf, declaredCharsetOf } from './record.js'

/**
 * 采集侧落盘解码的钉子。病根：原先 `buf.toString('utf8')` 对 GBK 页产出乱码——采集能过
 * （断言跑在真解码链上）、**回放必红**（回放一律 utf-8 提供文本）。存的必须是**管线读到的那段文本**。
 */
describe('采集落盘解码（与生产同链）', () => {
  it('GBK 响应：落盘是真中文，不是乱码（旧写法在这条上必红）', () => {
    const gbk = iconv.encode('第一章 初入江湖', 'gbk')
    const stored = recordBodyOf(gbk, 'https://x/y.html', 'text/html; charset=gbk')
    expect(stored).toBe('第一章 初入江湖')
    expect(gbk.toString('utf8')).not.toBe('第一章 初入江湖')   // 旧写法确实错（红检的等价物）
  })

  it('无 content-type 时走 meta 嗅探（GBK 页声明在 <meta> 里）', () => {
    const html = '<html><head><meta charset="gbk"></head><body>正文甲</body></html>'
    const stored = recordBodyOf(iconv.encode(html, 'gbk'), 'https://x/y.html', undefined)
    expect(stored).toContain('正文甲')
  })

  it('UTF-8 响应照常', () => {
    expect(recordBodyOf(Buffer.from('你好', 'utf8'), 'https://x/y.html', 'text/html; charset=utf-8')).toBe('你好')
  })

  it('`declaredCharsetOf` 只认响应头里的 charset（大小写不敏感）', () => {
    expect(declaredCharsetOf('text/html; charset=GBK')).toBe('GBK')
    expect(declaredCharsetOf('text/html')).toBeUndefined()
    expect(declaredCharsetOf(undefined)).toBeUndefined()
  })
})
