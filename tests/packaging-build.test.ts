import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

// 构建产物自检（先 pnpm build 或 pnpm test:pack）——常规集已排除本文件
const hasLib = existsSync('lib/index.js') && existsSync('lib/client.js')

describe.skipIf(!hasLib)('构建产物（先跑 pnpm build 或 pnpm test:pack）', () => {
  it('host 半：ESM、含插件身份与 API 前缀、无 ModuleLoader 泄染', () => {
    const js = readFileSync('lib/index.js', 'utf8')
    expect(js).toContain('@xrn1997/dsh-novel')
    expect(js).toContain('/novel-api')
    expect(js).not.toContain('__ModuleLoader__')
  })
  it('client 半：三段式工厂包裹（首行 load + footer 在 sourcemap 注释前收口）', () => {
    const js = readFileSync('lib/client.js', 'utf8')
    expect(js.trimStart().startsWith('window.__ModuleLoader__.load({')).toBe(true)
    // sourcemap: true 时 footer 之后还有 //# sourceMappingURL 注释（官方样例同款形态）；
    // rolldown 会把 footer 拆行——用容忍空白的正则匹配 `return module.exports; } });`
    const footerMatch = /return module\.exports;\s*\}\s*\}\);/.exec(js)
    expect(footerMatch).not.toBeNull()
    const mapIdx = js.indexOf('//# sourceMappingURL=')
    expect(mapIdx).toBeGreaterThan(footerMatch!.index)
    expect(js).toContain('sidebar.panellist')           // 全局面板双注册进了 bundle（2026-09 迁移）
    expect(js).toContain('novel-status')                // 常驻状态层注册仍在
  })
  it('client 半纯度：require 白名单外零泄漏', () => {
    const js = readFileSync('lib/client.js', 'utf8')
    const requires = [...js.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
    const allowed = [
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
      '@deepseek-ai/cordis', 'cordis',
      '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    ]
    expect(requires.filter((r) => !allowed.includes(r))).toEqual([])
  })
  it('dts 存在且导出入口签名', () => {
    const dts = readFileSync('lib/index.d.ts', 'utf8')
    expect(dts).toContain('apply')
    expect(dts).toContain('Config')
  })
})
