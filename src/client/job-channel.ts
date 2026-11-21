/**
 * 浏览器半「盯住服务端一条后台任务」的通道仪式：三处观察者（搜索轮次 / 分类轮次 / 任务状态
 * 镜像）共用的那一段——timer、SSE 优先 + 快照轮询兜底、任一时刻只一条通道、撤通道与代际。
 *
 * 这里**不**统一：快照形状、游标与累积器、身份判据、恢复策略、错误文案全归调用方。三份观察者
 * 逐行同形的是**仪式**，不是收手（搜索面换轮重读基线、发现面整帧替换、状态镜像无身份），
 * 把策略收成回调、骨架只留一处，正是本模块的裁决。收益：两条不变量只有一份实现与一份测试。
 *
 * 三条口径：**快照轮询是地基、SSE 是加速器**（官方不 replay，`ADR-0018`）；任一时刻只有一条
 * 通道推进读面；**撤通道要连 timer 一起**——代际让在途那一发认出自己没有所有权，连读失败都
 * 不许报。与 `store.ts` 的分工：它管跨卸载现场，本模块管挂载期仪式。本模块不认识 React。
 */

/** 一帧快照的读面值：`null` = 服务端说这一轮不存在（与「读失败」不是一件事）。 */
export type JobFrame<Job> = Job | null

/** 推送读面：订阅本轮的通知流（帧体形状归 wire；连接结束 / 断线 / abort 即 settle）。 */
export type JobSubscribe<Round> =
  (round: Round, onFrame: (data: string) => void, signal: AbortSignal) => Promise<void>

/** 调用方要交的几件事：通道只碰这些，业务状态与文案都不进通道。 */
export interface JobChannelSpec<Job, Round> {
  /** 快照读面（地基）：读一帧。URL 与游标归调用方——通道只管什么时候读、读完怎么收。 */
  read: (round: Round) => Promise<JobFrame<Job>>
  /** 推送读面（加速器）。缺省 = 这个调用点没有推送可用（纯轮询，例如任务状态镜像）。 */
  subscribe?: JobSubscribe<Round>
  /** 应用一帧：整轮状态怎么写归调用方；返回「这一轮还在跑吗」。false = 收手（终态，通道全撤）。 */
  apply: (round: Round, job: JobFrame<Job>) => boolean
  /** 身份判据：这一帧说的还是手里这一轮吗。恒 true = 无条件整帧替换（发现面）；按轮次 id 比 =
   *  有累积器的观察者；任务状态镜像没有这一维。 */
  sameRound: (round: Round, job: Job) => boolean
  /** 身份不符时的恢复策略（缺省 = 收手）：交回新的轮次 token，通道从它重开；`null` = 收手。 */
  regain?: (round: Round) => Promise<Round | null>
  /** 读面失败（推送断线不报，那是回落）：返回「还继续看吗」。true = 抖动继续，false = 收手。 */
  onReadError: (round: Round, error: unknown) => boolean
}

export interface JobChannel<Round> {
  /** 盯住这一轮（可换轮）：先撤旧通道（timer 与流一起），再按有没有订阅开流或立刻读一拍。 */
  start: (round: Round) => void
  /** 收手：撤通道并代际作废在途那一发；此后调用方的回调不再被触达。 */
  stop: () => void
}

/** 事件流帧体 → 快照：两条流的帧都是 `{ job }` 信封。`undefined` = 坏帧（跳过）；`null` = 服务端说没有这一轮。 */
function frameOf<Job>(data: string): JobFrame<Job> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || !('job' in parsed)) return undefined
  const job = (parsed as { job?: JobFrame<Job> }).job
  return job ?? null
}

export function createJobChannel<Job, Round>(
  spec: JobChannelSpec<Job, Round>,
  pollMs: number,
): JobChannel<Round> {
  /** 通道代际：每撤一次加一。在途那一发撤不回，迟到帧与迟到回包靠它认出自己已没有所有权。 */
  let gen = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stream: AbortController | null = null
  let current: { round: Round } | null = null

  function arm(delay: number): void {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void poll() }, delay)
  }

  /** 撤一条通道：timer 与流一起撤，代际加一让在途那一发认领不了结果。 */
  function drop(): void {
    gen += 1
    if (timer !== null) { clearTimeout(timer); timer = null }
    stream?.abort()
    stream = null
  }

  async function poll(): Promise<void> {
    const cur = current
    if (cur === null) return
    const round = cur.round
    const g = gen
    let job: JobFrame<Job>
    try {
      job = await spec.read(round)
    } catch (e) {
      if (gen !== g) return                         // 代际已换：这一发属于一条已被撤掉的通道
      if (spec.onReadError(round, e)) arm(pollMs)
      return
    }
    if (gen !== g) return
    if (job !== null && !spec.sameRound(round, job)) { await recover(round); return }
    if (spec.apply(round, job)) arm(pollMs)
  }

  /** 身份不符：先撤通道（旧连接属旧轮），再问调用方的恢复策略；代际已变则以那一次为准。 */
  async function recover(round: Round): Promise<void> {
    drop()
    const g = gen
    const regain = spec.regain
    const next = regain === undefined ? null : await regain(round)
    if (gen !== g) return
    if (next !== null) start(next)
  }

  /** 盯住这一轮：先开 SSE；断开 / 连不上 / 提前结束而本轮未终态 → 回落轮询。 */
  function watch(round: Round, subscribe: JobSubscribe<Round>): void {
    const g = gen
    const ctrl = new AbortController()
    stream = ctrl
    void (async (): Promise<void> => {
      let running = true
      /** 这一轮的结局由帧回调写回：编译器看不见闭包里的赋值，故经函数读，别让它当成常量 */
      const stillRunning = (): boolean => running
      try {
        await subscribe(round, (data): void => {
          if (gen !== g || !running) return           // 已收手或已被撤掉的通道：迟到帧一律丢
          const job = frameOf<Job>(data)
          if (job === undefined) return               // 坏帧不致命：下一帧或轮询兜底
          if (job !== null && !spec.sameRound(round, job)) { void recover(round); return }
          running = spec.apply(round, job)
          if (!running) ctrl.abort()                  // 终态：自己关流，不留着占连接
        }, ctrl.signal)
      } catch { /* 连不上或断线：一律走下面的回落，不单独报错（轮询失败才会真的报错） */ }
      if (gen !== g) return
      if (stillRunning()) arm(pollMs)
    })()
  }

  function start(round: Round): void {
    drop()
    current = { round }
    const subscribe = spec.subscribe
    if (subscribe === undefined) { void poll(); return }   // 没有推送可用：纯轮询，立刻读一拍
    watch(round, subscribe)
  }

  function stop(): void {
    drop()
    current = null
  }

  return { start, stop }
}
