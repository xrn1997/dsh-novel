/**
 * 资源层测试：图片类型/尺寸验证与受限 SVG 重建。
 *
 * 三条口径决定了这里的断言方式：
 * ① **不信声明也不只读文件头**：manifest 的 MIME 要与魔数一致，容器结构要完整（PNG 逐 chunk 核 CRC、
 *    JPEG 要有 EOI、GIF 要有 trailer、WebP 的 RIFF 长度要自洽）——「读得出宽高」不等于浏览器解得开；
 * ② **EXIF 旋转要折进显示宽高**：Orientation=6 的 2×3 图，交出去的宽高必须是 3×2（否则阅读器
 *    先按错比例占位，图一加载就跳版）；
 * ③ **可见图形宁报错不删掉**：SVG 白名单外的可见元素（foreignObject/use/image）报错点名资源，
 *    活动内容（script/style、事件属性、style 属性）剥除并留告警，样式类属性不是「内容」。
 */
import { describe, expect, it } from 'vitest'
import type { LocalImportWarning } from '../../src/shared/wire.js'
import { EpubWarningLog } from '../../src/services/epub/warnings.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { validateImage, type ImageFacts } from '../../src/services/epub/resources.js'
import { IMAGE_SAMPLES } from '../fixtures/epub.js'

const LIMITS = { depth: 128, nodes: 200_000 }

/** 跑一次校验并收下告警（告警走日志，不回灌进 facts——facts 只该有类型/尺寸那几项） */
function run(bytes: Buffer, declaredMediaType: string, opts: { what?: string; path?: string; imagePixels?: number } = {}): { facts: ImageFacts; warnings: LocalImportWarning[] } {
  const log = new EpubWarningLog()
  const facts = validateImage(bytes, {
    what: opts.what ?? 'images/fig.bin（引用处 OEBPS/ch1.xhtml）',
    path: opts.path ?? 'images/fig.bin',
    declaredMediaType,
    imagePixels: opts.imagePixels ?? 40_000_000,
    domLimits: LIMITS,
    warnings: log,
  })
  return { facts, warnings: log.list() }
}

/** 只要 facts 的那一类用例（宽度/类型/扩展名） */
function check(bytes: Buffer, declaredMediaType: string, opts: { what?: string; path?: string; imagePixels?: number } = {}): ImageFacts {
  return run(bytes, declaredMediaType, opts).facts
}

function rejection(bytes: Buffer, declaredMediaType: string, opts: { imagePixels?: number } = {}): Error {
  try {
    check(bytes, declaredMediaType, opts)
  } catch (e) {
    return e as Error
  }
  throw new Error(`预期拒绝，实际成功——坏图冒充可读是本仓的最高罪（声明 ${declaredMediaType}）`)
}

function expectEpubError(e: Error, pattern: RegExp): void {
  expect(e.name).toBe('EpubImportError')
  expect(e).toBeInstanceOf(EpubImportError)
  expect(e.message).toMatch(pattern)
}

const SVG = (body: string): Buffer => Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n' + body,
  'utf8',
)

describe('光栅图：类型、扩展名与宽高', () => {
  it('四种受支持格式各自认出权威 MIME/扩展名与宽高', () => {
    expect(check(IMAGE_SAMPLES.png, 'image/png')).toEqual({ kind: 'raster', mediaType: 'image/png', ext: 'png', width: 2, height: 3 })
    expect(check(IMAGE_SAMPLES.gif, 'image/gif')).toEqual({ kind: 'raster', mediaType: 'image/gif', ext: 'gif', width: 1, height: 1 })
    expect(check(IMAGE_SAMPLES.webp, 'image/webp')).toEqual({ kind: 'raster', mediaType: 'image/webp', ext: 'webp', width: 3, height: 2 })
    expect(check(IMAGE_SAMPLES.jpeg, 'image/jpeg')).toEqual({ kind: 'raster', mediaType: 'image/jpeg', ext: 'jpg', width: 2, height: 3 })
  })

  it('image/jpg 是 image/jpeg 的常见别名：归一成权威 MIME（不因此拒掉整本书）', () => {
    expect(check(IMAGE_SAMPLES.jpeg, 'image/jpg')).toMatchObject({ mediaType: 'image/jpeg', ext: 'jpg' })
    // media-type 的大小写与参数不改变资源种类（与包层同一口径）：声明写全了的书不该被拒
    expect(check(IMAGE_SAMPLES.png, 'IMAGE/PNG; charset=utf-8')).toMatchObject({ mediaType: 'image/png', ext: 'png' })
  })

  it('EXIF Orientation=6（顺时针 90°）：显示宽高折成 3×2', () => {
    expect(check(IMAGE_SAMPLES.jpegRotated, 'image/jpeg')).toMatchObject({ width: 3, height: 2 })
    // 对照组：同结构的 Orientation=1 保持 2×3——折的是旋转，不是把所有图都转一个方向
    expect(check(IMAGE_SAMPLES.jpeg, 'image/jpeg')).toMatchObject({ width: 2, height: 3 })
  })

  it('声明的 MIME 与魔数不一致：报错点名资源与两种类型', () => {
    const e = rejection(IMAGE_SAMPLES.jpeg, 'image/png')
    expectEpubError(e, /images\/fig\.bin/)
    expectEpubError(e, /jpeg/)
    expectEpubError(e, /png/)
  })

  it('不受支持的图片类型：报错点名资源与声明类型', () => {
    expectEpubError(rejection(IMAGE_SAMPLES.png, 'image/bmp'), /不支持/)
    expectEpubError(rejection(IMAGE_SAMPLES.png, 'image/bmp'), /image\/bmp/)
    expectEpubError(rejection(IMAGE_SAMPLES.png, 'application/octet-stream'), /application\/octet-stream/)
  })

  it('像素超预算：报错点名资源与上限（缩预算测试，不必造真大图）', () => {
    const e = rejection(IMAGE_SAMPLES.png, 'image/png', { imagePixels: 5 })
    expectEpubError(e, /像素/)
    expectEpubError(e, /images\/fig\.bin/)
    expect(e.message).toMatch(/5/)          // 上限本身进文案，读者知道该改哪个数
    // 同一张图放宽预算即通过：拒绝来自预算而不是样本自身坏掉
    expect(check(IMAGE_SAMPLES.png, 'image/png', { imagePixels: 6 })).toMatchObject({ width: 2, height: 3 })
  })
})

describe('光栅图：容器结构要完整（不只信文件头）', () => {
  it('PNG 缺 IEND：报错（读图库仍读得出宽高，但那不等于图是完整的）', () => {
    expectEpubError(rejection(IMAGE_SAMPLES.pngTruncated, 'image/png'), /损坏|IEND/)
    expectEpubError(rejection(IMAGE_SAMPLES.pngTruncated, 'image/png'), /images\/fig\.bin/)
  })

  it('PNG chunk 的 CRC 对不上：报错（内容是坏的，不是「解析不出」）', () => {
    const corrupt = Buffer.from(IMAGE_SAMPLES.png)
    corrupt[45] = corrupt[45] ^ 0xff          // IHDR 数据区内的一个字节
    expectEpubError(rejection(corrupt, 'image/png'), /CRC|损坏/)
  })

  it('JPEG 缺 EOI：报错（截断的图不许按半张显示）', () => {
    expectEpubError(rejection(IMAGE_SAMPLES.jpeg.subarray(0, IMAGE_SAMPLES.jpeg.length - 2), 'image/jpeg'), /EOI|损坏/)
  })

  it('GIF 缺 trailer：报错', () => {
    expectEpubError(rejection(IMAGE_SAMPLES.gif.subarray(0, IMAGE_SAMPLES.gif.length - 1), 'image/gif'), /trailer|损坏/)
  })

  it('WebP 的 RIFF 长度与文件不符：报错', () => {
    expectEpubError(rejection(IMAGE_SAMPLES.webp.subarray(0, IMAGE_SAMPLES.webp.length - 4), 'image/webp'), /RIFF|损坏/)
  })

  it('字节短到读不出任何格式：报错而不是返回 0×0', () => {
    expectEpubError(rejection(Buffer.from([0x00, 0x01, 0x02]), 'image/png'), /损坏|不支持|读不出/)
  })

  /**
   * **本层的能力边界要钉住**：校验的是容器**结构**，不是像素解码——所以「结构逐项过关、没有解码器
   * 能渲染」的字节必须**被放行**（真解码归浏览器验收门，见 `tests/browser/epub-reader.test.ts`）。
   * 钉住这条不是为了给放行找理由，而是为了防两头的回归：把边界误当解码器（用启发式拒掉一堆真图），
   * 或反过来把「读得出宽高」当可读（这两份样本正是它放行的那一类，必须由渲染侧如实报加载失败）。
   */
  it('结构完整但解不开的两份样本：本层放行（宽高来自容器，真解码归浏览器门）', () => {
    expect(check(IMAGE_SAMPLES.undecodablePng, 'image/png')).toMatchObject({ kind: 'raster', mediaType: 'image/png', width: 2, height: 3 })
    expect(check(IMAGE_SAMPLES.undecodableGif, 'image/gif')).toMatchObject({ kind: 'raster', mediaType: 'image/gif', width: 1, height: 1 })
  })
})

describe('独立 SVG：白名单重建', () => {
  // 渐变引用写成大写 `URL(...)`：CSS 的 url() 大小写不敏感，认不出就会留下指向已改写 ID 的死链
  const FIGURE = SVG('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="20" viewBox="0 0 10 20" version="1.1">'
    + '<title>矢量插图</title>'
    + '<defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
    + '<g transform="translate(1 2)"><rect id="box" x="0" y="0" width="4" height="6" fill="URL(#grad)" stroke="#000" stroke-width="1" sodipodi:nodetypes="cc"/>'
    + '<circle cx="5" cy="5" r="2" opacity="0.5"/><path d="M0 0 L1 1" fill="none"/>'
    + '<text x="1" y="1" font-size="3" text-anchor="middle">字</text></g>'
    + '<style>rect{fill:green}</style><script>alert(1)</script></svg>')

  it('保留几何/变换/文本/颜色；只把同文件渐变引用重写成安全 ID', () => {
    const facts = check(FIGURE, 'image/svg+xml')
    expect(facts.kind).toBe('svg')
    if (facts.kind !== 'svg') throw new Error('unreachable')
    expect(facts.mediaType).toBe('image/svg+xml')
    expect(facts.ext).toBe('svg')
    expect(facts.width).toBe(10)
    expect(facts.height).toBe(20)
    const out = facts.content
    // 渐变定义与引用一起重写：原 id 不出现在结果里，引用指向重写后的 id
    // （大小写不敏感的比对是必须的：`URL(#grad)` 漏掉就会留下一条指向 s0 的死链，图形静默消失）
    expect(out).not.toMatch(/url\(#grad\)/i)
    expect(out).toMatch(/fill="url\(#s\d+\)"/)
    expect(out).toMatch(/<linearGradient id="s\d+"/)
    expect(out).toMatch(/<stop offset="0" stop-color="#ff0000"\/>/)
    // 几何/变换/文本/颜色属性照留
    expect(out).toMatch(/transform="translate\(1 2\)"/)
    expect(out).toMatch(/<circle cx="5" cy="5" r="2" opacity="0.5"\/>/)
    expect(out).toMatch(/<path d="M0 0 L1 1" fill="none"\/>/)
    expect(out).toMatch(/<text x="1" y="1" font-size="3" text-anchor="middle">字<\/text>/)
    // 编辑器命名空间属性不是可见内容：静默丢掉（不因为 Inkscape 之类改过图就拒整本）
    expect(out).not.toMatch(/sodipodi/)
    // 根上必须有 xmlns：作为 <img> 独立渲染时没有它就不是一份 SVG
    expect(out).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    // 非渲染元数据不重建
    expect(out).not.toMatch(/<title>/)
  })

  it('script/style 与 style 属性剥除并记告警（活动内容/样式不是内容）', () => {
    const { facts, warnings } = run(FIGURE, 'image/svg+xml')
    if (facts.kind !== 'svg') throw new Error('unreachable')
    expect(facts.content).not.toMatch(/<script/)
    expect(facts.content).not.toMatch(/<style/)
    expect(facts.content).not.toMatch(/alert\(1\)/)
    expect(facts.content).not.toMatch(/fill:green/)
    expect(warnings.map((w) => w.code).sort()).toEqual(['epub-removed-active-content'])
    expect(warnings[0].resource).toBe('images/fig.bin（引用处 OEBPS/ch1.xhtml）')
    expect(warnings[0].message).toMatch(/script/)
  })

  it('script 里的内容不进产物：只留静态矢量图形，没有任何脚本面', () => {
    const facts = check(FIGURE, 'image/svg+xml')
    if (facts.kind !== 'svg') throw new Error('unreachable')
    expect(facts.content).not.toMatch(/script|onclick/i)
  })

  it('宽高：显式 width/height 优先，不可解析时退 viewBox，两者都缺才是未知（null）', () => {
    const fromViewBox = check(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="50%" height="50%" viewBox="0 0 10 20"><rect width="1" height="1"/></svg>'), 'image/svg+xml')
    expect(fromViewBox).toMatchObject({ width: 10, height: 20 })
    const unknown = check(SVG('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), 'image/svg+xml')
    expect(unknown).toMatchObject({ width: null, height: null })
    const withPx = check(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="12px" height="7px"><rect width="1" height="1"/></svg>'), 'image/svg+xml')
    expect(withPx).toMatchObject({ width: 12, height: 7 })
  })

  it('单图包装（只有一个 <image> 的书内栅格）：交回那张栅格，不交这份 SVG', () => {
    const facts = check(
      SVG('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 2 3">'
        + '<title>封面</title><image xlink:href="cover.png" width="2" height="3"/></svg>'),
      'image/svg+xml',
      { path: 'images/cover.svg' },
    )
    // href 按 SVG 自身目录解析（与正文链接同一套归档内寻址）
    expect(facts).toEqual({ kind: 'wrapper', path: 'images/cover.png' })
  })

  it('包装指向书外：报错（封面/插图的 SVG 不许把外链原样交给浏览器）', () => {
    expectEpubError(rejection(
      SVG('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://example.invalid/c.png"/></svg>'),
      'image/svg+xml',
    ), /scheme|书外|不支持/)
  })

  it('包装里带 <defs> 定义（渐变等不渲染的登记项）：仍是包装，不误判成「不止一张图」', () => {
    const facts = check(
      SVG('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 2 3">'
        + '<defs><linearGradient id="cov" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/></linearGradient></defs>'
        + '<image xlink:href="cover.png" width="2" height="3"/></svg>'),
      'image/svg+xml',
      { path: 'images/cover.svg' },
    )
    // defs 里的定义不渲染：可见节点只有那张栅格，包装判定不该被它带偏
    expect(facts).toEqual({ kind: 'wrapper', path: 'images/cover.png' })
  })

  it('url(...) 引用大小写不敏感：URL(#grad) 也要走重写，不留死链', () => {
    const facts = check(
      SVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
        + '<defs><linearGradient id="grad"><stop offset="0" stop-color="#000"/></linearGradient></defs>'
        + '<rect width="4" height="4" fill="URL(#grad)"/></svg>'),
      'image/svg+xml',
    )
    if (facts.kind !== 'svg') throw new Error('unreachable')
    expect(facts.content).not.toMatch(/url\(#grad\)/i)
    expect(facts.content).toMatch(/fill="url\(#s\d+\)"/)
  })

  it('可缩放但不止一张图的包装：不是包装，按独立 SVG 重建', () => {
    const facts = check(
      SVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="4" height="4" fill="#000"/></svg>'),
      'image/svg+xml',
    )
    expect(facts.kind).toBe('svg')
  })
})

describe('独立 SVG：不支持的可见能力要报错', () => {
  it('foreignObject（内嵌 HTML 的可见图形）：报错点名资源与元素', () => {
    const e = rejection(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
      + '<foreignObject width="10" height="10"><p>内嵌</p></foreignObject></svg>'), 'image/svg+xml')
    expectEpubError(e, /foreignObject/)
    expectEpubError(e, /images\/fig\.bin/)
  })

  it('use 外链：报错（绝不发请求，也不删掉这一块冒充成功）', () => {
    const e = rejection(SVG('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
      + '<use xlink:href="http://example.invalid/other.svg#a"/></svg>'), 'image/svg+xml')
    expectEpubError(e, /use/)
    expectEpubError(e, /images\/fig\.bin/)
  })

  it('未登记的渐变引用 url(#missing)：报错，不改写成别的东西', () => {
    const e = rejection(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
      + '<rect width="4" height="4" fill="url(#missing)"/></svg>'), 'image/svg+xml')
    expectEpubError(e, /missing/)
    expectEpubError(e, /渐变|不支持/)
  })

  it('渐变继承（xlink:href 指向另一处渐变）：报错，不把它当元数据删掉', () => {
    // 实测缺陷：`xlink:href` 落在「含 `:` 即丢掉」那条分支里，派生渐变被剥成空渐变——
    // 用它的图形失去填充却**不留任何告警**（图形看起来还在，其实少了）。这不是元数据，是引用。
    const e = rejection(SVG('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
      + '<defs><linearGradient id="base"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>'
      + '<linearGradient id="derived" xlink:href="#base"/></defs>'
      + '<rect width="10" height="10" fill="url(#derived)"/></svg>'), 'image/svg+xml')
    expectEpubError(e, /xlink:href/)
    expectEpubError(e, /images\/fig\.bin/)
    // 命名空间声明本身仍按元数据丢掉（别把 xmlns:xlink 也当成引用报错）
    const ok = check(SVG('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">'
      + '<rect width="4" height="4" fill="#123"/></svg>'), 'image/svg+xml')
    expect(ok.kind).toBe('svg')
  })

  it('SVG 里的 <image>（嵌套栅格）不走包装那条路时：报错不改写成外链', () => {
    expectEpubError(rejection(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
      + '<rect width="1" height="1"/><image href="cover.png" width="2" height="2"/></svg>'), 'image/svg+xml'), /image|不支持/)
  })

  it('根元素不是 svg（声明成 svg 的其实是别的 XML）：报错', () => {
    expectEpubError(rejection(SVG('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>'), 'image/svg+xml'), /svg/)
  })

  it('SVG 里的实体声明：走 XML 层同一道门，拒绝且不展开', () => {
    const e = rejection(Buffer.from('<?xml version="1.0"?>\n<!DOCTYPE svg [ <!ENTITY boom "BOOM"> ]>'
      + '<svg xmlns="http://www.w3.org/2000/svg">&boom;</svg>', 'utf8'), 'image/svg+xml')
    expectEpubError(e, /实体|内部子集/)
    expect(e.message).not.toContain('BOOM')
  })

  it('SVG 的 DOM 超预算：报错点名资源与预算（结构炸弹不许爆栈）', () => {
    const deep = SVG('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1">' + '<g>'.repeat(200) + '</g>'.repeat(200) + '</svg>')
    expectEpubError(rejection(deep, 'image/svg+xml'), /深度/)
    expectEpubError(rejection(deep, 'image/svg+xml'), /images\/fig\.bin/)
  })

  it('未知的呈现属性（可能改变可见外观）报错；纯元数据属性静默丢掉', () => {
    const e = rejection(SVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
      + '<rect width="4" height="4" filter="url(#f)"/></svg>'), 'image/svg+xml')
    expectEpubError(e, /filter/)
  })
})
