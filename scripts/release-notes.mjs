#!/usr/bin/env node
/**
 * GitHub Release 正文生成器：发版工作流（`.github/workflows/release.yml`）把它的输出交给
 * `gh release create --notes-file`。
 *
 * 为什么不用 `--generate-notes`：它只列 PR / commit 标题，读者看不到「这一版改了什么、
 * 兼容窗口是什么、升级需要注意什么」。各事实只认各自唯一的主人，本脚本只做投影：
 * - 📋 版本与兼容 ← `package.json`（`name` / `version` / `peerDependencies["@deepseek-ai/dsh-tools"]` / `engines.node` / `dsh.compatibility.dshReleases`）
 * - ✨ 更新内容 ← `CHANGELOG.md` 该版条目原文；文中的 `ADR-NNNN` 补成 GitHub 可点链接
 * - ✅ 发布验证 ← 发版工作流实跑项；门链从 `scripts.gates` 原样投影，不抄第二份清单
 * - 📦 安装 ← 由 `name` / `version` 派生的安装命令；compare 链接的上一版取 `CHANGELOG.md` 的上一条目
 *
 * `CHANGELOG.md` 查不到当前版本条目或条目为空就直接退出，不编造正文。
 *
 * 用法：node scripts/release-notes.mjs [--root <仓根>] [--version <版本>] <输出文件>
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = '用法：node scripts/release-notes.mjs [--root <仓根>] [--version <版本>] <输出文件>'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, version: undefined, out: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root' || arg === '--version') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) fail(`${arg} 缺参数\n${USAGE}`)
      index += 1
      if (arg === '--root') options.root = resolve(value)
      else options.version = value
    } else if (arg.startsWith('-')) {
      fail(`未知参数：${arg}\n${USAGE}`)
    } else if (options.out === undefined) {
      options.out = arg
    } else {
      fail(`多余参数：${arg}\n${USAGE}`)
    }
  }
  if (options.out === undefined) fail(USAGE)
  return options
}

/**
 * 解析 `CHANGELOG.md` 中指定版本的条目正文与上一版本。
 * 同时兼容 `## 0.13.0 — 2026-11-23` 与 `## [0.13.0] - 2026-11-23` 两种标题格式；
 * 文件顺序为从新到旧。
 */
function changelogSection(markdown, version) {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const headings = [...normalized.matchAll(/^## (?:\[([^\]]+)\]|(\S+))\s+(?:—|-)\s+.*$/gm)]
  const index = headings.findIndex((match) => (match[1] ?? match[2]) === version)
  if (index === -1) return undefined

  const current = headings[index]
  const start = current.index + current[0].length
  const end = index + 1 < headings.length ? headings[index + 1].index : normalized.length
  const body = normalized.slice(start, end).trim()
  if (body.length === 0) {
    fail(`CHANGELOG.md 里 ${version} 的条目为空；先补写发布记录再发。`)
  }
  const next = headings[index + 1]
  return { body, previous: next ? (next[1] ?? next[2]) : undefined }
}

/** 将 `package.json` 的 `repository` 字段规约为仓库 Web URL。 */
function repoWebUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url ?? ''
  return raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

/** 读取 `docs/adr/` 下的篇号 → 文件名映射；目录缺席时返回空表。 */
function adrFileMap(root) {
  const map = new Map()
  try {
    for (const name of readdirSync(join(root, 'docs', 'adr'))) {
      const match = /^(\d{4})-.+\.md$/.exec(name)
      if (match) map.set(match[1], name)
    }
  } catch {
    return map
  }
  return map
}

/** 将正文中的 `ADR-NNNN` 补成 GitHub 可点链接；完整 Markdown 链接与行内代码原样保留。 */
function linkifyAdr(text, root, repoUrl) {
  const files = adrFileMap(root)
  if (files.size === 0) return text
  return text.replace(
    /(`+[^`]*`+|\[[^\]]*\]\([^)]*\))|(?<![[`])\bADR-(\d{4})\b/g,
    (whole, protectedSpan, num) => {
      if (protectedSpan !== undefined) return whole
      const file = files.get(num)
      return file ? `[${whole}](${repoUrl}/blob/main/docs/adr/${file})` : whole
    },
  )
}

function buildNotes({ pkg, version, section, root }) {
  if (!pkg.name) fail('package.json 缺 name：包名没处可指')
  const repoUrl = repoWebUrl(pkg.repository)
  if (!repoUrl) fail('package.json 缺 repository.url：compare 与 ADR 链接没处可指')
  const dshRange = pkg.peerDependencies?.['@deepseek-ai/dsh-tools']
  if (!dshRange) fail("package.json 缺 peerDependencies['@deepseek-ai/dsh-tools']：DSH 兼容窗口没处可指")
  const nodeRange = pkg.engines?.node
  if (!nodeRange) fail('package.json 缺 engines.node：Node 要求没处可指')
  const gates = pkg.scripts?.gates
  if (!gates) fail('package.json 缺 scripts.gates：发布验证的门链没处可指')

  const ledger = Object.entries(pkg.dsh?.compatibility?.dshReleases ?? {})
    .filter(([, status]) => status === 'compatible')
    .map(([ver]) => ver)
  const tarball = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
  const tag = (ver) => `V${ver}`

  const lines = [
    '## 📋 版本与兼容',
    '',
    `- 插件版本：\`${pkg.name}@${version}\``,
    `- DSH 兼容窗口：\`${dshRange}\`（\`peerDependencies["@deepseek-ai/dsh-tools"]\`）`,
    `- Node 要求：\`${nodeRange}\``,
  ]
  if (ledger.length > 0) {
    lines.push(
      `- 真机实测：DSH ${ledger.map((ver) => `\`${ver}\``).join('、')}（实测账本 \`dsh.compatibility.dshReleases\`；窗口内未列的版本未实测）`,
    )
  }
  lines.push(
    '',
    '## ✨ 更新内容',
    '',
    linkifyAdr(section.body, root, repoUrl),
    '',
    '## ✅ 发布验证',
    '',
    `- 本次发版工作流实跑并通过 \`pnpm gates\`（\`${gates}\`）与 Release tarball 挂载产物断言`,
    '- 真机验证与真链路门（`DSH_*`）不在 CI 内：真跑过的宿主代次见上「真机实测」',
    '',
    '## 📦 安装',
    '',
    'npm（推荐）：',
    '',
    '```bash',
    `dsh plugin --profile <profile> add ${pkg.name}@${version}`,
    '```',
    '',
    `离线安装包（下载本页资产 \`${tarball}\`，无需构建工具链）：`,
    '',
    '```bash',
    `dsh plugin --profile <profile> add ./${tarball}`,
    '```',
    '',
    `装完重启宿主；其余装法（Release URL / 从源码装）与兼容说明见 [README「安装」](${repoUrl}#安装)。`,
  )
  if (section.previous) {
    lines.push(
      '',
      `完整变更记录：[${tag(section.previous)}...${tag(version)}](${repoUrl}/compare/${tag(section.previous)}...${tag(version)})`,
    )
  }
  return `${lines.join('\n')}\n`
}

const options = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(options.root, 'package.json'), 'utf8'))
const version = options.version ?? pkg.version
if (!version) fail('package.json 缺 version，且未传 --version')
const changelog = readFileSync(join(options.root, 'CHANGELOG.md'), 'utf8')
const section = changelogSection(changelog, version)
if (!section) fail(`CHANGELOG.md 里没有 ${version} 的条目；按发版流程先写发布记录再发。`)

const notes = buildNotes({ pkg, version, section, root: options.root })
const out = resolve(options.out)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, notes, 'utf8')
console.log(`Release 正文已写入 ${out}（${version}${section.previous ? `，上一版 ${section.previous}` : '，首个版本无 compare 段'}）`)
