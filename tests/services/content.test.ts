import { describe, expect, it } from 'vitest'
import { contentToText, htmlToText, looksLikeHtml } from '../../src/services/content.js'

describe('looksLikeHtml（白名单标签判定——纯文本正文不许误伤）', () => {
  it('真 HTML 标签 → 是（含闭合/自闭合/属性/大小写）', () => {
    for (const s of ['<p>正文</p>', '<div id="c">x</div>', 'a<br>b', '<BR/>', '<P CLASS=x>y</P>', '<h1>t</h1>', '<span>x</span>']) {
      expect(looksLikeHtml(s), s).toBe(true)
    }
  })
  it('纯文本（含尖括号内容）→ 否', () => {
    for (const s of ['夜sè将尽，月淡星稀。', '<系统提示> 恭喜宿主', '1 < 2 且 3 > 2', '《书名》', '<未闭合', 'a <b 不是标签>']) {
      expect(looksLikeHtml(s), s).toBe(false)
    }
  })
})

describe('htmlToText（HTML 片段 → 纯文本）', () => {
  it('块级元素边界换行（久久小说网 @html 实测形态：一串 <p>）', () => {
    expect(htmlToText('<p>第一段</p><p>第二段</p><p>第三段</p>')).toBe('第一段\n第二段\n第三段')
  })
  it('br 换行、嵌套块展开、空块不留空行', () => {
    expect(htmlToText('<div><p>a</p><p>b<br>c</p></div>')).toBe('a\nb\nc')
    expect(htmlToText('<p></p><p>   </p><p>x</p>')).toBe('x')
  })
  it('行内标签只留文本（含 img 这类无文本空元素）', () => {
    expect(htmlToText('<p>他说<strong>好</strong>，<em>真的</em>。</p>')).toBe('他说好，真的。')
    expect(htmlToText('<p>前<img src="a.png">后</p>')).toBe('前后')
  })
  it('实体解码：&nbsp;/&amp;/&#39; 与全角缩进 　 都不带进正文', () => {
    expect(htmlToText('<p>&nbsp;&nbsp;引号&nbsp;</p>')).toBe('引号')
    expect(htmlToText('<p>A&amp;B &#39;引&#39;</p>')).toBe("A&B '引'")
    expect(htmlToText('<p>　　夜sè将尽，月淡星稀。</p>')).toBe('夜sè将尽，月淡星稀。')   // 段落缩进由阅读器 text-indent 负责
  })
  it('脚本/样式/表单控件整棵子树丢弃（正文里混进的模板代码不许泄漏）', () => {
    expect(htmlToText('<p>正文</p><script>var a=1</script><style>.x{color:red}</style><button>按钮</button>')).toBe('正文')
  })
  it('空白折叠：段内换行/多空格归一，段间不粘连', () => {
    expect(htmlToText('<p>天微\n微亮，   一道苍老的身影</p>')).toBe('天微 微亮， 一道苍老的身影')
  })
  it('空/无文本输入 → 空串', () => {
    expect(htmlToText('')).toBe('')
    expect(htmlToText('<script>x</script>')).toBe('')
    expect(htmlToText('   ')).toBe('')
  })
})

describe('contentToText（正文取值收口）', () => {
  it('纯文本原样返回（一个字符都不动）', () => {
    const plain = '夜sè将尽，月淡星稀。\n\n他没死，被玉锁所救。'
    expect(contentToText(plain)).toBe(plain)
  })
  it('HTML 片段转纯文本', () => {
    expect(contentToText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n第二段')
  })
  it('幂等：转换结果再过一次收口不变（旧缓存里的带标签正文就地自愈）', () => {
    const once = contentToText('<p>一</p><p>二</p>')
    expect(contentToText(once)).toBe(once)
  })
  // 预转义 HTML 是 JSON API 源正文串的形态，实体解码本就是这层的职责；解出来含标签即违反
  // 「产物不含标签」契约——reading.getChapter 对缓存还要再收一次口，第二趟会把段落当标签吞掉。
  it('幂等：预转义 HTML 串一趟收口成纯文本（产物不含标签）', () => {
    const escaped = '&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二段&lt;/p&gt;'
    const once = contentToText(escaped)
    expect(once).toBe('第一段\n第二段')
    expect(contentToText(once)).toBe(once)
  })
  it('img 保留为地址行（漫画/图片章节不再整章零命中）', () => {
    const html = '<img src="https://cdn.x.com/1.jpg">\n<img data-src="/rel/2.png">'
    expect(contentToText(html)).toBe('https://cdn.x.com/1.jpg\n/rel/2.png')
  })
  it('藏在 noscript 里的 img 也取回地址，不许把字面标签当正文吐出来', () => {
    // domhandler 把 noscript 内容按 raw text 解析（noscript.children 只有一个 text 节点，
    // find('img') 为 0）——「透明下钻」必须把那段文本再当 HTML 解析一次，否则读者看到的是
    // `<img src="/a.jpg">` 这串标记本身（审查实测）。
    expect(contentToText('<p>前<noscript><img src="/a.jpg"></noscript>后</p>')).toBe('前\n/a.jpg\n后')
    expect(contentToText('<div class="gic"><noscript><img data-original="/b.jpg" /></noscript></div>'))
      .toBe('/b.jpg')
  })
  it('纯文本含预转义实体 → 就地解码（JSON API 源正文串形态）', () => {
    expect(contentToText('&nbsp;&nbsp;引号&#8220;甲&#8221;&amp;乙')).toBe('\u00a0\u00a0引号“甲”&乙')
  })
  it('未知实体原样保留（不猜）', () => {
    expect(contentToText('甲&unknownentity;乙')).toBe('甲&unknownentity;乙')
  })
  it('无实体时零改动（幂等）', () => {
    const plain = '夜sè将尽，月淡星稀。'
    expect(contentToText(plain)).toBe(plain)
    expect(contentToText(contentToText('&nbsp;甲'))).toBe('\u00a0甲')
  })
})
