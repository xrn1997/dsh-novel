import { describe, expect, it } from 'vitest'
import { COVERAGE } from './matrix.js'

/**
 * **判据①的机器那一半**：「每条 legado 语义都有归属」这句话原先只是**人说的**——
 * 矩阵行若不提能力单元，清单新增一项而矩阵忘了补，什么都不会报红。本文件把归属落成在册数据：
 *
 * 1. **映射完整性**：每个能力单元都要映射到 ≥2 条真实存在的矩阵行（≥2 是因为单行容易顺手挂错；
 *    映射里的行若在矩阵中被改名 / 删除，立即报红）。
 * 2. **单元集合不许留僵尸**：键必须是 `A1…K` 的形状、组字母在矩阵里有行，且矩阵每个能力组都得
 *    至少有一个单元（组的清单增删要同步这里——只看 `unit[0]` 的旧写法放得过 `A99`，等于没管形状）。
 *
 * 曾经的第 3 层「从不入库的手抄笔记现读小节集合做双向比对」已**删除**：
 * 那份笔记属过程产物，笔记一消失这层就静默转 skip（实测读数 1338|3 → 1337|4，无一物变红）。
 * 判据的分母不能架在会蒸发的文件上。上面这份 `UNITS` 就是**在册**的能力单元清单（31 项），
 * 「对面有没有新增能力 / 字段」改由 `upstream-fields.test.ts` 直接读对面 rule 实体判，
 * 「引用还指得到东西吗」由 `citation-liveness.test.ts` 判。
 *
 * 单元口径：`UNITS` 是**自足**的在册数据（不指向任何仓外文档）——它当年按参考实现盘点的小节切分，
 * 编号 A1…F2 是细分节、E/G/H/I/J/K 是整节；编号在这里只是**键**，别处不再引用，所以小节怎么切
 * 不影响任何判据，改的只有这份清单自己。
 */
const UNITS: Record<string, string[]> = {
  A1: ['a-reduction-contract', 'a-segment-loc', 'a-unknown-segment-throws', 'a-value-terminal-stringify'],
  A2: ['a-json-context-terminal', 'a-xpath-single-slash-prefix', 'a-mode-flip-on-template', 'a-mode-webjs-prefix', 'a-css-explicit', 'a-bare-index-segment'],
  A3: ['a-combining-or', 'a-combining-and', 'a-combining-zip', 'a-combining-mixed', 'a-blank-segment-dropped', 'a-blank-branch-dropped'],
  A4: ['a-default-selectors', 'a-index-suffix', 'a-bracket-single', 'a-bracket-multi', 'a-exclude', 'a-text-containing', 'a-get-terminals', 'a-attr-terminal'],
  A5: ['a-replace-tail', 'a-replace-only-one', 'a-replace-group-refs', 'a-replace-empty-rule', 'a-replace-interp'],
  A6: ['a-template-braces', 'a-template-escaped-at', 'a-json-path-inline', 'a-get-brace-form', 'a-make-up-rule-in-js', 'a-xpath-prefix-vs-url-template', 'a-brace-region-atomic'],
  A7: ['a-put-region', 'a-put-only-rule', 'a-put-big-variable', 'a-var-scope-chain', 'a-var-source-tier', 'a-get-bookname-title'],
  A8: ['a-rule-usage-axis', 'g-unescape-html4', 'b-relative-abs', 'e-intro-format-html'],
  A9: ['a-reduction-contract', 'a-lazy-branch-parse', 'd-name-author-cleanup', 'f-toc-empty-exception', 'g-content-empty-exception'],
  B1: ['b-param-split', 'b-split-unconditional', 'b-url-js-first', 'b-template-vars'],
  B2: ['b-page-angle-list', 'b-trim-first-page'],
  B3: ['b-opt-method', 'b-opt-body', 'b-opt-charset', 'b-opt-headers', 'b-opt-webview', 'b-opt-unknown-keys', 'b-opt-retry', 'b-dns-ip', 'b-data-uri-body'],
  B4: ['b-template-vars', 'b-url-result-token', 'h-result-binding'],
  B5: ['b-cookie-jar', 'b-login-url', 'b-login-check-js', 'b-login-ui', 'b-header-static', 'b-header-js'],
  B6: ['b-opt-webview', 'a-mode-webjs-prefix', 'h-android-packages'],
  B7: ['e-can-re-read', 'c-can-re-name', 'd-respond-time-inflation', 'h-tts-and-search-bridges'],
  C1: ['c-identity', 'c-book-source-type', 'c-book-url-pattern', 'c-check-key-word'],
  C2: ['c-header', 'c-js-lib', 'c-js-lib-url-dict', 'b-concurrent-rate', 'b-timeout', 'c-unmapped-silent'],
  C3: ['c-rule-search-subfields', 'c-explore-url', 'c-content-fields', 'c-toc-next', 'c-stringified-rule-objects', 'c-raw-fidelity', 'c-content-title', 'c-content-sub-content', 'g-callback-js'],
  C4: ['c-identity', 'd-groups-scope', 'k-import-dedup'],
  D1: ['d-book-list-fallback', 'd-name-author-cleanup', 'd-precise-search', 'c-search-url'],
  D2: ['d-search-face', 'd-search-paging', 'd-merge-dedup', 'd-groups-scope', 'd-check-flow'],
  D3: ['c-explore-url', 'd-explore-three-forms', 'd-explore-fallback-search-rule', 'h-source-refresh-explore'],
  E: ['e-detail-fields', 'e-detail-fallback-flat', 'e-init-replace-content', 'e-toc-html-reuse', 'e-word-count-format', 'e-intro-special-prefix'],
  F1: ['f-toc-rules', 'f-toc-url-per-item', 'f-toc-url-fallback', 'f-toc-paging', 'f-toc-reverse-twice', 'f-toc-cache', 'f-chapter-tag-update-time', 'c-toc-url'],
  F2: ['f-txt-toc-rule', 'i-txt-toc-rule', 'j-local-book'],
  G: ['g-content-rule', 'g-next-content', 'g-chapter-boundary-guard', 'g-html-to-text', 'g-entity-decode', 'g-paragraph-title', 'g-image-url-options', 'g-pay-action', 'g-review-img-from-title'],
  H: ['h-java-ajax-sync', 'h-java-connect', 'h-js-protocol-table', 'h-elem-bridge', 'h-packages-crypto', 'h-aes-shim', 'h-get-string-recursive', 'h-get-string-is-url', 'h-abs-urls', 'h-file-store', 'h-sandbox-escape-defense', 'h-timeout-double-gate'],
  I: ['i-global-replace-rule', 'i-dict-rule', 'i-highlight-rule', 'i-rule-complete', 'i-rule-sub'],
  J: ['j-review', 'j-rss', 'j-audio-image-file', 'c-review-url'],
  K: ['k-import-formats', 'k-export-sources', 'k-edit-source', 'k-debug-page', 'k-probe', 'k-groups-sort-filter', 'k-source-variables-cleanup', 'k-auth-redline', 'k-tools-face', 'k-content-audit-gate'],
}

describe('能力单元 → 矩阵的归属映射（判据①的机器那一半）', () => {
  const ids = new Set(COVERAGE.map(r => r.id))

  it('每个能力单元都映射到 ≥2 条真实存在的矩阵行', () => {
    const bad: string[] = []
    for (const [unit, rows] of Object.entries(UNITS)) {
      if (rows.length < 2) bad.push(`${unit}: 只挂了 ${rows.length} 行`)
      for (const r of rows) if (!ids.has(r)) bad.push(`${unit} → ${r}: 矩阵里没有这一行`)
    }
    expect(bad, bad.join(' / ')).toEqual([])
  })

  it('单元键的形状与覆盖：A1…K 形态、组字母有行、矩阵每个组都有单元', () => {
    const groups = new Set(COVERAGE.map(r => r.group[0]))
    const bad: string[] = []
    for (const unit of Object.keys(UNITS)) {
      if (!/^[A-K][1-9]?$/.test(unit)) bad.push(`${unit}: 键形状不是 A1…K（细分节 = 字母+一位数字，整节 = 单字母）`)
      else if (!groups.has(unit[0])) bad.push(`${unit}: 组 ${unit[0]} 在矩阵里没有行`)
    }
    for (const g of groups) {
      if (!Object.keys(UNITS).some(u => u[0] === g)) bad.push(`能力组 ${g} 没有任何单元（矩阵加了组要同步 UNITS）`)
    }
    expect(bad, bad.join(' / ')).toEqual([])
  })
})
