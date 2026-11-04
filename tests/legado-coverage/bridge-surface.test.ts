import { beforeAll, describe, expect, it } from 'vitest'
import { JAVA_PROTOCOL } from '../../src/engine/js-protocol.js'
import { probeJavaSurface } from '../java-surface.js'
import { must } from '../support/fixture.js'
import { BRIDGE_GAP_NAMES, KNOWN_BRIDGE_GAPS } from './bridge-gaps.js'
import { COVERAGE } from './matrix.js'

/**
 * 本仓桥面自证（默认门）：名册与沙箱挂载面互查，不读书源、不联网。
 * 「脚本调了、本仓没挂」的源侧发现仍归解析面普查（`DSH_PARSE_CENSUS`）。
 */
let surface: Awaited<ReturnType<typeof probeJavaSurface>> | undefined

beforeAll(async () => {
  surface = await probeJavaSurface()
})

function probed(): Awaited<ReturnType<typeof probeJavaSurface>> {
  return must(surface, '沙箱探针')
}

describe('桥面自证', () => {
  it('名册没有重名', () => {
    const seen = new Set<string>()
    const dup = KNOWN_BRIDGE_GAPS.filter((gap) => (seen.has(gap.name) ? true : (seen.add(gap.name), false)))
      .map((gap) => gap.name)
    expect(dup, `名册里有重复的名字：${dup.join(' / ')}`).toEqual([])
    expect(BRIDGE_GAP_NAMES.size).toBe(KNOWN_BRIDGE_GAPS.length)
  })

  it('名册点名的缺席项真的不在沙箱挂载面', () => {
    const names = probed().names
    const landed = KNOWN_BRIDGE_GAPS.filter((gap) => names.has(gap.name)).map((gap) => gap.name)
    expect(landed, `这些名字已经挂上桥面，名册该删或改：${landed.join(' / ')}`).toEqual([])
  })

  it('名册指向的矩阵行都在册', () => {
    const ids = new Set(COVERAGE.map((row) => row.id))
    const bad = KNOWN_BRIDGE_GAPS.filter((gap) => !ids.has(gap.row)).map((gap) => `${gap.name} → ${gap.row}`)
    expect(bad, `名册指向了不存在的矩阵行：${bad.join(' / ')}`).toEqual([])
  })

  it('协议表里的真实现没被沙箱桩覆盖', () => {
    const stubs = probed().stubs
    const clobbered = JAVA_PROTOCOL.map((row) => row.name).filter((name) => stubs.has(name))
    expect(clobbered, `这些协议表名字在沙箱里仍是桩：${clobbered.join(' / ')}`).toEqual([])
  })
})
