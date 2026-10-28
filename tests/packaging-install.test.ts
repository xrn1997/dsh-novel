import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

// 真装载链路验证（DSH_INSTALL_CHECK=1 门控——调真实 dsh CLI，一次性 profile novel-smoke，
// 不碰用户日常 web profile；最终挂进 web profile 的命令在 README，由用户执行）

const repo = process.cwd()
const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
  name: string
  version: string
}
const PLUGIN_ID = manifest.name
const PROFILE = 'novel-smoke'

/** shell: true 只负责解析 dsh.cmd；路径要自己加引号，否则用户名/仓库路径带空格会断参。 */
const quotePath = (value: string): string => `"${value}"`
const run = (args: string[]): string => execFileSync('dsh', args, { encoding: 'utf8', shell: true })

/** 门开着才求值：homedir() 跨平台，缺 DSH_HOME 时 Windows / Linux 都落到用户主目录。 */
const profileDir = () =>
  path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'profiles', PROFILE)

const installedDir = () =>
  path.join(profileDir(), 'node_modules', ...PLUGIN_ID.split('/'))

const readProfile = () => JSON.parse(readFileSync(path.join(profileDir(), 'package.json'), 'utf8'))

/** 装进去的账：bundles 认领本插件，且预构建产物与补丁文件真在挂载点就位。 */
function expectMounted() {
  expect(readProfile().dsh.profile.bundles).toContain(PLUGIN_ID)
  expect(existsSync(path.join(installedDir(), 'lib', 'client.js'))).toBe(true)
  expect(existsSync(path.join(installedDir(), 'cordis.patch.yml'))).toBe(true)
}

function uninstall() {
  run(['plugin', '--profile', PROFILE, 'remove', PLUGIN_ID])
}

/**
 * 宿主的 remove 只摘 bundles，node_modules 里的已装包目录留在原地；下一次安装要往同一个
 * 位置 rename，Windows 上撞上它就是一条 ERR_PNPM_EPERM。两种装法各跑一次，中间必须自己清。
 */
function removeInstalledPackage() {
  rmSync(installedDir(), { recursive: true, force: true })
}

/** 上一次跑留下的安装状态先摘干净；不吞 remove 的失败——CLI 真坏了要当场红。 */
function resetProfile() {
  const pkgPath = path.join(profileDir(), 'package.json')
  if (existsSync(pkgPath)) {
    const profilePkg = readProfile()
    const installed = profilePkg.dsh?.profile?.bundles?.includes(PLUGIN_ID)
      || profilePkg.dependencies?.[PLUGIN_ID] !== undefined
    if (installed) uninstall()
  }
  removeInstalledPackage()
}

/** remove 之后 profile 不再认领本插件；挂载目录由 removeInstalledPackage 清掉。 */
function expectUninstalled() {
  expect(readProfile().dsh.profile.bundles).not.toContain(PLUGIN_ID)
  expect(existsSync(installedDir())).toBe(false)
}

/** 两种装法共用的往返：add → 挂载 → remove → 清目录。 */
function installRoundTrip(target: string) {
  resetProfile()
  run(['plugin', '--profile', PROFILE, 'add', quotePath(target)])
  expectMounted()
  uninstall()
  removeInstalledPackage()
  expectUninstalled()
}

describe.skipIf(process.env.DSH_INSTALL_CHECK !== '1')(`真装载链路（一次性 profile ${PROFILE}）`, () => {
  it('build → add → bundles 挂载 + lib 就位；remove → 摘除', { timeout: 300_000 }, () => {
    // 先构建：dsh plugin add <本地源码目录> 走 pnpm 的 link: 协议，pnpm 只建目录链接、
    // 绝不在对端跑 prepare（README「本地源码调试」已钉死这条语义）。所以「从源码目录装入」
    // 的文档流程本就包含 pnpm build；门控测试必须自建 lib/，否则只有本机恰好被更早的
    // test:pack 建过时才绿——在新克隆上必然红（缺 lib/client.js），是典型的「假绿钉子」。
    execFileSync('pnpm', ['build'], { cwd: repo, encoding: 'utf8', shell: true })
    installRoundTrip(repo)
  })

  it('Release 资产形态：pack → add tarball → bundles 挂载 + lib 就位；remove → 摘除', { timeout: 300_000 }, () => {
    // GitHub Release 挂的就是 `pnpm pack` 的 tarball（.github/workflows/release.yml），用户把它
    // 直接交给 `dsh plugin add`；这一格量「那条路真能装进宿主」，不量 tarball 内容
    // （内容归 workflow 的 tar 断言；`test:pack` 只验 lib 形状）。pack 自带 prepack 构建。
    const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-novel-pack-'))
    try {
      const output = execFileSync('pnpm', ['pack', '--pack-destination', quotePath(tmp)], {
        cwd: repo, encoding: 'utf8', shell: true,
      })
      const printed = output.trim().split(/\r?\n/).filter(Boolean).at(-1)
      if (printed === undefined || !printed.endsWith('.tgz')) {
        throw new Error(`pnpm pack 的末行不是 tarball 路径：${printed ?? '<empty>'}`)
      }
      const tgz = path.isAbsolute(printed) ? printed : path.join(tmp, printed)
      // README 钉版本 URL 用的就是这个名字；pnpm 改名时这里先红，不必等发版后 404。
      expect(path.basename(tgz)).toBe(
        `${PLUGIN_ID.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`,
      )
      installRoundTrip(tgz)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
