// dsh-cogdebt — 认知债务追踪
//
// 定位：这东西记的不是「要做的事」，是「你跳过去的事」。
//
// 待办清单管的是承诺：我答应了，要去做。
// 认知债务管的是逃避：这段我没看懂，先往下翻；这个报错我没查，先注释掉；
// 这篇文章我扫了两眼觉得费劲，收藏了。它们不会因为你没记就消失。
//
// 所以这里没有「完成」，只有「还清」和「划掉」。
// 还清 = 你回去弄懂了。划掉 = 你想通了，不值得懂。
// 两个都算结清，但含义完全不同 —— 统计的时候分开算。

import { createStore, newId, normReason, clampWeight, daysSince, normTags, hasTag, REASON_KEYS } from './store.js'
import { defineTool, str, int } from './tool.js'
import { interest, ranked, pickNags, nagText, summary, summaryText, REASON_LABEL } from './interest.js'

export const name = 'cogdebt'
export const inject = ['tools']

// 扫描间隔的下限（分钟）。只在这里定义一次：
// 早先 cfg 里夹一次、effect 里又拿毫秒常量夹一次，两个魔法数要同步改，改漏就漂。
const MIN_SCAN_MINUTES = 10

// 数字参数解析：没给 / 给了废话 → 用默认值；给了 0 → 按最小值夹。
// 直接写 `Number(v) || dflt` 会把显式的 0 吞成默认值，那是另一种静默降级。
function pickInt(v, dflt, min, max) {
  const n = Number(v)
  const base = v === undefined || v === null || v === '' || !Number.isFinite(n) ? dflt : n
  return Math.max(min, Math.min(max, Math.round(base)))
}

export function apply(ctx, config = {}) {
  const cfg = {
    storePath: String(config.storePath || ''),
    scanIntervalMinutes: Math.max(MIN_SCAN_MINUTES, Number(config.scanIntervalMinutes) || 60),
    notifyService: String(config.notifyService || ''),
    notifyTo: String(config.notifyTo || ''),
    webhookUrl: String(config.webhookUrl || ''),
    quietHours: Array.isArray(config.quietHours) ? config.quietHours : [23, 8],
    nagCooldownHours: Number(config.nagCooldownHours) || 48,
    maxPerScan: Number(config.maxPerScan) || 2,
  }
  const store = createStore(cfg.storePath)

  let logger
  try { logger = ctx.logger('cogdebt') } catch { logger = null }
  const info = (m) => { try { logger ? logger.info(m) : console.log('[cogdebt] ' + m) } catch {} }
  const warn = (m) => { try { logger ? logger.warn(m) : console.warn('[cogdebt] ' + m) } catch {} }

  // ---------- 推送 ----------
  async function push(text) {
    if (!String(text || '').trim()) return false
    if (cfg.notifyService) {
      try {
        const svc = ctx.get(cfg.notifyService)
        if (svc && typeof svc.send === 'function') {
          const r = await svc.send({ target: cfg.notifyTo || undefined, text })
          if (r && r.ok) return true
          warn(`${cfg.notifyService} 没发出去：${(r && r.message) || '未知原因'}`)
        }
      } catch (e) {
        warn('推送异常：' + ((e && e.message) || e))
      }
    }
    if (cfg.webhookUrl) {
      try {
        const r = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, msgtype: 'text', content: { text } }),
          signal: AbortSignal.timeout(10000),
        })
        if (r.ok) return true
        warn(`推送失败：HTTP ${r.status}`)
      } catch (e) {
        warn('推送异常：' + ((e && e.message) || e))
      }
    }
    info('（未发出，仅记录）' + text.replace(/\n/g, ' / '))
    return false
  }

  // ---------- 扫描 ----------
  let scanning = false
  async function scanOnce(now = Date.now()) {
    if (scanning) return
    scanning = true
    try {
      const h = new Date(now).getHours()
      const [from, to] = cfg.quietHours
      const quiet = Number.isFinite(from) && Number.isFinite(to) && from !== to
        ? (from > to ? (h >= from || h < to) : (h >= from && h < to))
        : false
      if (quiet) {
        store.mutate((db) => { db.meta.lastScanAt = now })
        return
      }

      const db = store.read()
      const nags = pickNags(db, now, cfg)
      // pickNags 改了 meta.lastNag，必须写回
      store.write(db)

      if (nags.length) {
        const lines = nags.map((x) => '· ' + nagText(x.debt, x.score, now))
        await push(['有几笔债在长利息——', ...lines].join('\n'))
      }
    } catch (e) {
      warn('扫描失败：' + ((e && e.message) || e))
    } finally {
      scanning = false
    }
  }

  // ---------- 工具 ----------
  const ok = (message, extra) => ({ ok: true, message, ...extra })
  const bad = (message) => ({ ok: false, message })

  const oweTool = defineTool({
    name: 'cogdebt_owe',
    description:
      '记一笔认知债：遇到「没看懂、先跳过、回头再看」的东西时用。' +
      '这不是待办——待办是你答应要做的事，认知债是你绕过去的事。' +
      'topic 写清是什么（那段代码、那篇论文、那个报错）；' +
      'reason 写当初为什么跳过：avoid 不想碰 / hard 看不懂 / interrupted 被打断 / time 没时间 / later 说以后再；' +
      'weight 是痒度 1-3，越难受越大，默认 2。',
    properties: {
      topic: str('是什么东西，一句话'),
      reason: str('当初为什么跳过：avoid / hard / interrupted / time / later，可不填'),
      weight: int('痒度 1-3，越在意越大，默认 2'),
      note: str('备注，可不填'),
      tags: str('标签，逗号分隔，可不填'),
    },
    required: ['topic'],
    execute: async (args) => {
      const topic = String(args.topic || '').trim()
      if (!topic) return bad('得说清欠的是什么')
      if (topic.length > 200) return bad('太长了，压到 200 字以内')

      // reason 是可选枚举：留空 = 没指定，按 later 记账；
      // 写了但认不出来 = 报错，别假装记成「明天再说」。
      const rawReason = String(args.reason == null ? '' : args.reason).trim()
      const parsedReason = normReason(rawReason)
      if (rawReason && !parsedReason) {
        return bad(`reason 只认 ${REASON_KEYS.join(' / ')}，不认「${rawReason}」`)
      }

      const now = Date.now()
      const debt = {
        id: newId(),
        topic,
        note: String(args.note || '').trim().slice(0, 2000),
        tags: normTags(args.tags),
        reason: parsedReason || 'later',
        weight: clampWeight(args.weight),
        status: 'open',
        createdAt: now,
        updatedAt: now,
        paidAt: 0,
        paidHow: '',
      }
      store.mutate((db) => { db.debts.push(debt) })
      const why = REASON_LABEL[debt.reason]
      return ok(`记上了：${topic}（${why}，痒度 ${debt.weight}）`, { debt })
    },
  })

  const payTool = defineTool({
    name: 'cogdebt_pay',
    description:
      '结清一笔债。有两种结法，别混：' +
      'paid = 真弄懂了，回去把它吃透了；dropped = 想通了，不值得懂，主动划掉。' +
      '两个都算结清，但统计分开算——划掉不是丢脸，是止损。' +
      'how 写怎么还的（看完了 / 换成别的方法 / 确认用不上），可不填。',
    properties: {
      topic: str('要结清哪一笔（模糊匹配），或者用 id'),
      id: str('债的 id，可不填'),
      mode: str('paid 还清 / dropped 划掉，默认 paid'),
      how: str('怎么结的，可不填'),
    },
    execute: async (args) => {
      const id = String(args.id || '').trim()
      const kw = String(args.topic || '').trim().toLowerCase()
      if (!id && !kw) return bad('说清是哪一笔')

      const db = store.read()
      let hit
      if (id) {
        hit = db.debts.find((d) => d.id === id)
        if (!hit) return bad(`没有 id 为 ${id} 的债`)
      } else {
        const m = db.debts.filter((d) => d.status === 'open' && String(d.topic).toLowerCase().includes(kw))
        if (!m.length) {
          const any = db.debts.filter((d) => String(d.topic).toLowerCase().includes(kw))
          if (any.length) return bad(`「${args.topic}」已经结过了`)
          return bad(`账上没有含「${args.topic}」的债`)
        }
        if (m.length > 1) {
          const list = m.slice(0, 5).map((d) => `${d.id} ${d.topic}`).join('\n')
          return bad(`匹配到 ${m.length} 笔，说清哪个：\n${list}`)
        }
        hit = m[0]
      }

      if (hit.status !== 'open') {
        const how = hit.status === 'paid' ? '还清了' : '划掉了'
        const when = Number(hit.paidAt) ? new Date(Number(hit.paidAt)).toISOString().slice(0, 10) : '早先'
        return bad(`这笔${when}已经${how}：${hit.topic}。要重新记就再 owe 一次。`)
      }

      const mode = String(args.mode || 'paid').trim()
      if (mode !== 'paid' && mode !== 'dropped') return bad('mode 只认 paid 或 dropped')

      const now = Date.now()
      const frozen = interest(hit, now)
      const days = Math.round(daysSince(hit.createdAt, now))
      store.mutate((d) => {
        const t = d.debts.find((x) => x.id === hit.id)
        t.status = mode
        t.paidAt = now
        t.updatedAt = now
        t.paidHow = String(args.how || '').slice(0, 500)
      })

      const verb = mode === 'paid' ? '还清了' : '划掉了'
      return ok(`${verb}：${hit.topic}，拖了 ${days} 天，结了 ${frozen} 的利息`)
    },
  })

  const listTool = defineTool({
    name: 'cogdebt_list',
    description:
      '看账本。默认按利息从高到低列还欠着的，最多 limit 笔（默认 8）。' +
      '利息 = 痒度 × 拖了几天 × 逃避系数，拖越久越不想碰的排越前。' +
      '看全部（含已还已划）把 all 设 true，此时按记录时间倒序，最多 allLimit 笔（默认 50）。' +
      'tag 只看带这个标签的，reason 只看某一类原因。',
    properties: {
      all: { type: 'boolean', description: 'true 连已结清的一起看' },
      reason: str('只看某一类：avoid / hard / interrupted / time / later'),
      tag: str('只看带这个标签的债，可不填'),
      limit: int('最多列几笔，默认 8'),
      allLimit: int('all 为 true 时最多列几笔，默认 50'),
    },
    execute: async (args) => {
      const now = Date.now()
      const db = store.read()
      const lim = pickInt(args.limit, 8, 1, 50)
      const allLim = pickInt(args.allLimit, 50, 1, 500)
      const tagRaw = String(args.tag == null ? '' : args.tag).trim()

      // 标签筛选对「全部」和「还欠着」两个档位都要生效，
      // 否则 all=true 时传了 tag 却被无声忽略 —— 又是静默降级。
      // 提示写在末尾而不是开头：正文首行必须是第一条记录，别让人以为账本是空的。
      const withTag = (list) => (tagRaw ? list.filter((d) => hasTag(d, tagRaw)) : list)
      const tagNote = tagRaw ? `\n（以上只列了带「${tagRaw}」标签的）` : ''

      if (args.all) {
        const pool = withTag(db.debts)
        if (!db.debts.length) return ok('账本还是空的')
        if (!pool.length) return ok(`账上没有带「${tagRaw}」标签的债`)
        const mark = { open: '欠', paid: '还', dropped: '划' }
        const lines = pool
          .slice()
          .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
          .slice(0, allLim)
          .map((d) => `[${mark[d.status]}] ${d.topic}（${Math.round(daysSince(d.createdAt, now))} 天）`)
        const more = pool.length > allLim ? `\n还有 ${pool.length - allLim} 笔没列` : ''
        return ok(lines.join('\n') + more + tagNote, {
          count: pool.length,
          shown: Math.min(lines.length, allLim),
        })
      }

      let rows = ranked(db, now)
      const rawReason = String(args.reason == null ? '' : args.reason).trim()
      if (rawReason) {
        const r = normReason(rawReason)
        if (!r) return bad(`reason 只认 ${REASON_KEYS.join(' / ')}，不认「${rawReason}」`)
        rows = rows.filter((x) => x.debt.reason === r)
      }
      if (tagRaw) rows = rows.filter((x) => hasTag(x.debt, tagRaw))
      if (!rows.length) return ok(tagRaw ? `没有带「${tagRaw}」标签的债` : '没欠什么了，账本干净')

      const lines = rows.slice(0, lim).map((x) => {
        const days = Math.round(daysSince(x.debt.createdAt, now))
        const why = REASON_LABEL[x.debt.reason] || ''
        const tags = Array.isArray(x.debt.tags) && x.debt.tags.length ? ' · #' + x.debt.tags.join(' #') : ''
        return `${x.debt.topic}（${days} 天 · ${why} · 利息 ${x.score}${tags}）`
      })
      const more = rows.length > lim ? `\n还有 ${rows.length - lim} 笔` : ''
      // 只列一笔时把备注也带上：note 早先是只写不读的死字段，
      // 记的时候费劲写了，看的时候永远不出现，等于白记。
      const only = rows.length === 1 ? rows[0].debt : null
      const noteLine = only && only.note ? `\n备注：${only.note}` : ''
      return ok(lines.join('\n') + more + noteLine, { count: rows.length })
    },
  })

  const statTool = defineTool({
    name: 'cogdebt_stat',
    description:
      '看账本整体欠了多少：总利息、哪一类欠得最狠、最久的那笔拖了多久、最近还了几笔。' +
      '用户问「我欠了多少东西」「最近在逃避什么」时用。',
    properties: {},
    execute: async () => {
      const db = store.read()
      const now = Date.now()
      const s = summary(db, now)
      return ok(summaryText(s, now), { stats: s })
    },
  })

  const tools = [oweTool, payTool, listTool, statTool]
  const offs = []
  for (const t of tools) {
    try { offs.push(ctx.tools.register(t)) } catch (e) {
      warn(`工具 ${t.name} 挂不上：` + ((e && e.message) || e))
    }
  }
  info(`已注册 ${tools.length} 个工具：${tools.map((t) => t.name).join('、')}`)

  ctx.effect(() => {
    const intervalMs = cfg.scanIntervalMinutes * 60000
    const first = setTimeout(() => void scanOnce(), 60000)
    const timer = setInterval(() => void scanOnce(), intervalMs)
    info(`利息开始计息：每 ${Math.round(intervalMs / 60000)} 分钟看一次账`)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
      for (const off of offs) { try { off() } catch {} }
    }
  })

  return { scan: () => scanOnce(), store, path: store.path }
}
