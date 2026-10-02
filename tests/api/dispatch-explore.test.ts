import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReadingService } from '../../src/services/reading.js'
import { ROUTES } from '../../src/shared/wire.js'
import { startServer } from './helpers.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const NATIVE = {
  name: 'S', url: 'https://s.com',
  searchUrl: '/so/{{keyword}}/{{page}}',
  ruleSearch: { list: '.item', name: 'h3 a', author: 'p a', bookUrl: 'h3 a@href' },
  ruleBookInfo: { name: '.booktxt h1' },
  ruleToc: { list: '#list li', name: 'a', url: 'a@href' },
  ruleContent: { content: '.con' },
  ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
}
const LIST_HTML = '<html><body><div class="item"><h3><a href="/book/1">剑起长安</a></h3>' +
  '<p><a href="/zuozhe/a">青衫客</a></p></div></body></html>'

let svc: ReadingService, base: string, close: () => Promise<void>
beforeAll(async () => {
  const dir = await makeTempDir('novel-api-explore-')
  svc = trackService(await ReadingService.create({
    dir,
    fetchImpl: (async () => new Response(LIST_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as never,
  }))
  await svc.importOne(NATIVE)
  ;({ base, close } = await startServer(svc))
})
afterAll(async () => { await svc.flush(); await close() })

describe('书城发现面', () => {
  it('GET explore/kinds → 本地派生的词表', async () => {
    const r = await fetch(`${base}/novel-api/${ROUTES.exploreKinds.path}`)
    expect(r.status).toBe(200)
    const { value } = await r.json() as any
    expect(value.kinds).toEqual([{ title: '玄幻', sources: 1 }])
  })

  it('POST explore/list 缺 body.kind → 400', async () => {
    const r = await fetch(`${base}/novel-api/${ROUTES.exploreList.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
  })

  it('POST explore/list → jobId；job-status 给出归并后的书单', async () => {
    const r = await fetch(`${base}/novel-api/${ROUTES.exploreList.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: '玄幻' }),
    })
    const { value } = await r.json() as any
    expect(typeof value.jobId).toBe('string')
    let job: any = null
    for (let i = 0; i < 100 && job?.phase === undefined; i++) {
      await new Promise((res) => setTimeout(res, 5))
      const s = await fetch(`${base}/novel-api/${ROUTES.exploreListStatus.path}`)
      job = (await s.json() as any).value.job
      if (job?.phase !== 'running') break
    }
    expect(job.phase).toBe('done')
    expect(job.books.map((b: any) => b.name)).toEqual(['剑起长安'])
  })
})
