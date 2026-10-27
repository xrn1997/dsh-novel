import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// 真装载链路验证（DSH_INSTALL_CHECK=1 门控——调真实 dsh CLI，一次性 profile novel-smoke，
// 不碰用户日常 web profile；最终挂进 web profile 的命令在 README，由用户执行）

describe.skipIf(process.env.DSH_INSTALL_CHECK !== '1')('真装载链路（一次性 profile novel-smoke）', () => {
  it('build → add → bundles 挂载 + lib 就位；remove → 摘除', { timeout: 300_000 }, () => {
    const repo = process.cwd()
    // 门开着才求值：homedir() 跨平台，缺 DSH_HOME 时 Windows / Linux 都落到用户主目录。
    const profileDir = path.join(
      process.env.DSH_HOME ?? path.join(homedir(), '.dsh'),
      'profiles', 'novel-smoke',
    )
    const run = (args: string[]): string => execFileSync('dsh', args, { encoding: 'utf8', shell: true })
    // 先构建：dsh plugin add <本地源码目录> 走 pnpm 的 link: 协议，pnpm 只建目录链接、
    // 绝不在对端跑 prepare（README「本地源码调试」已钉死这条语义）。所以「从源码目录装入」
    // 的文档流程本就包含 pnpm build；门控测试必须自建 lib/，否则只有本机恰好被更早的
    // test:pack 建过时才绿——在新克隆上必然红（缺 lib/client.js），是典型的「假绿钉子」。
    execFileSync('pnpm', ['build'], { cwd: repo, encoding: 'utf8', shell: true })
    try { run(['plugin', '--profile', 'novel-smoke', 'remove', '@xrn1997/dsh-novel']) } catch { /* 未装过 */ }
    run(['plugin', '--profile', 'novel-smoke', 'add', repo])
    const pkg = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    expect(pkg.dsh.profile.bundles).toContain('@xrn1997/dsh-novel')
    expect(existsSync(path.join(profileDir, 'node_modules', '@xrn1997/dsh-novel', 'lib', 'client.js'))).toBe(true)
    expect(existsSync(path.join(profileDir, 'node_modules', '@xrn1997/dsh-novel', 'cordis.patch.yml'))).toBe(true)
    run(['plugin', '--profile', 'novel-smoke', 'remove', '@xrn1997/dsh-novel'])
    const after = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    expect(after.dsh.profile.bundles).not.toContain('@xrn1997/dsh-novel')
  })
})
