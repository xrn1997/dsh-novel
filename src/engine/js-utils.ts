/**
 * 沙箱宿主纯工具（「JavaBridge 协议知识散四处」之「纯工具出走」）。
 *
 * 此前 fmtTime/md5/base64/engineValueToString(s) 埋在 js-sandbox 的 makeJavaBridge 附近，
 * 是模块私有函数——只能整体过 vm 测试，无法直测。本文件把它们抽成无状态纯函数：
 * 无 vm、无 EvalContext、无会话状态，直接可测（tests/engine/js-utils.test.ts）。
 *
 * 纪律：本文件**不进** engine barrel（src/engine/index.ts）——仅由 js-protocol/js-sandbox 内部引用。
 */
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import iconv from 'iconv-lite'
import type { EngineValue } from './types.js'

/** md5 → 32 位小写十六进制 */
export function md5Hex(s: string): string {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex')
}

/** legado md5Encode16 语义：32 位 md5 取中 16 位（slice(8, 24)） */
export function md5Hex16(s: string): string {
  return md5Hex(s).slice(8, 24)
}

/** base64 编码（UTF-8 字节） */
export function base64Encode(s: string): string {
  return Buffer.from(String(s), 'utf8').toString('base64')
}

/** base64 解码（→ UTF-8 字符串） */
export function base64Decode(s: string): string {
  return Buffer.from(String(s), 'base64').toString('utf8')
}

/** java.encodeURI 垫片：legado 实际语义 = encodeURIComponent（中文/空格/斜杠全部转义） */
export function uriEncode(s: string): string {
  return encodeURIComponent(String(s))
}

/** 十六进制串 → UTF-8 字符串；空串/奇数长/含非 hex 字符 → ''（宁空不猜，与旧实现逐字一致） */
export function hexDecodeToString(hex: string): string {
  const clean = String(hex).trim()
  if (clean === '' || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return ''
  return Buffer.from(clean, 'hex').toString('utf8')
}

/** 时间格式化：yyyy/MM/dd HH:mm（utc 标志决定取 UTC 还是本地分量；非法输入 → ''） */
export function fmtTime(ts: number | string, utc: boolean): string {
  const d = new Date(Number(ts))
  if (Number.isNaN(d.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  const y = utc ? d.getUTCFullYear() : d.getFullYear()
  const mo = utc ? d.getUTCMonth() : d.getMonth()
  const da = utc ? d.getUTCDate() : d.getDate()
  const h = utc ? d.getUTCHours() : d.getHours()
  const mi = utc ? d.getUTCMinutes() : d.getMinutes()
  return `${y}/${p2(mo + 1)}/${p2(da)} ${p2(h)}:${p2(mi)}`
}

/** EngineValue → 单串（**唯一实现**；nodes 两种宿主口径由参数显式区分，不再是两份抄本）。
 *  nodesMode：'inner' = `html()`（java.getString 口径，默认）；'outer' = `toString()`（@js host.result 口径）。
 *  其余分支：list 换行拼接、matches 行内 tab、miss → ''。（此前 evaluate.serialize 与
 *  本函数五分支里四个逐字相同、nodes 分叉——同一段 HTML 在 @js 里经两种 API 读到两种文本。） */
export function engineValueToString(v: EngineValue, nodesMode: 'inner' | 'outer' = 'inner'): string {
  switch (v.kind) {
    case 'value':
      return v.text
    case 'list':
      return v.items.join('\n')
    case 'matches':
      return v.rows.map((r) => r.join('\t')).join('\n')
    case 'nodes':
      return (nodesMode === 'outer' ? v.nodes.toString() : v.nodes.html()) ?? ''
    case 'miss':
      return ''
  }
}

/** EngineValue → 串数组（java.getStringList 口径：value 按换行切分并滤空行） */
export function engineValueToStrings(v: EngineValue): string[] {
  switch (v.kind) {
    case 'value':
      return v.text.split('\n').filter((s) => s !== '')
    case 'list':
      return v.items
    case 'matches':
      return v.rows.map((r) => r.join('\t'))
    case 'nodes': {
      const html = v.nodes.html() ?? ''
      return html ? [html] : []
    }
    case 'miss':
      return []
  }
}

/**
 * PNG → ARGB 像素数组（`Packages.android.graphics.BitmapFactory.decodeStream` 宿主实现）。
 * legado 跑在 Android 上由系统解码；本仓以 node:zlib 解 IDAT + 逐行去滤波自实现——
 * 支持位深 1/2/4/8/16（16 取高字节）、颜色类型 0/2/3/4/6、tRNS 透明、非隔行。
 * 隔行（Adam7）/未知滤波/数据不足 → 抛错（宁炸不猜：给错位像素比报错坏得多）。
 *
 *  `maxPixels`：像素数上限，**在 IHDR 处判**（尺寸读出来即定，膨胀 + 逐行去滤波才是重活——
 *  等整图解完再判等于没挡，见 `js-sandbox.ts` 的 `__pkg.png`）。缺省不设上限：策略值归调用方。
 */
export function decodePngToArgb(bytes: Uint8Array, maxPixels?: number): { width: number; height: number; pixels: number[] } {
  const fail = (msg: string): never => { throw new Error(`PNG 解码失败：${msg}`) }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) fail('不是 PNG 数据')
  let pos = 8
  let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Buffer[] = []
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos)
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
    const dataStart = pos + 8
    if (dataStart + len + 4 > bytes.length) fail(`chunk ${type} 越界`)
    const data = bytes.subarray(dataStart, dataStart + len)
    if (type === 'IHDR') {
      width = dv.getUint32(dataStart); height = dv.getUint32(dataStart + 4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'PLTE') palette = data.slice()
    else if (type === 'tRNS') trns = data.slice()
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    pos = dataStart + len + 4
  }
  if (width === 0 || height === 0) fail('IHDR 缺失或尺寸为 0')
  if (maxPixels !== undefined && width * height > maxPixels) fail(`图片过大（${width}×${height}）——超过 ${maxPixels} 像素上限（尺寸读出即判，未解像素）`)
  if (interlace !== 0) fail('暂不支持隔行（Adam7）PNG——请换非隔行源图')
  const channelsOf: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsOf[colorType]
  if (channels === undefined) fail(`未知颜色类型 ${colorType}`)
  if (![1, 2, 4, 8, 16].includes(bitDepth)) fail(`未知位深 ${bitDepth}`)
  if (bitDepth === 16 && colorType === 3) fail('调色板不支持 16 位')

  let raw: Buffer
  try { raw = zlib.inflateSync(Buffer.concat(idat)) } catch (e) { return fail(`IDAT 膨胀失败（${String(e)}）`) }

  const bitPerPx = channels * bitDepth
  const rowBytes = Math.ceil((width * bitPerPx) / 8)
  const bpp = Math.max(1, Math.ceil(bitPerPx / 8)) // 滤波器参照字节宽度（子字节位深按 1）
  if (raw.length < height * (rowBytes + 1)) fail(`IDAT 数据不足（${raw.length} < ${height * (rowBytes + 1)}）`)

  // 逐行去滤波（Sub/Up/Average/Paeth，PNG 规范标准式）
  const img = Buffer.alloc(height * rowBytes)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (rowBytes + 1)]
    const src = (y * (rowBytes + 1)) + 1
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? img[y * rowBytes + x - bpp] : 0
      const b = y > 0 ? img[(y - 1) * rowBytes + x] : 0
      const c = (x >= bpp && y > 0) ? img[(y - 1) * rowBytes + x - bpp] : 0
      const v = raw[src + x]
      let out: number
      switch (ft) {
        case 0: out = v; break
        case 1: out = v + a; break
        case 2: out = v + b; break
        case 3: out = v + ((a + b) >> 1); break
        case 4: out = v + paeth(a, b, c); break
        default: return fail(`未知滤波类型 ${ft}（第 ${y} 行）`)
      }
      img[y * rowBytes + x] = out & 0xff
    }
  }

  // 位深采样 → 8 位 → ARGB
  const sampleAt = (row: number, col: number, ch: number): number => {
    const idx = col * channels + ch
    if (bitDepth === 8) return img[row * rowBytes + idx]
    if (bitDepth === 16) return img[row * rowBytes + idx * 2] // 取高字节（16→8 常规降采样）
    const bitPos = idx * bitDepth
    const byte = img[row * rowBytes + (bitPos >> 3)]
    const shift = 8 - bitDepth - (bitPos & 7)
    return (byte >> shift) & ((1 << bitDepth) - 1)
  }
  const maxValue = bitDepth >= 8 ? 255 : (1 << bitDepth) - 1
  const scale = (v: number): number => (maxValue === 255 ? v : Math.round((v * 255) / maxValue))

  const pixels = new Array<number>(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number, al = 255
      if (colorType === 3) {
        const pi = sampleAt(y, x, 0)
        if (palette === null) throw new Error('PNG 解码失败：调色板颜色类型缺 PLTE chunk')
        if (pi * 3 + 2 >= palette.length) throw new Error(`PNG 解码失败：调色板索引 ${pi} 越界`)
        r = palette[pi * 3]; g = palette[pi * 3 + 1]; b = palette[pi * 3 + 2]
        if (trns !== null && pi < trns.length) al = trns[pi]
      } else if (colorType === 0) {
        r = g = b = scale(sampleAt(y, x, 0))
        if (trns !== null && trns.length >= 2) {
          const key = (trns[0] << 8) | trns[1]
          if (sampleAt(y, x, 0) === (bitDepth === 16 ? key >> 8 : key)) al = 0
        }
      } else if (colorType === 4) {
        r = g = b = scale(sampleAt(y, x, 0)); al = scale(sampleAt(y, x, 1))
      } else if (colorType === 2) {
        r = scale(sampleAt(y, x, 0)); g = scale(sampleAt(y, x, 1)); b = scale(sampleAt(y, x, 2))
        if (trns !== null && trns.length >= 6) {
          const kr = (trns[0] << 8) | trns[1], kg = (trns[2] << 8) | trns[3], kb = (trns[4] << 8) | trns[5]
          const key16 = sampleAt(y, x, 0) === (kr >> 8) && sampleAt(y, x, 1) === (kg >> 8) && sampleAt(y, x, 2) === (kb >> 8)
          const key8 = r === (kr >> 8) && g === (kg >> 8) && b === (kb >> 8)
          if (bitDepth === 16 ? key16 : key8) al = 0
        }
      } else { // colorType 6
        r = scale(sampleAt(y, x, 0)); g = scale(sampleAt(y, x, 1)); b = scale(sampleAt(y, x, 2))
        al = scale(sampleAt(y, x, 3))
      }
      pixels[y * width + x] = (al << 24) | (r << 16) | (g << 8) | b
    }
  }
  return { width, height, pixels }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
}

/** Java charset 名归一（legado 脚本传 `ISO8859_1` 这类 Java 别名）：剥分隔符小写后查表，
 *  未命中回传原名交给 iconv 判定（encodingExists 不成立 → 调用方如实报错，不猜编码）。 */
export function normalizeCharset(raw: string): string {
  const s = String(raw).trim().replace(/[-_\s]/g, '').toLowerCase()
  if (s === '' || s === 'utf8' || s === 'utf8bom') return 'utf8'
  if (s === 'iso88591' || s === 'latin1') return 'latin1' // 字节往返必须无损（downloadFile↔readTxtFile）
  if (s === 'ascii' || s === 'usascii') return 'ascii'
  if (s === 'gbk' || s === 'gb2312' || s === 'gb18030') return String(raw).trim().toUpperCase()
  return String(raw).trim()
}

/** 字符串 → 字节（`java.strToBytes` 宿主实现）。未知 charset → 抛错（不拿 UTF-8 冒充）。 */
export function javaEncode(s: string, charset: string): Uint8Array {
  const cs = normalizeCharset(charset)
  if (cs === 'utf8' || cs === 'latin1' || cs === 'ascii') return new Uint8Array(Buffer.from(s, cs))
  if (!iconv.encodingExists(cs)) throw new Error(`不支持的 charset=${charset}`)
  return new Uint8Array(iconv.encode(s, cs))
}

/** 字节 → 字符串（`java.readTxtFile` 宿主实现）。未知 charset → 抛错。 */
export function javaDecode(bytes: Uint8Array, charset: string): string {
  const cs = normalizeCharset(charset)
  if (cs === 'utf8' || cs === 'latin1' || cs === 'ascii') return Buffer.from(bytes).toString(cs)
  if (!iconv.encodingExists(cs)) throw new Error(`不支持的 charset=${charset}`)
  return iconv.decode(Buffer.from(bytes), cs)
}
