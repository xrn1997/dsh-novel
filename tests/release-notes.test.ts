import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { must } from './support/fixture.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs')

interface PackageFacts {
  name: string
  version: string
  engines?: { node?: string }
  scripts?: Record<string, string>
  peerDependencies?: Record<string, string>
  repository?: { url?: string } | string
  dsh?: { compatibility?: { dshReleases?: Record<string, string> } }
}

interface Generation {
  status: number | null
  stderr: string
  notes: string
}

const BASE_PKG: PackageFacts = {
  name: '@acme/demo',
  version: '0.2.0',
  engines: { node: '>=24' },
  scripts: { gates: 'pnpm typecheck && pnpm test' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.7-rc.1 <0.3.0-0' },
  repository: { url: 'git+https://github.com/acme/demo.git' },
  dsh: {
    compatibility: {
      dshReleases: {
        '0.2.2-rc.5': 'compatible',
        '0.1.0-rc.1': 'pending',
      },
    },
  },
}

const SAMPLE_CHANGELOG = `# 发布历史

## 0.2.0 — 2026-11-20

- 新增：能力甲（ADR-0049），未建档引用保持原样（ADR-0050）。
- 修复：保留已有链接 [ADR-0049](https://example.com/custom)、链接文字中段的引用 [翻页裁决（ADR-0049）](https://example.com/wrapped) 与行内代码 \`参见 ADR-0049\`。

**升级注意**：注意甲。

## 0.1.0 — 2026-11-01

- 初始版本。
`

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 合成一个最小仓根：正文只认 package.json / CHANGELOG / docs/adr 三个事实源。 */
function fixture(files: Record<string, string>): string {
  const root = makeTempDir('release-notes-')
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return root
}

function generate(root: string, version?: string): Generation {
  // 输出落临时目录：仓上干跑不许弄脏工作区。
  const out = join(makeTempDir('release-notes-out-'), 'notes.md')
  const args = [SCRIPT, '--root', root, ...(version === undefined ? [] : ['--version', version]), out]
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return {
    status: result.status,
    stderr: result.stderr,
    notes: existsSync(out) ? readFileSync(out, 'utf8') : '',
  }
}

describe('release-notes：Release 正文从 CHANGELOG 与 package.json 投影', () => {
  it('四段结构齐、安装命令与 compare 链接派生自版本、ADR 引用补成可点链接且不重复包裹', () => {
    const root = fixture({
      'package.json': JSON.stringify(BASE_PKG),
      'CHANGELOG.md': SAMPLE_CHANGELOG,
      [join('docs', 'adr', '0049-release-artifact-channel.md')]: '# release channel\n',
    })
    const { status, notes } = generate(root)
    expect(status).toBe(0)
    expect(notes).toContain('## 📋 版本与兼容')
    expect(notes).toContain('- 插件版本：`@acme/demo@0.2.0`')
    expect(notes).toContain('- DSH 兼容窗口：`>=0.1.7-rc.1 <0.3.0-0`（`peerDependencies["@deepseek-ai/dsh-tools"]`）')
    expect(notes).toContain('- Node 要求：`>=24`')
    expect(notes).toContain('DSH `0.2.2-rc.5`')
    expect(notes).not.toContain('0.1.0-rc.1')
    expect(notes).toContain('## ✨ 更新内容')
    expect(notes).toContain('**升级注意**：注意甲。')
    // 一条事实一个家：门链从 scripts.gates 原样投影，正文里没有第二份清单。
    expect(notes).toContain('## ✅ 发布验证')
    expect(notes).toContain('`pnpm typecheck && pnpm test`')
    expect(notes).toContain('## 📦 安装')
    expect(notes).toContain('dsh plugin --profile <profile> add @acme/demo@0.2.0')
    expect(notes).toContain('dsh plugin --profile <profile> add ./acme-demo-0.2.0.tgz')
    expect(notes).toContain('[README「安装」](https://github.com/acme/demo#安装)')
    expect(notes).toContain('[V0.1.0...V0.2.0](https://github.com/acme/demo/compare/V0.1.0...V0.2.0)')
    expect(notes).toContain('[ADR-0049](https://github.com/acme/demo/blob/main/docs/adr/0049-release-artifact-channel.md)')
    expect(notes).toContain('未建档引用保持原样（ADR-0050）')
    expect(notes).not.toContain('[ADR-0050](')
    expect(notes).toContain('保留已有链接 [ADR-0049](https://example.com/custom)')
    expect(notes).toContain('[翻页裁决（ADR-0049）](https://example.com/wrapped)')
    expect(notes).toContain('与行内代码 `参见 ADR-0049`')
  })

  it('兼容 CRLF + BOM、预发布版本号与方括号连字符标题并输出纯 LF', () => {
    const crlfChangelog = [
      '\uFEFF# Changelog',
      '',
      '## 0.2.1-rc.1 — 2026-11-24',
      '',
      '- 预发布条目。',
      '',
      '## [0.2.0] - 2026-11-20',
      '',
      '- 正式版条目。',
      '',
    ].join('\r\n')
    const root = fixture({
      'package.json': JSON.stringify({ ...BASE_PKG, version: '0.2.1-rc.1' }),
      'CHANGELOG.md': crlfChangelog,
    })

    const pre = generate(root)
    expect(pre.status).toBe(0)
    expect(pre.notes).not.toContain('\r')
    expect(pre.notes).toContain('- 预发布条目。')
    expect(pre.notes).toContain('[V0.2.0...V0.2.1-rc.1](https://github.com/acme/demo/compare/V0.2.0...V0.2.1-rc.1)')

    const stable = generate(root, '0.2.0')
    expect(stable.status).toBe(0)
    expect(stable.notes).toContain('- 正式版条目。')
    expect(stable.notes).not.toContain('完整变更记录')
  })

  it('首个版本没有上一版：省略 compare 段，不编造链接', () => {
    const root = fixture({
      'package.json': JSON.stringify(BASE_PKG),
      'CHANGELOG.md': '# 发布历史\n\n## 0.2.0 — 2026-11-20\n\n- 首个版本。\n',
    })
    const { status, notes } = generate(root)
    expect(status).toBe(0)
    expect(notes).not.toContain('完整变更记录')
  })

  it.each<{
    name: string
    pkg?: PackageFacts
    changelog?: string
    expectedError: string
  }>([
    {
      name: 'CHANGELOG 缺少当前版本条目',
      pkg: { ...BASE_PKG, version: '0.3.0' },
      expectedError: 'CHANGELOG.md',
    },
    {
      name: 'CHANGELOG 当前版本正文为空',
      changelog: '# 发布历史\n\n## 0.2.0 — 2026-11-20\n\n## 0.1.0 — 2026-11-01\n\n- 老版本。\n',
      expectedError: '为空',
    },
    {
      name: 'package.json 缺 name',
      pkg: { ...BASE_PKG, name: '' },
      expectedError: 'name',
    },
    {
      name: 'package.json 缺 peerDependencies["@deepseek-ai/dsh-tools"]',
      pkg: { ...BASE_PKG, peerDependencies: {} },
      expectedError: 'peerDependencies',
    },
    {
      name: 'package.json 缺 engines.node',
      pkg: { ...BASE_PKG, engines: {} },
      expectedError: 'engines.node',
    },
    {
      name: 'package.json 缺 scripts.gates',
      pkg: { ...BASE_PKG, scripts: {} },
      expectedError: 'scripts.gates',
    },
    {
      name: 'package.json 缺 repository.url',
      pkg: { ...BASE_PKG, repository: {} },
      expectedError: 'repository.url',
    },
  ])('缺关键事实时立即报错退出：$name', ({ pkg, changelog, expectedError }) => {
    const root = fixture({
      'package.json': JSON.stringify(pkg ?? BASE_PKG),
      'CHANGELOG.md': changelog ?? SAMPLE_CHANGELOG,
    })
    const result = generate(root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(expectedError)
  })

  it('仓上干跑：真实 package.json 与 CHANGELOG.md 能投影出四段正文', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageFacts
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n?/g, '\n')
    const headings = changelog
      .split('\n')
      .filter((line) => line.startsWith('## '))
      .map((line) => must(line.slice(3).trim().split(/\s+/)[0], 'CHANGELOG 版本号'))
    const currentIndex = headings.indexOf(pkg.version)
    expect(currentIndex, `CHANGELOG.md 缺少当前版本 ${pkg.version}`).toBeGreaterThanOrEqual(0)

    const { status, notes } = generate(ROOT)
    expect(status).toBe(0)
    for (const heading of ['## 📋 版本与兼容', '## ✨ 更新内容', '## ✅ 发布验证', '## 📦 安装']) {
      expect(notes).toContain(heading)
    }
    expect(notes).toContain(`\`${pkg.name}@${pkg.version}\``)
    const dshToolsRange = must(pkg.peerDependencies?.['@deepseek-ai/dsh-tools'], 'dsh-tools peer 区间')
    expect(notes).toContain(`\`${dshToolsRange}\``)
    const prev = headings[currentIndex + 1]
    if (prev !== undefined) {
      expect(notes).toContain(`[V${prev}...V${pkg.version}]`)
    }
  })
})
