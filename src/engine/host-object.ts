/** 宿主对象描述符：跨 JSON 桥只传数据，方法壳由沙箱 BOOTSTRAP 的 materialize 统一包装。
 *  判别字段 `__host` 是唯一契约；BOOTSTRAP 是模板字符串，契约要两边同步改。
 *  这里只定宿主→沙箱的 response；`__host:'map'` 是 BOOTSTRAP 内部物化形状（不跨宿主边界），
 *  URL 连接也不是描述符——它由 `ctx.fetchConn` 的结果在沙箱里组装。 */
export interface ResponseHost {
  __host: 'response'
  url: string
  statusCode: number
  statusMessage?: string
  headers: Record<string, string>
  cookies: Record<string, string>
  body: string
  contentType?: string
  charset?: string
}

export function responseOf(input: Omit<ResponseHost, '__host'>): ResponseHost {
  return { __host: 'response', ...input }
}
