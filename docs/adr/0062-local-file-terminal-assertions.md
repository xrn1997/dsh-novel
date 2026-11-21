# 本地文件的两道终点判据：具名容器头在入口拒，解码终点断言「这是不是可读文本」

Status: superseded by 0065

TXT 链对任何字节都能给出结果（GBK 兜底不失败、无标题就切一章），所以「分流之后一路放行」等于坏字节可以以「1 章导入成功」入架。补两条各自独立、各自有主的判据：认得出的**具名**容器头（`%PDF-`、`BOOKMOBI`）在入口拒；TXT 解码之后、切章之前，`assertReadableDecodedText` 要求解出来的文本里没有空字符（U+0000）且不全是空白。背景：一份文件头被清零的坏归档落进 TXT 链，整本二进制被当文本存成一本只有一章的书；全文只有空白的 TXT 也会以「1 章正文」入架。被否决：按 `?name=` 的扩展名判（判据挂在最不可信的一侧）；「看起来像二进制就拒」的比例启发式；只在 TXT 链入口查 NUL（不查全空白）。后果：坏字节不再报成功；PDF 仍读不了——本篇做的是不再假装读得进。

锚点：`src/services/localbooks.ts` 的 `namedContainerMagicOf` / `assertReadableDecodedText` / `LocalBooks.import` / `LocalBooks.publishText` / `hasZipMagic`；`tests/services/localbooks.test.ts` 的「本地文件的终点判据」；`tests/api/dispatch-local.test.ts`；`README.md` 的「本地书格式」；矩阵行 `j-local-book`、`j-local-book-epub`、`j-local-book-other-formats`。
