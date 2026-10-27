import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileSourceSession } from '../../src/services/source-session.js'
import { backupPathOf, CorruptJsonError } from '../../src/services/storage.js'

describe('FileSourceSession', () => {
  it('persists vars/string/cache/cookies across instances', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-session-'))
    const a = createFileSourceSession(dir)
    a.sourceVars('src').set('k', 'v')
    a.setSourceString('src', 'single')
    a.cacheStore('src').set('c', '1')
    a.cookieJar('src').set('ck', '1')
    a.flush()

    const b = createFileSourceSession(dir)
    expect(b.sourceVars('src').get('k')).toBe('v')
    expect(b.sourceString('src')).toBe('single')
    expect(b.cacheStore('src').get('c')).toBe('1')
    expect(b.cookieJar('src').get('ck')).toBe('1')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('同一批写只在 flush 时落一次盘，不在每次 set 同步写整份状态', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-session-'))
    const file = path.join(dir, 'source-state.json')
    const a = createFileSourceSession(dir)
    a.sourceVars('src').set('k1', 'v1')
    a.sourceVars('src').set('k2', 'v2')
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    a.flush()
    const b = createFileSourceSession(dir)
    expect(b.sourceVars('src').get('k1')).toBe('v1')
    expect(b.sourceVars('src').get('k2')).toBe('v2')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('keeps "never set" distinguishable for peekSourceVars', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-session-'))
    const a = createFileSourceSession(dir)
    expect(a.peekSourceVars('never')).toBeUndefined()
    a.sourceVars('seen').set('k', 'v')
    expect(a.peekSourceVars('seen')?.get('k')).toBe('v')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('forget clears every bucket of a source and persists the removal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-session-'))
    const a = createFileSourceSession(dir)
    a.sourceVars('gone').set('k', 'v')
    a.setSourceString('gone', 's')
    a.cacheStore('gone').set('c', '1')
    a.cookieJar('gone').set('ck', '1')
    a.sourceVars('kept').set('k', 'v')
    a.forget('gone')
    expect(a.sourceVars('gone').size).toBe(0)
    expect(a.sourceString('gone')).toBe('')
    expect(a.cacheStore('gone').size).toBe(0)
    expect(a.cookieJar('gone').size).toBe(0)
    expect(a.sourceVars('kept').get('k')).toBe('v')
    const b = createFileSourceSession(dir)
    expect(b.sourceVars('gone').size).toBe(0)
    expect(b.cacheStore('gone').size).toBe(0)
    expect(b.cookieJar('gone').size).toBe(0)
    expect(b.sourceString('gone')).toBe('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('corrupt state backs up and throws instead of silently starting empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-session-'))
    const file = path.join(dir, 'source-state.json')
    await fs.writeFile(file, '{"vars":', 'utf8')
    expect(() => createFileSourceSession(dir)).toThrow(CorruptJsonError)
    await expect(fs.stat(backupPathOf(file))).resolves.toBeTruthy()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('wrong-typed bucket is corruption, not an empty table', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-session-'))
    await fs.writeFile(path.join(dir, 'source-state.json'), '{"vars":null}', 'utf8')
    expect(() => createFileSourceSession(dir)).toThrow(CorruptJsonError)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
