// 利息计算。这是整个插件的核心，就一段。
//
// 想法很简单：一件事你跳过了，它不会原地等着。
// 它会开始长利息 —— 拖得越久、越不想碰，欠得越多。
//
// 利息 = 权重 × 天数 × 逃避系数
//
// 权重是你自己标的重要度（1-3）。
// 天数从创建那天算起，还了就不再涨。
// 逃避系数看「当初为什么跳过」——
//   逃避 = 2.0（越不想看的事利滚利最快）
//   难   = 1.6（认知上够不着，越放越远）
//   被打断 = 1.0（纯粹是打断了，利不算高）
//   没时间 = 0.7（忙不是债，但也是债）
//   以后  = 0.5（最轻，多数会自己消失）
//
// 不搞复利、不搞指数，因为那些数字好看但没法解释。
// 线性够用：你拖两周，利息翻倍，这就足以让你想动它。

import { daysSince } from './store.js'

export const REASON_FACTOR = {
  avoid: 2.0,
  hard: 1.6,
  interrupted: 1.0,
  time: 0.7,
  later: 0.5,
}

export const REASON_LABEL = {
  avoid: '不想碰',
  hard: '看不懂',
  interrupted: '被打断',
  time: '没时间',
  later: '说以后再',
}

/** 一条债现在欠多少。还了就冻结，不再涨。 */
export function interest(debt, now = Date.now()) {
  const end = debt.status === 'paid' || debt.status === 'dropped'
    ? Number(debt.paidAt || debt.updatedAt || debt.createdAt || 0)
    : now
  const start = Number(debt.createdAt || 0)
  if (!start) return 0
  const days = Math.max(0, (end - start) / 86400000)
  const w = Number(debt.weight) || 2
  const f = REASON_FACTOR[debt.reason] || 0.5
  return Math.round(w * days * f * 10) / 10
}

/** 全库按利息排序，只留还没还的。 */
export function ranked(db, now = Date.now()) {
  return db.debts
    .filter((d) => d.status === 'open')
    .map((d) => ({ debt: d, score: interest(d, now) }))
    .sort((a, b) => b.score - a.score)
}

/** 利息到多少才值得催。低于这个数甭提，刚记下的东西不算债。 */
export const NAG_THRESHOLD = 3

/** 挑这一轮该催的，并写回 lastNag 避免天天骚扰。 */
export function pickNags(db, now, config) {
  const cooldownMs = Math.max(1, Number(config.nagCooldownHours) || 48) * 3600000
  const maxPerScan = Math.max(1, Number(config.maxPerScan) || 2)
  return ranked(db, now)
    .filter((x) => x.score >= NAG_THRESHOLD)
    .filter((x) => now - Number(db.meta.lastNag[x.debt.id] || 0) >= cooldownMs)
    .slice(0, maxPerScan)
    .map((x) => {
      db.meta.lastNag[x.debt.id] = now
      return { debt: x.debt, score: x.score }
    })
}

/** 一条债的催办文案。不说教，只报利息。 */
export function nagText(debt, score, now) {
  const days = Math.round(daysSince(debt.createdAt, now))
  const why = REASON_LABEL[debt.reason] || '说以后再'
  const asks = [
    '今天能还一点吗',
    '还是一次性拆掉',
    '要不要干脆划掉',
  ]
  // 按天数和权重挑一句，别每次一样
  const ask = asks[Math.min(asks.length - 1, Math.floor(score / 6))]
  return `${debt.topic}（拖了 ${days} 天，当初是${why}）· 利息 ${score} · ${ask}`
}

/** 全库汇总。 */
export function summary(db, now = Date.now()) {
  const open = db.debts.filter((d) => d.status === 'open')
  const paid = db.debts.filter((d) => d.status === 'paid')
  const dropped = db.debts.filter((d) => d.status === 'dropped')

  const total = open.reduce((s, d) => s + interest(d, now), 0)
  const byReason = {}
  for (const d of open) {
    byReason[d.reason] = (byReason[d.reason] || 0) + 1
  }
  // 哪一类欠得最狠
  let worstReason = ''
  let worstSum = -1
  for (const [k, _] of Object.entries(byReason)) {
    const s = open.filter((d) => d.reason === k).reduce((a, d) => a + interest(d, now), 0)
    if (s > worstSum) { worstSum = s; worstReason = k }
  }

  // 还款速度：最近 30 天还了几条
  const since = now - 30 * 86400000
  const recentPaid = paid.filter((d) => Number(d.paidAt || 0) >= since).length

  return {
    openCount: open.length,
    paidCount: paid.length,
    droppedCount: dropped.length,
    totalInterest: Math.round(total * 10) / 10,
    byReason,
    worstReason,
    recentPaid,
    oldest: open.length
      ? open.reduce((a, b) => (Number(a.createdAt) < Number(b.createdAt) ? a : b))
      : null,
  }
}

/** 汇总翻译成人话。 */
export function summaryText(s) {
  if (!s.openCount && !s.paidCount) return '账上干净，没欠什么东西'
  const bits = []
  if (s.openCount) {
    bits.push(`还欠 ${s.openCount} 件，利息合计 ${s.totalInterest}`)
    if (s.worstReason) bits.push(`欠得最狠的是「${REASON_LABEL[s.worstReason] || s.worstReason}」这一类`)
    if (s.oldest) {
      const days = Math.round(daysSince(s.oldest.createdAt))
      bits.push(`最久的那件拖了 ${days} 天：${s.oldest.topic}`)
    }
  } else {
    bits.push('手上的都还清了')
  }
  if (s.recentPaid) bits.push(`这 30 天还了 ${s.recentPaid} 件`)
  if (s.droppedCount) bits.push(`划掉 ${s.droppedCount} 件`)
  return bits.join('。')
}
