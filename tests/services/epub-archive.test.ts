import { describe, expect, it } from 'vitest'
import { DEFAULT_EPUB_LIMITS, openEpubArchive, type EpubArchive, type EpubLimits } from '../../src/services/epub/archive.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { makeEpubFixture } from '../fixtures/epub.js'

/** 收下被拒绝的异常：断言要同时看「哪个类」与「点名了谁」，所以要拿到 error 本体。
 *  万一没拒（坏归档冒充可读是本仓的最高罪），把已经开出来的归档关掉再炸：测试自己也不许把句柄
 *  漏在半开状态，否则这一例失败后的读数会被上一例的泄漏带偏。 */
async function openRejection(name: string, limits?: Partial<EpubLimits>): Promise<Error> {
  let archive: EpubArchive
  try {
    // 打开阶段的拒绝：安全门在 open 就判，坏归档不给句柄（不给句柄就谈不上「有过部分输出」）
    archive = await openEpubArchive(makeEpubFixture(name), limits)
  } catch (e) {
    return e as Error
  }
  archive.close()
  throw new Error(`预期拒绝，实际成功——坏归档冒充可读是本仓的最高罪（样本：${name}）`)
}

/** 同上，用于「归档本身开得出来、某一条读不出」的样本 */
async function readRejection(archive: EpubArchive, name: string, maxBytes?: number): Promise<Error> {
  try {
    await archive.read(name, maxBytes)
  } catch (e) {
    return e as Error
  }
  archive.close()
  throw new Error(`预期拒绝，实际成功——坏归档冒充可读是本仓的最高罪（条目：${name}）`)
}

/** 断言异常是 EPUB 导入错，且报错点名了出问题的条目/资源 */
function expectEpubError(e: Error, pattern: RegExp): void {
  expect(e.name).toBe('EpubImportError')
  expect(e).toBeInstanceOf(EpubImportError)
  expect(e.message).toMatch(pattern)
}

describe('zip-baseline：正常样本读得回来', () => {
  it('条目表按中央目录顺序，读取内容逐字对得上', async () => {
    const archive = await openEpubArchive(makeEpubFixture('zip-baseline'))
    try {
      expect(archive.entries.map((e) => e.name)).toEqual([
        'mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/ch1.xhtml',
      ])
      expect((await archive.read('mimetype')).toString('utf8')).toBe('application/epub+zip')
      const ch1 = (await archive.read('OEBPS/ch1.xhtml')).toString('utf8')
      expect(ch1).toContain('<h1>第1章</h1>')
      // 声明大小与实际大小在同一份正常样本里也必须一致（读端的长度核对不靠声明，这里只是交叉验证）
      expect(archive.entries[3].size).toBe(Buffer.byteLength(ch1, 'utf8'))
    } finally {
      archive.close()
    }
  })

  it('close 幂等：调用方 finally 里再关一次不炸', async () => {
    const archive = await openEpubArchive(makeEpubFixture('zip-baseline'))
    archive.close()
    archive.close()
    await expect(archive.read('mimetype')).rejects.toThrow(/已关闭/)
  })
})

describe('打开阶段的安全门（解压任何字节之前）', () => {
  // 以下四条的共同前提：**先拒的其实是 yauzl 的 `validateFileName`**——它无条件拒含反斜杠、绝对路径
  // （盘符或前导 `/`）与任一 `..` 段的名字，与 `strictFileNames` 无关。所以这四条验的是「恶意归档被拒」
  // （这条读数本身有意义），但**不能**证明本层同名判据存在；本层在那几形态上是纵深防御。
  // 只有本层拦得住的两类（条目名含 NUL、归一后为空）在本 describe 末尾单独钉住。
  it('zip-slip：条目名越出归档根', async () => {
    // 名字里的 `..` 段由 yauzl 的 validateFileName 先拒；本层同一条判据是纵深防御，不是唯一防线
    expectEpubError(await openRejection('zip-slip'), /\.\.\/evil\.txt/)
  })

  it('absolute-path：条目名是绝对路径', async () => {
    // 前导 `/` 由 yauzl 的 validateFileName 先拒（报 "absolute path"）；本层判据是纵深防御
    expectEpubError(await openRejection('absolute-path'), /\/etc\/passwd/)
  })

  it('windows-drive：条目名带盘符', async () => {
    // 盘符同样落进 yauzl 的绝对路径判据（它先拒）；本层判据是纵深防御
    expectEpubError(await openRejection('windows-drive'), /C:\/evil\.txt/)
  })

  it('backslash-path：条目名含反斜杠', async () => {
    // 反斜杠由 yauzl 的 validateFileName 先拒（strictFileNames 的作用是不让它被折成 `/`）；本层判据是纵深防御
    expectEpubError(await openRejection('backslash-path'), /OEBPS\\ch1\.xhtml/)
  })

  it('duplicate-path：同一逻辑名的两个条目', async () => {
    expectEpubError(await openRejection('duplicate-path'), /重名.*OEBPS\/ch1\.xhtml/)
  })

  it('symlink：条目是符号链接（可能指向书外）', async () => {
    expectEpubError(await openRejection('symlink'), /符号链接.*OEBPS\/ch1\.xhtml/)
  })

  it('encrypted-entry：ZIP 加密位打开，本插件不解密', async () => {
    expectEpubError(await openRejection('encrypted-entry'), /加密.*OEBPS\/ch1\.xhtml/)
  })

  it('unsupported-method：只接受 store/deflate', async () => {
    expectEpubError(await openRejection('unsupported-method'), /压缩方式 9.*OEBPS\/ch1\.xhtml/)
  })

  it('entry-limit：条目数超过预算（样本 6 条，预算 5）', async () => {
    expectEpubError(await openRejection('entry-limit', { entries: 5 }), /条目数超过上限 5/)
  })

  // 上面那条只把预算缩到 5 走同一条代码路径；设计定的那个数（10_000）原先没有任何实证——
  // 计数从 0 起还是从 1 起、`>=` 与 `>` 写反，都能让「5 条时红」而真机上放进来 10_001 条。
  it('真实上限实证：恰好 10_000 条在默认预算下打得开（等于上限不是越界）', async () => {
    const archive = await openEpubArchive(makeEpubFixture('entry-limit-exact'))
    try {
      expect(archive.entries).toHaveLength(10_000)
    } finally {
      archive.close()
    }
  })

  it('真实上限实证：10_001 条在默认预算下被拒，点名上限与越界那条', async () => {
    expectEpubError(await openRejection('entry-limit-over'), /条目数超过上限 10000（第 10001 条/)
  })

  it('条目名含 NUL：yauzl 不拦，本层是唯一防线', async () => {
    // NUL 会截断下游一切把名字当 C 字符串/路径段的地方；含 NUL 的名字在 yauzl 那里一路畅通，
    // 所以这条断言命中的只能是本层的报错（yauzl 的失败文案里没有 NUL 二字）
    const e = await openRejection('nul-entry-name')
    expectEpubError(e, /含 NUL/)
    expectEpubError(e, /bad/)
  })

  it('条目名归一后为空（`.`）：yauzl 不拦，本层是唯一防线', async () => {
    // `.` 段会被本层归一剔掉，剔完什么都不剩——这种「名字存在但指不到任何东西」的条目同样是本层独占的判据
    const e = await openRejection('dot-entry-name')
    expectEpubError(e, /归一后为空/)
    // 报错要把原始名字照出来，否则用户与日志都无从下手
    expect(e.message).toContain('"."')
  })

  it('truncated-zip：连中央目录都定位不到', async () => {
    expectEpubError(await openRejection('truncated-zip'), /不是可读的 ZIP 归档/)
  })

  it('未超预算的样本照常打开（预算覆盖只改指定的那一项）', async () => {
    const archive = await openEpubArchive(makeEpubFixture('zip-baseline'), { entries: 100, entryBytes: 1 << 20 })
    try {
      expect(archive.entries).toHaveLength(4)
      expect((await archive.read('OEBPS/ch1.xhtml')).length).toBeGreaterThan(0)
    } finally {
      archive.close()
    }
  })
})

describe('read 阶段的内容校验（读到才判，失败即关）', () => {
  it('CRC 损坏不冒充可读 EPUB', async () => {
    const archive = await openEpubArchive(makeEpubFixture('crc-mismatch'))
    try {
      // 打开成功本身就是一条读数：CRC 只在流中核，说明中央目录扫描没解压任何字节
      const e = await readRejection(archive, 'OEBPS/ch1.xhtml')
      expectEpubError(e, /CRC/)
      expectEpubError(e, /OEBPS\/ch1\.xhtml/)
      // 失败即关：超限/损坏的归档不再提供后续读取（不缓存坏输出）
      await expect(archive.read('OEBPS/ch1.xhtml')).rejects.toThrow(/已关闭/)
    } finally {
      archive.close()
    }
  })

  it('声明的解压大小与实际不符：不许把短内容当全内容', async () => {
    const archive = await openEpubArchive(makeEpubFixture('declared-size-mismatch'))
    try {
      const e = await readRejection(archive, 'OEBPS/ch1.xhtml')
      expectEpubError(e, /OEBPS\/ch1\.xhtml/)
      // 长度核对是库的 validateEntrySizes 在流尾做的：本例声明值比实际多 1 字节，报的是流尾
      // 「not enough bytes in the stream」。反向（实际多于声明）另有 "too many bytes" 一条文案，
      // 本层没有造那条方向的样本，所以断言只钉住这一条；这里刻意不匹配 CRC，证明失败原因是长度
      expectEpubError(e, /not enough bytes in the stream\. expected \d+\. got only \d+/)
      expect(e.message).not.toMatch(/CRC/)
      await expect(archive.read('OEBPS/ch1.xhtml')).rejects.toThrow(/已关闭/)
    } finally {
      archive.close()
    }
  })

  it('entry-byte-limit：单条实际解压超预算', async () => {
    const archive = await openEpubArchive(makeEpubFixture('entry-byte-limit'), { entryBytes: 1024 })
    try {
      const e = await readRejection(archive, 'OEBPS/big.txt')
      expectEpubError(e, /实际解压超过上限 1024 字节/)
      expectEpubError(e, /OEBPS\/big\.txt/)
      await expect(archive.read('OEBPS/big.txt')).rejects.toThrow(/已关闭/)
    } finally {
      archive.close()
    }
  })

  it('total-byte-limit：累计实际解压超预算（重复读也计量）', async () => {
    const archive = await openEpubArchive(makeEpubFixture('total-byte-limit'), { entryBytes: 4096, totalBytes: 4096 })
    try {
      // 样本是两条各 3 KiB 的条目：第一条在预算内读完，第二条越累计上限
      const first = await archive.read('OEBPS/one.txt')
      expect(first.length).toBe(3000)
      const e = await readRejection(archive, 'OEBPS/two.txt')
      expectEpubError(e, /累计解压超过上限 4096 字节/)
      expectEpubError(e, /OEBPS\/two\.txt/)
      await expect(archive.read('OEBPS/two.txt')).rejects.toThrow(/已关闭/)
    } finally {
      archive.close()
    }
  })

  it('同一份样本重读一次照样计量（预算是处理量，不是条目数）', async () => {
    const archive = await openEpubArchive(makeEpubFixture('total-byte-limit'), { entryBytes: 4096, totalBytes: 4096 })
    try {
      expect((await archive.read('OEBPS/one.txt')).length).toBe(3000)
      // 第二次读同一条：3000 + 3000 > 4096，累计预算在重读时也要拦住
      const e = await readRejection(archive, 'OEBPS/one.txt')
      expectEpubError(e, /累计解压超过上限/)
    } finally {
      archive.close()
    }
  })

  it('maxBytes 是调用方的类别上限，且不能放宽单条目预算', async () => {
    const tight = await openEpubArchive(makeEpubFixture('zip-baseline'))
    try {
      expectEpubError(await readRejection(tight, 'OEBPS/ch1.xhtml', 10), /实际解压超过上限 10 字节/)
    } finally {
      tight.close()
    }
    const archive = await openEpubArchive(makeEpubFixture('entry-byte-limit'), { entryBytes: 1024 })
    try {
      // 调用方给个宽松的类别上限也不行：单条目预算是归档层的硬上限
      expectEpubError(await readRejection(archive, 'OEBPS/big.txt', 1 << 20), /实际解压超过上限 1024 字节/)
    } finally {
      archive.close()
    }
  })

  it('本地头坏掉的条目：别的条目照常读，读到它才炸（扫目录时一个字节都没解）', async () => {
    const archive = await openEpubArchive(makeEpubFixture('bad-local-header'))
    try {
      expect((await archive.read('mimetype')).toString('utf8')).toBe('application/epub+zip')
      const e = await readRejection(archive, 'OEBPS/ch1.xhtml')
      expectEpubError(e, /OEBPS\/ch1\.xhtml/)
      expectEpubError(e, /无法解压/)
      await expect(archive.read('OEBPS/ch1.xhtml')).rejects.toThrow(/已关闭/)
    } finally {
      archive.close()
    }
  })
})

describe('条目名归一与查找', () => {
  it('`./` 与空段归一到同一逻辑名', async () => {
    const archive = await openEpubArchive(makeEpubFixture('zip-baseline'))
    try {
      const exact = await archive.read('OEBPS/ch1.xhtml')
      expect((await archive.read('OEBPS/./ch1.xhtml')).equals(exact)).toBe(true)
      expect((await archive.read('OEBPS//ch1.xhtml')).equals(exact)).toBe(true)
    } finally {
      archive.close()
    }
  })

  it('`..` 是折叠还是越界，看它落在归一路径的哪个位置', async () => {
    const archive = await openEpubArchive(makeEpubFixture('zip-baseline'))
    try {
      // 路径中间（还有上一层可退）的 `..` 折叠掉：OEBPS/sub/../ch1.xhtml 就是 OEBPS/ch1.xhtml。
      // 这条折叠分支只有查找侧走得到（条目名里的 `..` 在 yauzl 那里就被拒了），必须在这里钉住
      const exact = await archive.read('OEBPS/ch1.xhtml')
      expect((await archive.read('OEBPS/sub/../ch1.xhtml')).equals(exact)).toBe(true)
      // 已经没有上一层可退的 `..` 是越界，拒；拒的是这次查找，不毁归档
      expectEpubError(await readRejection(archive, '../x'), /越出归档根/)
      expect((await archive.read('OEBPS/ch1.xhtml')).length).toBeGreaterThan(0)
    } finally {
      archive.close()
    }
  })

  it('查找名也过同一道安全门，且拒了不关归档', async () => {
    const archive = await openEpubArchive(makeEpubFixture('zip-baseline'))
    try {
      const bad: Array<[string, RegExp]> = [
        ['../evil.txt', /越出归档根/],
        ['/etc/passwd', /绝对路径/],
        ['C:/evil.txt', /盘符/],
        ['OEBPS\\ch1.xhtml', /反斜杠/],
        ['OEBPS/ch1\0.xhtml', /NUL/],
      ]
      for (const [name, pattern] of bad) expectEpubError(await readRejection(archive, name), pattern)
      // 名字不合法 / 条目不存在都是调用方的问题，不该毁掉归档
      expectEpubError(await readRejection(archive, 'OEBPS/nope.xhtml'), /没有条目/)
      expect((await archive.read('OEBPS/ch1.xhtml')).length).toBeGreaterThan(0)
    } finally {
      archive.close()
    }
  })
})

describe('预算常量', () => {
  it('上限就是设计定的数（归档三项 + XML 单文档三项 + 图片像素一项）', () => {
    // XML 三项由 XML 层（xml.ts）消费、图片像素由资源层（resources.ts）消费
    // （一个对象一个主人：预算都住这个对象，别处不再另立常量）
    expect(DEFAULT_EPUB_LIMITS).toEqual({
      entries: 10_000,
      entryBytes: 32 * 1024 * 1024,
      totalBytes: 512 * 1024 * 1024,
      xmlBytes: 8 * 1024 * 1024,
      xmlDepth: 128,
      xmlNodes: 200_000,
      imagePixels: 40_000_000,
    })
  })
})

describe('fixture 表', () => {
  it('未知名字直接抛错（表是封闭的）', () => {
    expect(() => makeEpubFixture('no-such-fixture')).toThrow(/未知的 EPUB fixture/)
  })

  it('mimetype 是首项且 store（OCF 要求读端不解压就能嗅探）', () => {
    const buf = makeEpubFixture('zip-baseline')
    // 直接看字节：本断言刻意不复用 fixture 的中央目录定位器——用它自己的代码验它自己的输出等于自证
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    expect(buf.readUInt16LE(8)).toBe(0)                                    // 压缩方式 0 = store
    expect(buf.toString('utf8', 30, 38)).toBe('mimetype')
  })
})
