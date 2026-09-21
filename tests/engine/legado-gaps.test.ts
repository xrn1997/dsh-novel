import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { JAVA_PROTOCOL, SANDBOX_MOUNTS, invokeJavaMethod } from '../../src/engine/js-protocol.js'
import type { BridgeDeps } from '../../src/engine/js-protocol.js'
import { createSourceSession, runScript } from '../../src/engine/js-sandbox.js'
import { decodePngToArgb, javaDecode, javaEncode, normalizeCharset } from '../../src/engine/js-utils.js'
import { parseRule } from '../../src/engine/parse.js'
import { JsSandboxError } from '../../src/engine/errors.js'
import type { EvalContext, Facet, SegmentLoc } from '../../src/engine/types.js'

/**
 * legado 真机缺口修复的回归钉子（29 条书架实测诊断的五处修复）：
 * A. cache.putMemory/getFromMemory/deleteMemory 三别名 + java.randomUUID
 * B. `tag.li.` 尾点号（!排除 切走 base 后的尾巴）不再炸选择器
 * E. 字节组方法 / downloadFile↔readTxtFile / Packages.*（PNG/AES/HMAC）沙箱面
 */

const L: SegmentLoc = { segmentIndex: 0, segmentRaw: '@js:test' }
const FACET: Facet = 'content'
const depsOf = (over: Partial<BridgeDeps> = {}): BridgeDeps => ({
  ctx: { vars: {} } satisfies EvalContext,
  code: 'test-script',
  loc: L,
  facet: FACET,
  result: '',
  session: createSourceSession(),
  sourceKey: 'https://m.example.com',
  evaluateRef: undefined,
  contentBase: null,
  ...over,
})
const run = (code: string, ctx: EvalContext = {}): Promise<{ value: { kind: string; text?: string } }> =>
  runScript({ code, loc: L, facet: FACET, scriptForm: true, ...ctx } as Parameters<typeof runScript>[0]) as never

describe('A. cache 内存三别名 + randomUUID（协议表行）', () => {
  it('putMemory/getFromMemory/deleteMemory 与 put/get/delete 同存储（本仓 cache 本就纯内存）', () => {
    const d = depsOf()
    invokeJavaMethod(d, 'cachePutMemory', ['k1', 'V1'])
    expect(invokeJavaMethod(d, 'cacheGetFromMemory', ['k1'])).toBe('V1')
    expect(invokeJavaMethod(d, 'cacheGet', ['k1'])).toBe('V1') // 别名与主名同仓
    invokeJavaMethod(d, 'cachePut', ['k2', 'V2'])
    expect(invokeJavaMethod(d, 'cacheGetFromMemory', ['k2'])).toBe('V2')
    invokeJavaMethod(d, 'cacheDeleteMemory', ['k1'])
    expect(invokeJavaMethod(d, 'cacheGetFromMemory', ['k1'])).toBeNull()
  })
  it('三别名都进了 SANDBOX_MOUNTS.cache（漏挂 → 红）', () => {
    const keys = SANDBOX_MOUNTS.cache.map((p) => p.key)
    expect(keys).toContain('putMemory')
    expect(keys).toContain('getFromMemory')
    expect(keys).toContain('deleteMemory')
  })
  it('java.randomUUID：小写带连字符的 uuid 形态（顶点小说 header 规则实证）', () => {
    const d = depsOf()
    const a = invokeJavaMethod(d, 'randomUUID', []) as string
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(invokeJavaMethod(d, 'randomUUID', [])).not.toBe(a)
  })
  it('vm 形态：cache.putMemory → cache.getFromMemory 跨段读回（novel.cooks.tw 目录脚本形态）', async () => {
    const r = await run('cache.putMemory("articleid", "abc"); cache.getFromMemory("articleid")')
    expect(r.value).toMatchObject({ kind: 'value', text: 'abc' })
  })
})

describe('B. 段尾点号剥离（看书源 tag.li.!0:1:-1 实证）', () => {
  it('!排除 切走后的尾点不再进选择器：mode/arg 干净、exclude 保留', () => {
    const p = parseRule('class.pages@tag.ul@tag.li.!0:1:-1@tag.a@href')
    const seg = p.branches[0].segments[2] as { kind: string; mode: string; arg: string; exclude: number[] }
    expect(seg).toMatchObject({ kind: 'default', mode: 'tag', arg: 'li' })
    expect(seg.exclude).toEqual([0, 1, -1])
  })
  it('无排除的裸尾点同样剥离：tag.li. → tag.li', () => {
    const p = parseRule('tag.li.@text')
    const seg = p.branches[0].segments[0] as { mode: string; arg: string }
    expect(seg).toMatchObject({ mode: 'tag', arg: 'li' })
  })
  it('中段点不受影响（class.note.clearfix 语义不动）', () => {
    const p = parseRule('class.note.clearfix@text')
    const seg = p.branches[0].segments[0] as { mode: string; arg: string }
    expect(seg).toMatchObject({ mode: 'class', arg: 'note.clearfix' })
  })
})

describe('E-1. 字节组方法（legado JsExtensions）', () => {
  it('strToBytes：ISO8859_1 字节往返无损（java 别名 → latin1）', () => {
    const d = depsOf()
    const bytes = invokeJavaMethod(d, 'strToBytes', ['héllo', 'ISO8859_1']) as number[]
    expect(bytes).toEqual([0x68, 0xe9, 0x6c, 0x6c, 0x6f])
    expect(javaDecode(Uint8Array.from(bytes), 'ISO8859_1')).toBe('héllo')
  })
  it('strToBytes UTF-8 形态', () => {
    const bytes = invokeJavaMethod(depsOf(), 'strToBytes', ['斗破']) as number[]
    expect(bytes).toEqual(Array.from(Buffer.from('斗破', 'utf8')))
  })
  it('hexDecodeToByteArray：合法 hex → 字节；非法 → JsSandboxError（宁炸不猜）', () => {
    expect(invokeJavaMethod(depsOf(), 'hexDecodeToByteArray', ['48656c6c6f'])).toEqual([72, 101, 108, 108, 111])
    expect(() => invokeJavaMethod(depsOf(), 'hexDecodeToByteArray', ['xyz'])).toThrow(JsSandboxError)
  })
  it('base64DecodeToByteArray', () => {
    expect(invokeJavaMethod(depsOf(), 'base64DecodeToByteArray', ['AQID'])).toEqual([1, 2, 3])
  })
  it('charset 归一：Java 别名与 iconv 名互通；未知 charset 抛错', () => {
    expect(normalizeCharset('ISO8859_1')).toBe('latin1')
    expect(normalizeCharset('UTF-8')).toBe('utf8')
    expect(() => javaEncode('x', 'no-such-charset')).toThrow(/不支持的 charset/)
  })
})

describe('E-2. downloadFile ↔ readTxtFile（进程内暂存，不暴露真实文件系统）', () => {
  it('下载字节 → readTxtFile 按 charset 解码回文本（往返闭环）', async () => {
    const png = Buffer.from('89504e47', 'hex') // 内容无所谓，只验往返
    const ctx = { fetchRaw: async () => png } as EvalContext
    const path = (await invokeJavaMethod(depsOf({ ctx }), 'downloadFile', ['https://x.com/a/key.png'])) as Promise<string>
    const p = await path
    expect(p).toMatch(/^\/dsh-cache\/[0-9a-f]{32}\.png$/)
    const txt = invokeJavaMethod(depsOf({ ctx }), 'readTxtFile', [p, 'ISO8859_1']) as string
    expect(Buffer.from(txt, 'latin1')).toEqual(png)
  })
  it('readTxtFile 读未下载的路径 → 如实报错（不读任意本地路径）', () => {
    expect(() => invokeJavaMethod(depsOf(), 'readTxtFile', ['/etc/passwd'])).toThrow(/只支持本进程 downloadFile/)
  })
  it('选项后缀 `,{…}` 与逗号前空格都不进扩展名推断（分界式与 request 同源）', async () => {
    // 回归钉子：此处曾自抄一份分界式且少了前导 `\s*`，带空格的 URL 会把尾空格带进扩展名匹配 → 回落 `.bin`
    const ctx = { fetchRaw: async () => Buffer.from('89504e47', 'hex') } as EvalContext
    const p = (await invokeJavaMethod(depsOf({ ctx }), 'downloadFile', ['https://x.com/a/key.png ,{"method":"POST"}'])) as Promise<string>
    expect(p).toMatch(/^\/dsh-cache\/[0-9a-f]{32}\.png$/)
  })
  it('缺 fetchRaw → downloadFile 如实报网络能力缺席', async () => {
    await expect(invokeJavaMethod(depsOf(), 'downloadFile', ['https://x.com/a.png']))
      .rejects.toThrow(/fetchRaw 缺失/)
  })
  it('vm 形态：downloadFile 走 worker 同步桥（主线程哨兵换道后成功返回路径）', async () => {
    const r = await run(
      'var p = java.downloadFile("https://x.com/k.png"); p.indexOf("/dsh-cache/") === 0 ? "ok:" + p.length : "bad"',
      { fetchRaw: async () => Buffer.from([1, 2, 3]) },
    )
    expect(String((r.value as { text?: string }).text ?? '')).toMatch(/^ok:\d+$/)
  })
})

// ── PNG 构造器（测试内自带最小编码器：deflate + 标准滤波 0）────────────────
function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** 构造非隔行 PNG：colorType 6（RGBA8）或 0（灰度8），滤波全 0 */
function makePng(width: number, height: number, colorType: 0 | 6, px: number[][]): Buffer {
  const ch = colorType === 6 ? 4 : 1
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * ch)
    for (let x = 0; x < width; x++) {
      const p = px[y][x]
      if (colorType === 6) { row[1 + x * 4] = (p >> 16) & 0xff; row[2 + x * 4] = (p >> 8) & 0xff; row[3 + x * 4] = p & 0xff; row[4 + x * 4] = (p >>> 24) & 0xff }
      else row[1 + x] = p & 0xff
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('E-3. decodePngToArgb（BitmapFactory 宿主实现）', () => {
  it('RGBA8：像素按位还原（ARGB int，与 Java getPixel 同语义）', () => {
    const png = makePng(2, 1, 6, [[0xff112233, 0x80445566]])
    const r = decodePngToArgb(new Uint8Array(png))
    expect(r).toMatchObject({ width: 2, height: 1 })
    expect(r.pixels[0] >>> 0).toBe(0xff112233 >>> 0)
    expect(r.pixels[1] >>> 0).toBe(0x80445566 >>> 0)
  })
  it('灰度8：扩展到 RGB 三通道', () => {
    const png = makePng(1, 1, 0, [[0x7f]])
    const r = decodePngToArgb(new Uint8Array(png))
    expect(r.pixels[0] >>> 0).toBe(0xff7f7f7f >>> 0)
  })
  it('非 PNG 数据 / 隔行标志 → 如实抛错（宁炸不猜）', () => {
    expect(() => decodePngToArgb(new Uint8Array([1, 2, 3]))).toThrow(/不是 PNG/)
    const png = makePng(1, 1, 6, [[0]])
    png[8 + 8 + 12] = 1 // IHDR dataStart(16) + interlace 字节偏移 12 → 置 Adam7
    expect(() => decodePngToArgb(new Uint8Array(png))).toThrow(/隔行/)
  })
  it('像素上限在 IHDR 处判：声明尺寸超限即抛，不等整图解完（重活之前挡住）', () => {
    const png = makePng(1, 1, 6, [[0]])
    png.writeUInt32BE(4000, 16); png.writeUInt32BE(4000, 20) // IHDR 声明 1600 万像素，IDAT 仍只有 1 像素
    // 若上限判在解码之后，这里先撞的是 IDAT 那两条错（数据不足 / 膨胀失败）——断言的是判定次序
    expect(() => decodePngToArgb(new Uint8Array(png), 4_000_000)).toThrow(/超过 4000000 像素上限/)
  })
  it('不设上限即不拦（策略值归调用方）：同一张超声明 PNG 照旧走到像素解码', () => {
    const png = makePng(1, 1, 6, [[0]])
    png.writeUInt32BE(4000, 16); png.writeUInt32BE(4000, 20)
    expect(() => decodePngToArgb(new Uint8Array(png))).toThrow(/IDAT 数据不足/)
  })
})

describe('E-4. Packages.* 沙箱面（爱腐文密钥图解密链的载体）', () => {
  it('ByteArrayOutputStream 写入/回读 + Arrays.copyOfRange Java 语义', async () => {
    const r = await run(`
      var BAOS = Packages.java.io.ByteArrayOutputStream;
      var b = new BAOS();
      b.write(255); b.write(0); b.write([1, 2]);
      var arr = b.toByteArray();
      var head = Packages.java.util.Arrays.copyOfRange(arr, 0, 2);
      JSON.stringify({ arr: arr, head: head, tail: Packages.java.util.Arrays.copyOfRange(arr, -2) })
    `)
    expect(String((r.value as { text?: string }).text)).toBe('{"arr":[255,0,1,2],"head":[255,0],"tail":[1,2]}')
  })
  it('AES/CBC 解密闭环：宿主加密 → Cipher.doFinal 还原明文', async () => {
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(16)
    const enc = crypto.createCipheriv('aes-256-cbc', key, iv)
    const ct = Buffer.concat([enc.update('斗破苍穹正文'.repeat(8), 'utf8'), enc.final()])
    const r = await run(`
      var key = ${JSON.stringify(Array.from(key))};
      var iv = ${JSON.stringify(Array.from(iv))};
      var ct = ${JSON.stringify(Array.from(ct))};
      var C = Packages.javax.crypto.Cipher;
      var c = C.getInstance('AES/CBC/PKCS5Padding');
      c.init(C.DECRYPT_MODE,
        new Packages.javax.crypto.spec.SecretKeySpec(key, 'AES'),
        new Packages.javax.crypto.spec.IvParameterSpec(iv));
      String(new Packages.java.lang.String(c.doFinal(ct), 'UTF-8'));
    `)
    expect(String((r.value as { text?: string }).text)).toBe('斗破苍穹正文'.repeat(8))
  })
  it('不支持的变换/仅解密 → 如实报错', async () => {
    const e1 = await run('Packages.javax.crypto.Cipher.getInstance("DES/ECB/PKCS5Padding")').catch((x: Error) => x)
    expect(String((e1 as Error).message)).toMatch(/不支持的加密变换/)
  })
  it('HmacSHA256：与 Node crypto 同值', async () => {
    const expectMac = Array.from(crypto.createHmac('sha256', Buffer.from([1, 2, 3])).update(Buffer.from([4, 5])).digest())
    const r = await run(`
      var m = Packages.javax.crypto.Mac.getInstance('HmacSHA256');
      m.init(new Packages.javax.crypto.spec.SecretKeySpec([1,2,3], 'HmacSHA256'));
      m.update([4,5]);
      JSON.stringify(m.doFinal())
    `)
    expect(JSON.parse(String((r.value as { text?: string }).text))).toEqual(expectMac)
  })
  it('Mac.doFinal(byte[]) 与 update(byte) 都算数：与 Java 同义（曾静默吞实参 → 对零字节签名）', async () => {
    const whole = Buffer.from([4, 5, 6, 7])
    const expectMac = Array.from(crypto.createHmac('sha256', Buffer.from([1, 2, 3])).update(whole).digest())
    const r = await run(`
      var m = Packages.javax.crypto.Mac.getInstance('HmacSHA256');
      m.init(new Packages.javax.crypto.spec.SecretKeySpec([1,2,3], 'HmacSHA256'));
      m.update(4);                            // 单字节实参：Java 收，此前被静默丢弃
      JSON.stringify(m.doFinal([5,6,7]))      // doFinal(input) ≡ update(input) + doFinal()
    `)
    expect(JSON.parse(String((r.value as { text?: string }).text))).toEqual(expectMac)
  })
  it('Mac.doFinal 结算后复位（Java 语义：同实例可再签，不把上一轮字节算进来）', async () => {
    const expectSecond = Array.from(crypto.createHmac('sha256', Buffer.from([1, 2, 3])).update(Buffer.from([9])).digest())
    const r = await run(`
      var m = Packages.javax.crypto.Mac.getInstance('HmacSHA256');
      m.init(new Packages.javax.crypto.spec.SecretKeySpec([1,2,3], 'HmacSHA256'));
      m.doFinal([4,5]);
      JSON.stringify(m.doFinal([9]))
    `)
    expect(JSON.parse(String((r.value as { text?: string }).text))).toEqual(expectSecond)
  })
  it('ByteArrayInputStream.read() 逐字节前进（游标不自增 = 第一死循环，唯一出口是 js 超时）', async () => {
    const r = await run(`
      var s = new Packages.java.io.ByteArrayInputStream([7,8,9]);
      var out = []; var b;
      while ((b = s.read()) != -1) out.push(b);
      JSON.stringify({ bytes: out, avail: s.available() })
    `)
    expect(JSON.parse(String((r.value as { text?: string }).text))).toEqual({ bytes: [7, 8, 9], avail: 0 })
  })
  it('BitmapFactory.decodeStream：PNG 字节 → getPixel 取 R 通道（脚本 (rgb>>16)&0xFF 形态）', async () => {
    const png = Array.from(makePng(2, 1, 6, [[0xffab1234, 0xff000000]]))
    const r = await run(`
      var bais = new Packages.java.io.ByteArrayInputStream(${JSON.stringify(png)});
      var bm = Packages.android.graphics.BitmapFactory.decodeStream(bais);
      JSON.stringify({ w: bm.getWidth(), h: bm.getHeight(), r0: (bm.getPixel(0,0) >> 16) & 0xFF, oob: bm.getPixel(9,9) })
    `)
    expect(JSON.parse(String((r.value as { text?: string }).text))).toEqual({ w: 2, h: 1, r0: 0xab, oob: 0 })
  })
  it('未知 Packages 路径与不支持的加密变换在协议层有登记（async 行 = ajax + downloadFile）', () => {
    const asyncNames = JAVA_PROTOCOL.flatMap((r) => (r.mode === 'async' ? [r.name] : []))
    expect(asyncNames).toEqual(['ajax', 'downloadFile'])
  })
})
