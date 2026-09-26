/**
 * 包层测试：OPF 包结构、阅读顺序（spine）、目录目标（nav/NCX）、编码与包级拒绝。
 *
 * 本任务**不产出**最终 opaque 的 documentId/anchorId，也不把目标转成 wire 的 ReadingTarget——
 * 那一步要等文档与锚点映射建立之后才成立，所以这里断言的是原始路径与片段：
 * `{ path: 'OEBPS/ch1.xhtml', fragment: 'a' }`。
 *
 * 三条口径决定了这里的断言方式：
 * ① 阅读顺序只按 spine 的 linear 主序列——ZIP 条目顺序、目录叶条数都不参与（样本故意把 ZIP 顺序排反）；
 * ② 目录是独立的树，可以和阅读单元不是一一对应（同一文档两个锚点各自成条）；
 * ③ 缺目录可以按 spine 造平面导航并留告警，**已有却损坏**的目录必须报错（坏目录不许冒充成功）。
 */
import { describe, expect, it } from 'vitest'
import { openEpubArchive, type EpubArchive, type EpubLimits } from '../../src/services/epub/archive.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { readEpubPackage, resolveEpubHref, type EpubHref, type EpubPackage } from '../../src/services/epub/package.js'
import { decodeEpubXml, parseXml } from '../../src/services/epub/xml.js'
import { makeEpubFixture } from '../fixtures/epub.js'

/** 开归档 → 读包 → 交给断言；读完一律关归档（预期拒绝时也不许把句柄漏在半开状态） */
async function withBook<T>(name: string, fn: (book: EpubPackage, archive: EpubArchive) => T, limits?: Partial<EpubLimits>): Promise<T> {
  const archive = await openEpubArchive(makeEpubFixture(name))
  try {
    return fn(await readEpubPackage(archive, limits), archive)
  } finally {
    archive.close()
  }
}

/** 收下被拒绝的异常：断言要同时看「哪个类」与「点名了谁」 */
async function packageRejection(name: string, limits?: Partial<EpubLimits>): Promise<Error> {
  const archive = await openEpubArchive(makeEpubFixture(name))
  try {
    try {
      await readEpubPackage(archive, limits)
    } catch (e) {
      return e as Error
    }
  } finally {
    archive.close()
  }
  throw new Error(`预期拒绝，实际成功——坏包冒充可读是本仓的最高罪（样本：${name}）`)
}

/** 断言异常是 EPUB 导入错，且报错点名了出问题的条目/资源/书内位置 */
function expectEpubError(e: Error, pattern: RegExp): void {
  expect(e.name).toBe('EpubImportError')
  expect(e).toBeInstanceOf(EpubImportError)
  expect(e.message).toMatch(pattern)
}

/** 导航目标就是「路径 + 可空片段」这一对原始值 */
function target(path: string, fragment: string | null): EpubHref {
  return { path, fragment }
}

describe('epub3-rich：阅读顺序按 spine，不按 ZIP 顺序或目录叶数', () => {
  it('按 spine 阅读，不按 ZIP 或目录叶节点计章', async () => {
    await withBook('epub3-rich', (book, archive) => {
      expect(book.spine).toEqual(['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml'])
      // 样本里 ZIP 条目顺序故意相反：条目表 ch2 在 ch1 前，阅读序列仍是 ch1 → ch2
      const zipOrder = archive.entries.map((e) => e.name)
      expect(zipOrder.indexOf('OEBPS/ch2.xhtml')).toBeLessThan(zipOrder.indexOf('OEBPS/ch1.xhtml'))
    })
  })

  it('linear="no" 的补充文档不进主序列，也不被当第三章', async () => {
    await withBook('epub3-rich', (book) => {
      expect(book.spineItems.map((s) => [s.idref, s.linear])).toEqual([
        ['ch1', true],
        ['ch2', true],
        ['notes', false],
      ])
      expect(book.spine).not.toContain('OEBPS/notes.xhtml')
      // 它仍在 manifest 里（补充文档按需可读），只是不接进阅读流
      expect(book.manifest.get('notes')).toMatchObject({ path: 'OEBPS/notes.xhtml', mediaType: 'application/xhtml+xml' })
      // 目录叶三条 + 卷组一条，没有被 notes 变成第四条叶
      expect(book.navigation[0].children).toHaveLength(3)
    })
  })

  it('三个叶导航目标分别保留：同文档两个锚点各自成条', async () => {
    await withBook('epub3-rich', (book) => {
      expect(book.navigationSource).toBe('nav')
      expect(book.navigation).toHaveLength(1)
      const [group] = book.navigation
      expect(group.label).toBe('第一卷')
      // 卷组只有标题没有目标（分组标题才允许 null）
      expect(group.target).toBeNull()
      expect(group.children.map((c) => [c.label, c.target])).toEqual([
        ['甲', target('OEBPS/ch1.xhtml', 'a')],
        ['乙', target('OEBPS/ch1.xhtml', 'b')],
        ['丙', target('OEBPS/ch2.xhtml', 'c')],
      ])
    })
  })

  it('landmarks / page-list 不混进正文目录', async () => {
    await withBook('epub3-rich', (book) => {
      const labels: string[] = []
      const walk = (items: EpubPackage['navigation']): void => {
        for (const item of items) {
          labels.push(item.label)
          walk(item.children)
        }
      }
      walk(book.navigation)
      // 导航文档里另有 landmarks（正文）与 page-list（1）：两条都不许进阅读目录
      expect(labels).toEqual(['第一卷', '甲', '乙', '丙'])
    })
  })

  it('书名/作者来自 dc 元数据，封面候选走 cover-image 属性', async () => {
    await withBook('epub3-rich', (book) => {
      expect(book.title).toBe('图文样本')
      expect(book.author).toBe('样本作者')
      expect(book.coverCandidates.map((c) => [c.id, c.path, c.mediaType])).toEqual([['cover-img', 'OEBPS/cover.png', 'image/png']])
    })
  })

  it('manifest 按 id 登记路径/媒体类型/properties', async () => {
    await withBook('epub3-rich', (book) => {
      expect([...book.manifest.keys()]).toEqual(['ch1', 'ch2', 'notes', 'nav', 'cover-img'])
      expect(book.manifest.get('ch2')).toMatchObject({ path: 'OEBPS/ch2.xhtml', mediaType: 'application/xhtml+xml' })
      expect(book.manifest.get('nav')?.properties).toEqual(['nav'])
    })
  })

  it('正常样本没有告警（告警不许在好书上刷存在感）', async () => {
    await withBook('epub3-rich', (book) => {
      expect(book.warnings).toEqual([])
    })
  })
})

describe('epub2-basic：EPUB2 用 spine 的 toc 指向的 NCX', () => {
  it('NCX 层级：父节点自己也有目标，子节点跟在其下', async () => {
    await withBook('epub2-basic', (book) => {
      expect(book.navigationSource).toBe('ncx')
      expect(book.navigation.map((n) => [n.label, n.target, n.children.map((c) => [c.label, c.target])])).toEqual([
        ['上卷', target('OEBPS/ch1.xhtml', 'a'), [['第一章', target('OEBPS/ch1.xhtml', 'b')]]],
        ['第二章', target('OEBPS/ch2.xhtml', null), []],
      ])
    })
  })

  it('NCX 里的标准外部 DOCTYPE 被忽略（不 resolve、不请求）', async () => {
    await withBook('epub2-basic', (book) => {
      // 解析成功本身就是读数：带外部 DOCTYPE 的 NCX 照读，且 EPUB2 用 NCX 是常态，不该有降级告警
      expect(book.navigation.length).toBeGreaterThan(0)
      expect(book.warnings).toEqual([])
    })
  })

  it('EPUB2 封面走 meta name="cover"，路径按 OPF 目录解析', async () => {
    await withBook('epub2-basic', (book) => {
      expect(book.coverCandidates.map((c) => [c.id, c.path])).toEqual([['cover-img', 'OEBPS/images/cover.png']])
    })
  })
})

describe('epub3-namespaced：命名空间前缀不参与判定', () => {
  it('前缀版的 OPF 与 nav 文档一样认（按本地名）', async () => {
    await withBook('epub3-namespaced', (book) => {
      expect(book.title).toBe('前缀样本')
      expect(book.author).toBe('前缀作者')
      expect(book.spine).toEqual(['OEBPS/ch1.xhtml'])
      expect(book.navigation.map((n) => [n.label, n.target])).toEqual([['甲', target('OEBPS/ch1.xhtml', 'a')]])
    })
  })
})

describe('epub3-paths：百分号、中文、空格与书内 `../`', () => {
  it('href 按 URI 规则解一次：`../` 留在书内，百分号/中文/空格落到真实条目名上', async () => {
    await withBook('epub3-paths', (book) => {
      expect(book.manifest.get('ch1')?.path).toBe('OEBPS/text/中文 章节.xhtml')
      expect(book.spine).toEqual(['OEBPS/text/中文 章节.xhtml'])
      expect(book.navigation.map((n) => n.target)).toEqual([
        target('OEBPS/text/中文 章节.xhtml', 'a'),
        // 只有 fragment 的条目落在导航文档自己身上（同文档锚点）
        target('OEBPS/nav/nav.xhtml', 'top'),
      ])
    })
  })
})

describe('编码：BOM 优先，声明的编码照办，非法字节不猜', () => {
  it('UTF-16LE BOM 的 OPF：按 BOM 解码', async () => {
    await withBook('epub3-utf16-bom', (book) => {
      expect(book.title).toBe('BOM 样本')
      expect(book.spine).toEqual(['OEBPS/ch1.xhtml'])
    })
  })

  it('声明的 iso-8859-1 按该编码解（不套 UTF-8，也不回退 GBK）', async () => {
    await withBook('epub2-latin1', (book) => {
      expect(book.title).toBe('Café')
    })
  })

  it('声明 UTF-8 却含非法字节：拒绝，并点名书内位置', async () => {
    expectEpubError(await packageRejection('epub3-invalid-utf8'), /OEBPS\/content\.opf/)
    expectEpubError(await packageRejection('epub3-invalid-utf8'), /UTF-8|编码/)
  })

  it('decodeEpubXml 是 BOM/声明解码的唯一入口', () => {
    const utf8 = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><a>样本</a>', 'utf8')
    expect(decodeEpubXml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]))).toBe(utf8.toString('utf8'))
    // BOM 优先于声明：声明写的是 iso-8859-1，字节其实是带 BOM 的 UTF-8——按 BOM 解才不会把「样本」解成乱码
    const lying = Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><a>样本</a>', 'utf8')
    expect(decodeEpubXml(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lying]))).toBe(lying.toString('utf8'))
    // UTF-16 的 LE / BE 都按 BOM 走
    const utf16le = Buffer.from('\ufeff<?xml version="1.0" encoding="utf-16"?><a>样本</a>', 'utf16le')
    expect(decodeEpubXml(utf16le)).toBe('<?xml version="1.0" encoding="utf-16"?><a>样本</a>')
    const body = Buffer.from('<?xml version="1.0"?><a>样本</a>', 'utf16le')
    expect(decodeEpubXml(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body).swap16()]))).toBe('<?xml version="1.0"?><a>样本</a>')
  })

  it('非法 UTF-8 直接抛，不返回替换字符冒充正文', () => {
    const bad = Buffer.from([0x3c, 0x61, 0x3e, 0x80, 0x3c, 0x2f, 0x61, 0x3e])   // <a>\x80</a>
    expect(() => decodeEpubXml(bad)).toThrow(EpubImportError)
    expect(() => decodeEpubXml(bad)).toThrow(/UTF-8|编码/)
  })

  it('声明了不认识的编码：报错，不猜', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="x-no-such-charset"?><a>1</a>', 'utf8')
    expect(() => decodeEpubXml(buf)).toThrow(/x-no-such-charset/)
  })

  it('CDATA 里是字面文本：不当实体被拒，也不丢内容', async () => {
    await withBook('epub3-cdata', (book) => {
      expect(book.title).toBe('书 &nbsp; 名')
    })
  })
})

describe('导航派生顺序：nav → NCX → spine', () => {
  it('nav 与 NCX 同时存在：nav 优先，不算降级', async () => {
    await withBook('epub3-nav-and-ncx', (book) => {
      expect(book.navigationSource).toBe('nav')
      expect(book.navigation.map((n) => n.label)).toEqual(['nav 的目录'])
      expect(book.warnings).toEqual([])
    })
  })

  it('EPUB3 没 nav 但 spine 的 toc 指向 NCX：读 NCX 并记降级说明', async () => {
    await withBook('epub3-ncx-fallback', (book) => {
      expect(book.navigationSource).toBe('ncx')
      expect(book.navigation.map((n) => n.label)).toEqual(['上卷', '第二章'])
      expect(book.warnings).toHaveLength(1)
      expect(book.warnings[0].code).toBe('epub-navigation-degraded')
      expect(book.warnings[0].resource).toBe('OEBPS/toc.ncx')
      expect(book.warnings[0].message).toMatch(/NCX/)
    })
  })

  it('没有 nav 也没有 NCX：按 spine 造平面导航并留持久告警', async () => {
    await withBook('epub3-no-nav', (book) => {
      expect(book.navigationSource).toBe('spine')
      expect(book.navigation.map((n) => [n.label, n.target, n.children])).toEqual([
        ['ch1', target('OEBPS/ch1.xhtml', null), []],
        ['ch2', target('OEBPS/ch2.xhtml', null), []],
      ])
      expect(book.warnings.map((w) => w.code)).toEqual(['epub-navigation-synthesized'])
      expect(book.warnings[0].resource).toBeNull()
    })
  })

  it('有 nav 文档却没有 toc 导航（只有 landmarks/page-list）：报错，不静默降级', async () => {
    expectEpubError(await packageRejection('epub3-nav-broken'), /toc/)
    expectEpubError(await packageRejection('epub3-nav-broken'), /OEBPS\/nav\.xhtml/)
  })

  it('导航指向归档里不存在的目标：报错并点名目标', async () => {
    expectEpubError(await packageRejection('epub3-nav-missing-target'), /gone\.xhtml/)
  })
})

describe('XML 只读解析：DTD 与实体不解析', () => {
  it('标准外部 DOCTYPE 可忽略，但引用未声明的外部实体即拒', async () => {
    // 声明里有外部 DTD（丢掉），正文却引用了 `&external;`：本层不 resolve DTD，认不出就该拒
    expectEpubError(await packageRejection('epub-entity-external'), /实体/)
    expectEpubError(await packageRejection('epub-entity-external'), /external/)
  })

  it('内部实体声明 + 引用：拒，且不许展开', async () => {
    const e = await packageRejection('epub-entity-internal')
    expectEpubError(e, /实体|内部子集/)
    // 「展开」过的值一旦进了正文（或报错文案），就说明解析器真的替书里执行了实体替换
    expect(e.message).not.toContain('BOOM')
  })

  it('good 路径：无内部子集的 DOCTYPE 不拦（nav/NCX 都照读）', async () => {
    // epub3-rich 的 nav 与 epub2-basic 的 NCX 都带标准外部 DOCTYPE，两本都读得出来
    await withBook('epub3-rich', (book) => expect(book.navigationSource).toBe('nav'))
    await withBook('epub2-basic', (book) => expect(book.navigationSource).toBe('ncx'))
  })
})

describe('包结构的拒绝', () => {
  it('缺 mimetype：EPUB 身份不成立', async () => {
    expectEpubError(await packageRejection('epub-missing-mimetype'), /mimetype/)
  })

  it('缺 META-INF/container.xml：连 OPF 都定位不到', async () => {
    expectEpubError(await packageRejection('epub-missing-container'), /META-INF\/container\.xml/)
  })

  it('container 指向的 OPF 不在归档里', async () => {
    expectEpubError(await packageRejection('epub-missing-opf'), /OEBPS\/content\.opf/)
  })

  it('rootfile 的 media-type 不受支持', async () => {
    expectEpubError(await packageRejection('epub-bad-rootfile'), /rootfile/)
  })

  it('rootfile 指向的不是 OPF 包文档', async () => {
    expectEpubError(await packageRejection('epub-rootfile-not-opf'), /不是 OPF/)
  })

  it('多个 rootfile：取 container 顺序里第一个受支持的，不拼书', async () => {
    await withBook('epub-multi-rootfile', (book) => {
      expect(book.title).toBe('甲本')
      expect(book.spine).toEqual(['OEBPS/ch1.xhtml'])
      // 第二本书的 manifest 没有被并进来
      expect(book.manifest.has('ch2')).toBe(false)
    })
  })

  it('spine 的 idref 不在 manifest 里', async () => {
    expectEpubError(await packageRejection('epub-spine-missing-idref'), /nope/)
  })

  it('同一 idref 在 spine 里重复：拒绝（否则锚点目标有歧义）', async () => {
    expectEpubError(await packageRejection('epub-spine-duplicate-idref'), /重复/)
  })

  it('空主序列（只有 linear="no"）：没有可读正文即失败', async () => {
    expectEpubError(await packageRejection('epub-empty-spine'), /主序列/)
  })

  it('spine 指向的文档不在归档里：悬空阅读单元同样报错', async () => {
    // 与导航目标的存在性校验同口径：manifest 写得出路径不等于归档里真有那份文档
    expectEpubError(await packageRejection('epub-spine-missing-entry'), /OEBPS\/ghost\.xhtml/)
    expectEpubError(await packageRejection('epub-spine-missing-entry'), /spine/)
  })

  it('两个 idref 指向同一路径：也拒（idref 不同不等于阅读单元不同）', async () => {
    expectEpubError(await packageRejection('epub-spine-duplicate-path'), /重复/)
    expectEpubError(await packageRejection('epub-spine-duplicate-path'), /OEBPS\/ch1\.xhtml/)
  })
})

describe('路径失败一律带书内的出处文档', () => {
  it('manifest 的 href 逃出书根：点名出处的 OPF', async () => {
    expectEpubError(await packageRejection('epub-bad-manifest-href'), /越出书根/)
    expectEpubError(await packageRejection('epub-bad-manifest-href'), /OEBPS\/content\.opf/)
  })

  it('导航文档的 href 逃出书根：点名出处的导航文档（不是 OPF）', async () => {
    expectEpubError(await packageRejection('epub3-nav-bad-href'), /越出书根/)
    expectEpubError(await packageRejection('epub3-nav-bad-href'), /OEBPS\/nav\.xhtml/)
  })

  it('容器 rootfile 的 full-path 逃出书根：点名出处的 container.xml', async () => {
    // 这一处的基准是归档根（没有文档名可当基准），出处由调用方补：报错仍要指名去翻哪份文件
    expectEpubError(await packageRejection('epub-bad-rootfile-path'), /越出书根/)
    expectEpubError(await packageRejection('epub-bad-rootfile-path'), /META-INF\/container\.xml/)
  })
})

describe('固定版式 / 主序列脚本 / 内容加密', () => {
  it('EPUB3 rendition:layout=pre-paginated：拒绝', async () => {
    expectEpubError(await packageRejection('epub3-fixed-layout'), /pre-paginated/)
  })

  it('EPUB2 的 fixed-layout 元数据：拒绝', async () => {
    expectEpubError(await packageRejection('epub2-fixed-layout'), /fixed-layout/)
  })

  it('固定版式只声明在 itemref 上（包级没有 meta）：同样拒绝', async () => {
    expectEpubError(await packageRejection('epub3-itemref-fixed-layout'), /pre-paginated/)
    expectEpubError(await packageRejection('epub3-itemref-fixed-layout'), /OEBPS\/ch1\.xhtml/)
  })

  it('主序列文档被声明为 scripted：拒绝（读端不执行书内脚本）', async () => {
    expectEpubError(await packageRejection('epub3-scripted'), /scripted/)
  })

  it('encryption.xml 指向主序列正文：拒绝，不提供解密', async () => {
    expectEpubError(await packageRejection('epub-drm-content'), /OEBPS\/ch1\.xhtml/)
    expectEpubError(await packageRejection('epub-drm-content'), /加密/)
  })

  it('字体混淆只影响未使用的字体：整本照读，只留一条点名资源的告警', async () => {
    await withBook('epub-font-obfuscated', (book) => {
      expect(book.spine).toEqual(['OEBPS/ch1.xhtml'])
      // 加密告警点名资源；本样本没有目录，故另有一条合成目录的告警（与加密无关）
      expect(book.warnings.map((w) => [w.code, w.resource])).toEqual([
        ['epub-encrypted-resource', 'OEBPS/fonts/font.otf'],
        ['epub-navigation-synthesized', null],
      ])
    })
  })

  it('未使用的音频不把整本误判成有声书（不拒、也不多告警）', async () => {
    await withBook('epub-audio-unused', (book) => {
      expect(book.spine).toEqual(['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml'])
      expect(book.warnings.map((w) => w.code)).toEqual(['epub-navigation-synthesized'])
    })
  })
})

describe('预算：XML 单文档上限', () => {
  it('缩紧 XML 预算即报错（超限不截断成成功），并点名超限的那份文档', async () => {
    // container.xml 约 239 字节、OPF 更大：预算 300 时容器读得进、OPF 越界
    expectEpubError(await packageRejection('epub3-rich', { xmlBytes: 300 }), /上限/)
    expectEpubError(await packageRejection('epub3-rich', { xmlBytes: 300 }), /OEBPS\/content\.opf/)
  })

  it('超深导航文档：EpubImportError 点名文档与深度预算，不是 RangeError', async () => {
    // 两万层嵌套：没有深度预算的递归走法在这里会吃穿调用栈（宿主抛 RangeError，按类分流会漏成 500）
    const e = await packageRejection('epub3-nav-too-deep')
    expectEpubError(e, /OEBPS\/nav\.xhtml/)
    expectEpubError(e, /深度/)
    expect(e.message).toMatch(/128/)
    // 异常类就是本子树的类，且不许是栈溢出（名字里带 RangeError 就说明预算没生效）
    expect(e.constructor.name).toBe('EpubImportError')
  })

  it('超宽导航文档：节点数超限同样报错，并点名节点预算', async () => {
    // 样本本身是合法目录（目标都存在）：默认预算下读得出三百条，缩到 100 后才越界——
    // 拒绝来自预算，不是样本自身坏掉
    await withBook('epub3-nav-too-wide', (book) => {
      expect(book.navigation).toHaveLength(300)
    })
    const e = await packageRejection('epub3-nav-too-wide', { xmlNodes: 100 })
    expectEpubError(e, /OEBPS\/nav\.xhtml/)
    expectEpubError(e, /节点/)
    expect(e.message).toMatch(/100/)
  })
})

describe('xml：只读解析与单文档预算（深/宽文档不许爆栈）', () => {
  const budget = (over: Partial<{ depth: number; nodes: number }> = {}) => ({
    what: 'OEBPS/x.xhtml', depth: 128, nodes: 200_000, ...over,
  })

  it('深度超限：EpubImportError 点名文档与深度预算', () => {
    const deep = '<r>' + '<a>'.repeat(200) + '</a>'.repeat(200) + '</r>'
    expect(() => parseXml(deep, budget({ depth: 32 }))).toThrow(EpubImportError)
    expect(() => parseXml(deep, budget({ depth: 32 }))).toThrow(/OEBPS\/x\.xhtml/)
    expect(() => parseXml(deep, budget({ depth: 32 }))).toThrow(/深度/)
  })

  it('节点数超限：EpubImportError 点名文档与节点预算', () => {
    const wide = '<r>' + '<i/>'.repeat(50) + '</r>'
    expect(() => parseXml(wide, budget({ nodes: 10 }))).toThrow(/节点/)
    expect(() => parseXml(wide, budget({ nodes: 10 }))).toThrow(/10/)
  })

  it('预算内的文档照读：同一份文本放宽预算即通过', () => {
    const ok = '<r>' + '<i/>'.repeat(50) + '</r>'
    expect(parseXml(ok, budget({ nodes: 60 })).name).toBe('r')
  })
})

describe('resolveEpubHref：归档内 href 的唯一解析口', () => {
  it('同级相对路径按文档目录解析', () => {
    expect(resolveEpubHref('OEBPS/ch1.xhtml', 'ch2.xhtml')).toEqual(target('OEBPS/ch2.xhtml', null))
  })

  it('`../` 留在书内是合法的（不是 zip-slip）', () => {
    expect(resolveEpubHref('OEBPS/text/ch1.xhtml', '../Images/x.png')).toEqual(target('OEBPS/Images/x.png', null))
    // OPF 深一层时同样成立（fixture 的 epub3-paths 走的就是这条）
    expect(resolveEpubHref('OEBPS/pkg/content.opf', '../text/x.xhtml')).toEqual(target('OEBPS/text/x.xhtml', null))
  })

  it('逃出书根才拒', () => {
    expect(() => resolveEpubHref('OEBPS/ch1.xhtml', '../../x.xhtml')).toThrow(/越出书根/)
    expect(() => resolveEpubHref('', '../x.xhtml')).toThrow(/越出书根/)
  })

  it('百分号只解一次，中文与空格落到条目名上', () => {
    expect(resolveEpubHref('OEBPS/ch1.xhtml', '%E4%B8%AD%20a.xhtml')).toEqual(target('OEBPS/中 a.xhtml', null))
    // `%2520` 解一次得到字面 `%20`，不再二次解码
    expect(resolveEpubHref('OEBPS/ch1.xhtml', 'a%2520b.xhtml')).toEqual(target('OEBPS/a%20b.xhtml', null))
  })

  it('fragment 与路径分开；空 fragment 当没有', () => {
    expect(resolveEpubHref('OEBPS/ch1.xhtml', 'ch2.xhtml#c')).toEqual(target('OEBPS/ch2.xhtml', 'c'))
    expect(resolveEpubHref('OEBPS/ch1.xhtml', 'ch1.xhtml#')).toEqual(target('OEBPS/ch1.xhtml', null))
    // fragment 里的百分号同样只解一次
    expect(resolveEpubHref('OEBPS/ch1.xhtml', 'ch1.xhtml#a%20b')).toEqual(target('OEBPS/ch1.xhtml', 'a b'))
  })

  it('只有 fragment 时落在文档自己身上', () => {
    expect(resolveEpubHref('OEBPS/ch1.xhtml', '#a')).toEqual(target('OEBPS/ch1.xhtml', 'a'))
  })

  it('不支持的 scheme 一律拒（书外资源不寻址）', () => {
    for (const href of ['http://example.com/x.xhtml', 'https://example.com/x', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      expect(() => resolveEpubHref('OEBPS/ch1.xhtml', href)).toThrow(/scheme/)
    }
  })

  it('绝对路径拒（书内寻址只认相对引用）', () => {
    expect(() => resolveEpubHref('OEBPS/ch1.xhtml', '/OEBPS/ch1.xhtml')).toThrow(/绝对路径/)
  })

  it('查询串不参与归档寻址（指向的仍是那个条目）', () => {
    expect(resolveEpubHref('OEBPS/ch1.xhtml', 'ch2.xhtml?v=1')).toEqual(target('OEBPS/ch2.xhtml', null))
  })

  it('解码后含 NUL 或反斜杠拒（同一类名字歧义）', () => {
    expect(() => resolveEpubHref('OEBPS/ch1.xhtml', 'ch%001.xhtml')).toThrow(/NUL/)
    expect(() => resolveEpubHref('OEBPS/ch1.xhtml', 'a\\b.xhtml')).toThrow(/反斜杠/)
  })

  it('坏掉的百分号序列与空 href 都拒', () => {
    expect(() => resolveEpubHref('OEBPS/ch1.xhtml', 'a%ZZ.xhtml')).toThrow(/百分号|URI/)
    expect(() => resolveEpubHref('OEBPS/ch1.xhtml', '  ')).toThrow(/空/)
  })

  it('每一条路径失败都带出处文档（只说「越出书根」无从知道是哪份文档里的链接）', () => {
    const from = 'OEBPS/text/x.xhtml'
    for (const href of ['../../../etc/passwd', 'javascript:alert(1)', '/abs/x.xhtml', 'a\\b.xhtml', 'ch%001.xhtml', 'a%ZZ.xhtml', '  ']) {
      expect(() => resolveEpubHref(from, href), `${from} ← ${href}`).toThrow(from)
    }
  })
})
