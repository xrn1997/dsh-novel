import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { ReadingService } from '../../src/services/reading.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { NOVEL_API_PREFIX } from '../../src/shared/wire.js'

/**
 * fence 拒绝的**可读性**：判据住在 `api/wire.ts`，措辞住在 `api/dispatch.ts`，两面都要真跑一遍——
 * 只写「非受信来源」的 403 让被 Host 名单挡住的人无从下手（自定义域名是他自己能配的）。
 * 这里走真 http.Server + 手写 Host 头，绕开 fetch 不肯给 Host 的限制。
 */

let svc: ReadingService
const closers: (() => Promise<void>)[] = []

async function serve(allowHosts?: readonly string[]): Promise<number> {
  const { base, close } = await startServer(svc, allowHosts === undefined ? undefined : { allowHosts })
  closers.push(close)
  return Number(new URL(base).port)
}

async function get(port: number, hostHeader: string): Promise<{ status: number; message: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: NOVEL_API_PREFIX, method: 'GET', headers: { host: hostHeader } },
      (res) => {
        let text = ''
        res.on('data', (d: Buffer) => { text += d.toString('utf8') })
        res.on('end', () => {
          const body = JSON.parse(text) as { ok: boolean; error?: { message?: string } }
          resolve({ status: res.statusCode ?? 0, message: body.error?.message ?? '' })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  const dir = await makeTempDir('novel-fence-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async () => new Response('<html></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as never,
  }))
})
afterAll(async () => {
  await svc.flush()
  for (const close of closers) await close()
})

describe('/novel-api 的 403 措辞', () => {
  it('Host 不在本机名单：403 点名 Host 并指路 apiAllowHosts', async () => {
    const port = await serve()
    const res = await get(port, 'dsh.local')
    expect(res.status).toBe(403)
    expect(res.message).toContain('dsh.local')
    expect(res.message, '被名单挡住的人要能自己走出去').toContain('apiAllowHosts')
  })

  it('配置列出这个别名后同一发通过（默认三值照旧，不改配置仍是拒）', async () => {
    const port = await serve(['dsh.local'])
    expect((await get(port, 'dsh.local')).status).toBe(200)
    expect((await get(port, 'other.local')).status).toBe(403)
    expect((await get(port, 'localhost')).status).toBe(200)   // 名单是追加，不是替换
  })

  it('403 回显 Host 有长度上限：拒绝理由不许被一个超长 Host 撑爆', async () => {
    const port = await serve()
    const res = await get(port, `${'a'.repeat(400)}.local`)
    expect(res.status).toBe(403)
    expect(res.message).toContain('…')
    expect(res.message.length).toBeLessThan(240)
  })
})
