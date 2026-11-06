# 本地文件的两道终点判据：具名容器头在入口拒，解码终点断言「这是不是可读文本」

Status: superseded by 0065

TXT 链对**任何**字节都能给出结果（GBK 兜底不失败、无标题就切一章），所以「分流之后一路放行」等于
坏字节可以以「1 章导入成功」的姿态入架。现在补两条各自独立、各自有主的判据：认得出的**具名**容器头
（`%PDF-`、`BOOKMOBI`）在 `LocalBooks.import` 的入口拒；TXT 解码之后、切章之前，
`assertReadableDecodedText` 要求解出来的文本里没有空字符（U+0000）且不全是空白。

## 背景

`ADR-0014` 立的是**分流**判据（只看 ZIP 签名，且明确否掉「对一切非 UTF-8 字节判拒」的全量启发式），
它没有要求在解码链的终点放一道断言——这个空子被真实文件踩到了：一份文件头被清零的坏归档
（不是 ZIP 签名）落进 TXT 链，整本二进制被当文本存成一本只有一章的书并回执 200。
`tests/legado-coverage/matrix.ts` 的 `j-local-book-other-formats` 行早就写过这条后果
（「会被 TXT 链当文本读、可能落成一本乱码书——这不是『支持』」），本篇落掉它挂着的裁决。

同一族还有一个没被报出来的洞：全文只有空白的 TXT 也会以「1 章正文」入架。两条判据一起收。

## 决定

1. **入口的具名魔数**：`namedContainerMagicOf` 认 `%PDF-`（偏移 0）与 `BOOKMOBI`（PDB 的 creator/type，偏移 60）。
   认出即 `LocalImportError`（400），消息点名是哪一种容器，并说清本地导入只支持 TXT 与 EPUB。
2. **解码终点**：`assertReadableDecodedText` 在 `decodeLocalText` 之后、`splitChapters` 之前跑。
   含 U+0000 → 拒：解出来的字符串里出现它，说明字节不是本仓能按 UTF-8/GBK 读出的文本
   （清零/截断的二进制，或无 BOM 的 UTF-16 一类未识别编码——真散文不会带它）；
   `trim()` 后为空 → 拒。
3. **UMD 不进本篇**：它的头部串在本仓没有一手依据，不写进具名清单。第 2 条只在解出来含空字符或
   没有非空白内容时拒，**不负责认出它**——不含这两种特征的 UMD 仍会落进 TXT 链，这是本仓承认的
   残余面（与「不接」是同一件事的两面）。判「不适用」的理由与这条边界一起记在矩阵行 `note` 里。

## 被否方案

- **按 `?name=` 的扩展名判**：`name` 是客户端可写的查询参数（`api/dispatch.ts` 的 `localImport`），
  判据挂在最不可信的一侧；`ADR-0014` 第 ③ 条已经为同一理由否过按后缀分流。名字与内容不符**至多**
  值得一条痕，不值得一个判据。
- **「看起来像二进制就拒」的比例启发式**：维持 `ADR-0014` 第 ② 条的否决——它会误伤现网真能读的
  GBK 短篇与含控制字符的导出 TXT，把「偶尔一本乱码书」换成「一批书读不了」。钉子用例：带 ESC/BEL
  但无 NUL 的 GBK 文本必须**仍然导入成功**。
- **在 `hasZipMagic` 之前先试开归档**：见 `ADR-0014`（把安全拒绝吞成「不是 EPUB」）。
- **只在 TXT 链入口查 NUL（不查全空白）**：全空白文件里没有 NUL，仍然会以一本空书入架——同一条罪的另一半。

## 后果

- 坏字节不再报成功；`j-local-book-other-formats` 从「未接、无裁决」变成「不适用 + 具名拒收」。
- PDF 仍然读不了：本篇做的是**不再假装读得进**，不是支持它。三种媒介各自的容器、压缩、编码、目录
  四件事要不要做、按什么顺序做，另立调研（MOBI/AZW3 内嵌正文形态是否可复用 EPUB 正文层，未核）。
- 本地导入的失败口径变化对用户可见，`README.md` 的本地书一节同批改。

锚点：`src/services/localbooks.ts` 的 `namedContainerMagicOf` / `assertReadableDecodedText` / `LocalBooks.import` /
`LocalBooks.publishText` / `hasZipMagic`；`tests/services/localbooks.test.ts` 的
「本地文件的终点判据：坏字节不许冒充可读文本」（含 GBK 控制字符那条防回归钉）；
`ADR-0014`（分流判据与它留下的在册待裁）；矩阵行 `j-local-book`、`j-local-book-epub`、`j-local-book-other-formats`。
