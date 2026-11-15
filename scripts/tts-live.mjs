#!/usr/bin/env node
/**
 * 听书真链路一次性审计（**不进默认门、不进 CI**）。
 *
 * 跑的是构建产物 `lib/`：宿主半产出一个 ESM bundle，`ReadingService` / `createApiHandler`
 * 不单独出文件，所以这里用插件入口 `apply` 的最小宿主替身把 `/novel-api` 路由接起来，
 * 再从真 `node:http` 服务走一遍合成 → 音频读口。浏览器半不参与——直出型（浏览器本地语音）
 * 没有字节可审计，遇到它如实报「未测」。
 *
 * 用法（先 `pnpm build`）：
 *   node scripts/tts-live.mjs
 *   node scripts/tts-live.mjs --engine http:your-engine --data-dir ~/.dsh/novel
 *
 * 退出码：0 = 可用；1 = 不可用（外部链路失败，断言不放宽）；2 = 未测 / 没跑成
 * （缺构建产物、参数不成立、直出型没有字节、订阅引擎不在数据根里）。
 * `--help` / `-h` 打印用法后正常退出（0），但那不是审计结果——0 只有在合成 → 音频读口两段
 * 都成立时才是「可用」。
 *
 * 输出只到「引擎标识 + 服务端错误码 / 原话」：不打印 cookies、headers、loginInfo，
 * 也不打印环境里的代理凭据。
 */
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIB_ENTRY = path.join(ROOT, 'lib', 'index.js')
const API_PREFIX = '/novel-api'
const DEFAULT_ENGINE = 'builtin:baidu'
const BROWSER_ENGINE = 'browser:local'
const CORDIS_ENGINE = 'cordis:speechSynthesis'
/** 一段短中文：足够让上游合成出声，又不会把审计输出撑长。 */
const AUDIT_TEXT = '你好，这是听书链路的真链路审计。'
const REQUEST_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 30_000
const ERROR_PRINT_MAX = 600
/** 插件自有身份的 id 前缀（内置表 / 浏览器直出 / 宿主语音服务）：它们不读数据根，
 *  前缀给出的身份不存在属**参数错**；只有订阅 id 才落在数据根里的 tts-engines.json。 */
const PLUGIN_OWNED_PREFIXES = ['builtin:', 'browser:', 'cordis:']

function isPluginOwnedEngine(engineId) {
  return PLUGIN_OWNED_PREFIXES.some((prefix) => engineId.startsWith(prefix))
}

function usage() {
  return [
    '用法: node scripts/tts-live.mjs [--engine <id>] [--data-dir <path>]',
    '',
    `  默认引擎 ${DEFAULT_ENGINE}（内置，开箱即用）。`,
    '  审计强制直连（输出 PROXY: direct (forced)）；代理环境视为未覆盖。',
    '  --engine <id>   引擎 id：内置 / 直出 / 宿主服务前缀不读数据根；订阅 id（如 http:xxx）',
    '                  需要同时给 --data-dir，该目录下要有 tts-engines.json。',
    '  --data-dir <p>  数据根（含 tts-engines.json；合成音频缓存写到其下 cache/tts）。',
    '                  缺省用临时目录，跑完即删。',
    '  --help / -h     打印本说明后正常退出（0）；这不是审计结果，不能读成「可用」。',
    '',
    '退出码: 0 可用 / 1 不可用 / 2 未测或没跑成。',
  ].join('\n')
}

/** @returns {{ engineId: string, dataDir: string | null, help: boolean }} */
function parseArgs(argv) {
  let engineId = DEFAULT_ENGINE
  let dataDir = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { engineId, dataDir, help: true }
    if (arg === '--engine' || arg === '--data-dir') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺值`)
      if (arg === '--engine') engineId = value
      else dataDir = value
      i += 1
      continue
    }
    throw new Error(`认不出的参数：${arg}`)
  }
  if (engineId.trim() === '') throw new Error('--engine 不能是空串')
  return { engineId, dataDir, help: false }
}

/** 最小宿主替身：只声明 `apply` 实际用到的成员；不启动真宿主、不装任何插件。 */
function createHost() {
  const disposers = []
  /** 宿主替身的 error / warn 留痕：初始化失败常常只表现为「迟迟等不到路由」，失败退出前
   *  把这些行打印出来，别让 30s 的等待成为唯一读数。 */
  const logs = []
  const collect = (level) => (...args) => {
    logs.push({ level, text: args.map(argText).join(' ') })
  }
  let registered = null
  let resolveReady = null
  const ready = new Promise((resolve) => { resolveReady = resolve })
  const ctx = {
    logger: () => ({ info: () => undefined, warn: collect('warn'), error: collect('error') }),
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => undefined
    },
    on: () => () => false,
    get: () => undefined,
    webServer: {
      register: (route) => {
        if (typeof route.handler !== 'function') throw new Error('webServer.register 没拿到 handler')
        if (route.path !== API_PREFIX) throw new Error(`意外的路由前缀：${String(route.path)}`)
        registered = route.handler
        if (resolveReady !== null) resolveReady()
        return () => undefined
      },
    },
    tools: { register: () => () => undefined },
    jobs: { attachController: () => () => undefined, start: () => { throw new Error('审计不启动后台任务') } },
  }
  return {
    ctx,
    ready,
    logs,
    routeHandler: () => registered,
    dispose: () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 收尾失败不盖住审计结论 */ }
      }
    },
  }
}

async function waitForRoute(host) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (host.routeHandler() === null) {
    if (Date.now() > deadline) throw new Error(`等待 ${API_PREFIX} 路由注册超时（${READY_TIMEOUT_MS}ms）`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return host.routeHandler()
}

function startServer(handler) {
  const server = http.createServer((req, res) => {
    // handler 内部已 writeError 兜底；这里的 catch 只防止 Promise 悬空
    void handler(req, res).catch(() => undefined)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('服务器没有拿到端口'))
        return
      }
      resolve({ server, base: `http://127.0.0.1:${address.port}` })
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => { server.close(() => resolve()) })
}

function clip(text) {
  return text.length <= ERROR_PRINT_MAX ? text : `${text.slice(0, ERROR_PRINT_MAX)}…`
}

/** 日志实参 → 一行文本：宿主日志可能带 Error 或任意对象，直接拼字符串会只剩 `[object Object]`。 */
function argText(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 宿主替身收集到的 error / warn：只在失败退出前打印，成功路径不把宿主留痕混进审计读数。 */
function printHostLogs(logs) {
  for (const line of logs) console.log(`HOST ${line.level.toUpperCase()}: ${clip(line.text)}`)
}

/** @returns {Promise<{ status: number, body: string }>} */
async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: res.status, body: await res.text() }
}

/** 读音频：状态、content-type 与字节数；内容不打印。 */
async function readAudio(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const bytes = Buffer.from(await res.arrayBuffer())
  return { status: res.status, contentType: res.headers.get('content-type'), bytes }
}

/** 音频读口的类型判据比产品契约**更宽一格**：服务端把缺 Content-Type 的响应按
 *  `application/octet-stream` 回（`src/services/tts-request.ts` 的 assertAudioContentType——
 *  缺席不是「声明不符」，读成中性二进制类型），那是合法音频产物，不能当不可用。
 *  于是判据是「audio/* 或 application/octet-stream」，字节非零另判。 */
function isAudioContentType(contentType) {
  if (typeof contentType !== 'string') return false
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mediaType.startsWith('audio/') || mediaType === 'application/octet-stream'
}

function errorOf(body) {
  try {
    const parsed = JSON.parse(body)
    const error = parsed?.error
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
      return { code: error.code, message: typeof error.message === 'string' ? error.message : '' }
    }
  } catch { /* 非 JSON 响应原样进结论 */ }
  return null
}

/**
 * @param {ReturnType<typeof createHost>} host
 * @param {string} engineId
 * @param {string} dataDir
 */
async function audit(host, engineId, dataDir) {
  if (!existsSync(LIB_ENTRY)) {
    console.log(`UNTESTED: 缺少构建产物 ${path.relative(ROOT, LIB_ENTRY)}；先跑 pnpm build`)
    return 2
  }
  if (engineId === BROWSER_ENGINE) {
    console.log(`UNTESTED: ${BROWSER_ENGINE} 是直出型（浏览器本地语音），不经合成接口、没有字节可审计`)
    return 2
  }
  if (engineId === CORDIS_ENGINE) {
    console.log(`UNTESTED: ${CORDIS_ENGINE} 需要宿主语音服务在场；本脚本的宿主替身不提供该服务`)
    return 2
  }

  try {
    // Windows 的绝对路径不能直接交给 ESM loader（会被读成 `d:` 协议）；先转 file URL。
    const plugin = await import(pathToFileURL(LIB_ENTRY).href)
    if (typeof plugin.apply !== 'function') throw new Error('lib/index.js 没有导出 apply——构建产物形状变了')
    plugin.apply(host.ctx, {
      dataDir,
      // 强制直连：本脚本只回答直连链路可用性，不把环境代理的脸色混进读数（代理环境视为未覆盖）。
      proxyUrl: 'direct',
    })
    console.log('PROXY: direct (forced)')
    const handler = await waitForRoute(host)
    const { server, base } = await startServer(handler)
    try {
      console.log(`ENGINE: ${engineId}`)
      console.log(`TEXT: ${AUDIT_TEXT}`)
      const synth = await postJson(`${base}${API_PREFIX}/tts/synthesize`, {
        engineId, text: AUDIT_TEXT, rate: 1,
      })
      if (synth.status !== 200) {
        const error = errorOf(synth.body)
        const reason = error === null
          ? `HTTP ${synth.status}: ${clip(synth.body)}`
          : `${error.code}: ${clip(error.message)}`
        console.log(`SYNTHESIZE: HTTP ${synth.status}`)
        if (error?.code === 'TTS_ENGINE_MISSING') {
          // 两种主语分开说：插件自有前缀（内置 / 直出 / 宿主服务）的 id 不存在是 --engine 参数错，
          // 它不读数据根；订阅 id 不在了才是「引擎不在数据根里」。
          if (isPluginOwnedEngine(engineId)) {
            console.log(`UNTESTED: 参数不成立——${engineId} 不是当前存在的内置 / 直出 / 宿主服务 id`)
          } else {
            console.log(`UNTESTED: 引擎不在数据根里（${reason}）`)
          }
          return 2
        }
        console.log(`UNUSABLE: ${reason}`)
        return 1
      }
      let receipt
      try {
        receipt = JSON.parse(synth.body)
      } catch {
        console.log(`UNUSABLE: 合成回执不是 JSON（HTTP ${synth.status}）`)
        return 1
      }
      if (receipt?.ok !== true) {
        console.log('UNUSABLE: 合成回执不是成功信封（缺 ok: true）')
        return 1
      }
      const key = receipt?.value?.key
      if (typeof key !== 'string' || key === '') {
        console.log('UNUSABLE: 合成回执缺音频键')
        return 1
      }
      console.log(`RECEIPT: key=${key}`)
      const audioUrl = `${base}${API_PREFIX}/tts/audio?key=${encodeURIComponent(key)}`
      const audio = await readAudio(audioUrl)
      console.log(`AUDIO: HTTP ${audio.status} content-type=${String(audio.contentType)} bytes=${String(audio.bytes.length)}`)
      if (audio.status !== 200) {
        const error = errorOf(audio.bytes.toString('utf8'))
        console.log(`UNUSABLE: 音频读口 HTTP ${audio.status}${error === null ? '' : `（${error.code}: ${clip(error.message)}）`}`)
        return 1
      }
      if (!isAudioContentType(audio.contentType)) {
        console.log(`UNUSABLE: 音频读口的 content-type 既不是 audio/* 也不是 application/octet-stream（${String(audio.contentType)}）`)
        return 1
      }
      if (audio.bytes.length === 0) {
        console.log('UNUSABLE: 音频读口返回 0 字节')
        return 1
      }
      console.log('USABLE: 合成回执与音频字节都成立')
      return 0
    } finally {
      await closeServer(server)
    }
  } catch (error) {
    console.log(`UNTESTED: 审计没跑成：${clip(error instanceof Error ? error.message : String(error))}`)
    return 2
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.log(`参数错误：${error instanceof Error ? error.message : String(error)}`)
    console.log(usage())
    return 2
  }
  if (args.help) {
    console.log(usage())
    return 0
  }
  let dataDir = args.dataDir
  let ephemeral = false
  if (dataDir === null) {
    // 插件自有身份（内置 / 直出 / 宿主服务）不读数据根；只有订阅 id 才要求 --data-dir。
    // 前缀对不上订阅的 id 仍会走审计，让合成面的 TTS_ENGINE_MISSING 报「参数不成立」。
    if (!isPluginOwnedEngine(args.engineId)) {
      console.log(`UNTESTED: ${args.engineId} 是订阅引擎，需要 --data-dir 指向含 tts-engines.json 的数据根`)
      return 2
    }
    dataDir = await mkdtemp(path.join(tmpdir(), 'dsh-novel-tts-live-'))
    ephemeral = true
  } else if (!existsSync(dataDir)) {
    console.log(`UNTESTED: 数据根不存在：${dataDir}`)
    return 2
  }
  // 临时数据根的创建与回收都归 main：审计的三条提前返回（缺构建产物 / 直出型 / 宿主服务）
  // 发生在它之后也不会漏目录。宿主替身的留痕只在失败退出前打印——成功路径的读数仍是那几行。
  const host = createHost()
  let code
  try {
    code = await audit(host, args.engineId, dataDir)
  } finally {
    host.dispose()
    if (ephemeral) await rm(dataDir, { recursive: true, force: true })
  }
  if (code !== 0) printHostLogs(host.logs)
  return code
}

process.exitCode = await main()
