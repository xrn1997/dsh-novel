import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.js'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'

function ref<T>(value: T) {
  let current = value
  return {
    get: () => current,
    [Symbol.for('cosmokit.volatile.write')]: (next: T) => { current = next },
  }
}

describe('ReadingService 活配置', () => {
  it('localImportMaxBytes 读 getter 当前快照', async () => {
    const dir = await makeTempDir('novel-live-')
    const max = ref(1024)
    const svc = trackService(await ReadingService.create({
      dir,
      config: resolveConfig({ localImportMaxBytes: max } as any),
    }))
    expect(svc.localImportMaxBytes).toBe(1024)
    ;(max as any)[Symbol.for('cosmokit.volatile.write')](2048)
    expect(svc.localImportMaxBytes).toBe(2048)
    svc.dispose()
    await svc.flush()
  })
})
