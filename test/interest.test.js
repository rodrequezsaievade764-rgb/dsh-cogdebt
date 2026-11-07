import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REASON_FACTOR,
  REASON_LABEL,
  NAG_THRESHOLD,
  interest,
  ranked,
  pickNags,
  nagText,
  summary,
  summaryText,
} from '../lib/interest.js'

const DAY = 86400000
const NOW = 1_700_000_000_000

function debt(over = {}) {
  return {
    id: 'c0000000a',
    topic: '看那段协程调度',
    reason: 'hard',
    weight: 2,
    status: 'open',
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    paidAt: 0,
    paidHow: '',
    ...over,
  }
}

function dbOf(debts, meta = {}) {
  return { version: 1, debts, meta: { lastScanAt: 0, lastNag: {}, ...meta } }
}

test('系数表与文案表覆盖同样的五类', () => {
  assert.deepEqual(Object.keys(REASON_FACTOR).sort(), Object.keys(REASON_LABEL).sort())
  assert.equal(REASON_FACTOR.avoid, 2.0)
  assert.equal(REASON_FACTOR.hard, 1.6)
  assert.equal(REASON_FACTOR.interrupted, 1.0)
  assert.equal(REASON_FACTOR.time, 0.7)
  assert.equal(REASON_FACTOR.later, 0.5)
})

test('interest：权重 × 天数 × 系数，保留一位小数', () => {
  // 2 × 10 × 1.6 = 32
  assert.equal(interest(debt(), NOW), 32)
  // 3 × 10 × 2.0 = 60
  assert.equal(interest(debt({ reason: 'avoid', weight: 3 }), NOW), 60)
  // 1 × 10 × 0.5 = 5
  assert.equal(interest(debt({ reason: 'later', weight: 1 }), NOW), 5)
})

test('interest：未知 reason 按 0.5 兜底', () => {
  assert.equal(interest(debt({ reason: 'zzz', weight: 2 }), NOW), 10)
})

test('interest：缺 createdAt 返回 0', () => {
  assert.equal(interest(debt({ createdAt: 0 }), NOW), 0)
  assert.equal(interest({}, NOW), 0)
})

test('interest：已结清的用 paidAt 冻结，不再涨', () => {
  const paid = debt({ status: 'paid', paidAt: NOW - 5 * DAY })
  assert.equal(interest(paid, NOW), 16) // 2 × 5 × 1.6
  // 时间继续走，利息不变
  assert.equal(interest(paid, NOW + 100 * DAY), 16)
})

test('interest：paidAt 缺失时退到 updatedAt；全为 0 则算 0 天', () => {
  assert.equal(interest(debt({ status: 'dropped', paidAt: 0, updatedAt: NOW - 5 * DAY }), NOW), 16)
  // paidAt / updatedAt 都是 0，退到 createdAt，等于当天结清 → 0 天
  assert.equal(interest(debt({ status: 'dropped', paidAt: 0, updatedAt: 0 }), NOW), 0)
})

test('interest：四舍五入到一位小数', () => {
  // 2 × 1 天 × 1.6 = 3.2
  assert.equal(interest(debt({ createdAt: NOW - DAY }), NOW), 3.2)
  // 2 × 0.5 天 × 1.6 = 1.6
  assert.equal(interest(debt({ createdAt: NOW - DAY / 2 }), NOW), 1.6)
})

test('ranked：只留 open，按利息降序', () => {
  const db = dbOf([
    debt({ id: 'low', topic: '轻', reason: 'later', weight: 1, createdAt: NOW - DAY }),
    debt({ id: 'high', topic: '重', reason: 'avoid', weight: 3, createdAt: NOW - 20 * DAY }),
    debt({ id: 'done', status: 'paid', paidAt: NOW - DAY }),
    debt({ id: 'mid', topic: '中', reason: 'hard', weight: 2, createdAt: NOW - 5 * DAY }),
  ])
  const rows = ranked(db, NOW)
  assert.deepEqual(rows.map((r) => r.debt.id), ['high', 'mid', 'low'])
  assert.ok(rows[0].score > rows[1].score)
})

test('ranked：空库返回空数组', () => {
  assert.deepEqual(ranked(dbOf([]), NOW), [])
})

test('NAG_THRESHOLD 是 3', () => {
  assert.equal(NAG_THRESHOLD, 3)
})

test('pickNags：低于门槛不催，刚记下的东西不算债', () => {
  const db = dbOf([debt({ createdAt: NOW - 1000 })])
  assert.deepEqual(pickNags(db, NOW, { nagCooldownHours: 48, maxPerScan: 2 }), [])
  assert.deepEqual(db.meta.lastNag, {})
})

test('pickNags：达标就催，并写回 lastNag', () => {
  const db = dbOf([debt({ id: 'c1' })]) // 32
  const nags = pickNags(db, NOW, { nagCooldownHours: 48, maxPerScan: 2 })
  assert.equal(nags.length, 1)
  assert.equal(nags[0].debt.id, 'c1')
  assert.equal(nags[0].score, 32)
  assert.equal(db.meta.lastNag.c1, NOW)
})

test('pickNags：冷却期内不重复催', () => {
  const db = dbOf([debt({ id: 'c1' })], { lastNag: { c1: NOW - 3600000 } })
  assert.deepEqual(pickNags(db, NOW, { nagCooldownHours: 48, maxPerScan: 2 }), [])
})

test('pickNags：过了冷却期再催', () => {
  const db = dbOf([debt({ id: 'c1' })], { lastNag: { c1: NOW - 49 * 3600000 } })
  assert.equal(pickNags(db, NOW, { nagCooldownHours: 48, maxPerScan: 2 }).length, 1)
})

test('pickNags：遵守 maxPerScan，按利息优先', () => {
  const db = dbOf([
    debt({ id: 'a', reason: 'avoid', weight: 3, createdAt: NOW - 30 * DAY }),
    debt({ id: 'b', reason: 'avoid', weight: 3, createdAt: NOW - 20 * DAY }),
    debt({ id: 'c', reason: 'avoid', weight: 3, createdAt: NOW - 10 * DAY }),
  ])
  const nags = pickNags(db, NOW, { nagCooldownHours: 48, maxPerScan: 2 })
  assert.deepEqual(nags.map((n) => n.debt.id), ['a', 'b'])
  assert.equal(db.meta.lastNag.a, NOW)
  assert.equal(db.meta.lastNag.b, NOW)
  assert.equal(db.meta.lastNag.c, undefined)
})

test('pickNags：配置缺失时用默认值（48h / 2 笔）', () => {
  const db = dbOf([
    debt({ id: 'a', createdAt: NOW - 20 * DAY }),
    debt({ id: 'b', createdAt: NOW - 20 * DAY }),
    debt({ id: 'c', createdAt: NOW - 20 * DAY }),
  ])
  assert.equal(pickNags(db, NOW, {}).length, 2)
})

test('nagText：带天数、原因、利息与一句问话', () => {
  const text = nagText(debt(), 32, NOW)
  assert.match(text, /看那段协程调度/)
  assert.match(text, /拖了 10 天/)
  assert.match(text, /看不懂/)
  assert.match(text, /利息 32/)
})

test('nagText：未知 reason 用默认文案，问话随利息升级但不越界', () => {
  assert.match(nagText(debt({ reason: 'zzz' }), 3, NOW), /说以后再/)
  assert.match(nagText(debt(), 3, NOW), /今天能还一点吗/)
  assert.match(nagText(debt(), 6, NOW), /还是一次性拆掉/)
  assert.match(nagText(debt(), 12, NOW), /要不要干脆划掉/)
  assert.match(nagText(debt(), 1000, NOW), /要不要干脆划掉/)
})

test('summary：空库各项归零', () => {
  const s = summary(dbOf([]), NOW)
  assert.equal(s.openCount, 0)
  assert.equal(s.paidCount, 0)
  assert.equal(s.droppedCount, 0)
  assert.equal(s.totalInterest, 0)
  assert.deepEqual(s.byReason, {})
  assert.equal(s.worstReason, '')
  assert.equal(s.recentPaid, 0)
  assert.equal(s.oldest, null)
})

test('summary：分类计数、总利息、最狠的一类', () => {
  const db = dbOf([
    debt({ id: 'a', reason: 'avoid', weight: 3, createdAt: NOW - 20 * DAY }), // 120
    debt({ id: 'b', reason: 'avoid', weight: 1, createdAt: NOW - 10 * DAY }), // 20
    debt({ id: 'c', reason: 'hard', weight: 2, createdAt: NOW - 2 * DAY }),   // 6.4
    debt({ id: 'd', status: 'paid', paidAt: NOW - DAY }),
    debt({ id: 'e', status: 'dropped', paidAt: NOW - DAY }),
  ])
  const s = summary(db, NOW)
  assert.equal(s.openCount, 3)
  assert.equal(s.paidCount, 1)
  assert.equal(s.droppedCount, 1)
  assert.equal(s.totalInterest, 146.4)
  assert.deepEqual(s.byReason, { avoid: 2, hard: 1 })
  assert.equal(s.worstReason, 'avoid')
  assert.equal(s.oldest.id, 'a')
})

test('summary：所有利息为 0 时不报「欠得最狠」', () => {
  const db = dbOf([
    debt({ id: 'a', reason: 'avoid', createdAt: NOW }),
    debt({ id: 'b', reason: 'hard', createdAt: NOW }),
  ])
  const s = summary(db, NOW)
  assert.equal(s.openCount, 2)
  assert.equal(s.totalInterest, 0)
  assert.equal(s.worstReason, '')
  assert.doesNotMatch(summaryText(s), /欠得最狠/)
})

test('summary：只有一类有正利息时认它', () => {
  const db = dbOf([
    debt({ id: 'a', reason: 'avoid', weight: 2, createdAt: NOW - 5 * DAY }), // 20
    debt({ id: 'b', reason: 'hard', weight: 2, createdAt: NOW }),            // 0
  ])
  assert.equal(summary(db, NOW).worstReason, 'avoid')
})

test('summary：recentPaid 只数最近 30 天还的', () => {
  const db = dbOf([
    debt({ id: 'a', status: 'paid', paidAt: NOW - 10 * DAY }),
    debt({ id: 'b', status: 'paid', paidAt: NOW - 29 * DAY }),
    debt({ id: 'c', status: 'paid', paidAt: NOW - 31 * DAY }),
  ])
  assert.equal(summary(db, NOW).recentPaid, 2)
})

test('summaryText：空账本说干净', () => {
  assert.equal(summaryText(summary(dbOf([]), NOW), NOW), '账上干净，没欠什么东西')
})

test('summaryText：全还清了说还清，也报划掉与最近还的量', () => {
  const db = dbOf([
    debt({ id: 'a', status: 'paid', paidAt: NOW - 5 * DAY }),
    debt({ id: 'b', status: 'dropped', paidAt: NOW - 5 * DAY }),
  ])
  const text = summaryText(summary(db, NOW), NOW)
  assert.match(text, /手上的都还清了/)
  assert.match(text, /这 30 天还了 1 件/)
  assert.match(text, /划掉 1 件/)
})

test('summaryText：有欠的时候报件数、利息、最狠的一类与最久那笔', () => {
  const db = dbOf([debt({ id: 'a', reason: 'avoid', weight: 3, createdAt: NOW - 20 * DAY })])
  const text = summaryText(summary(db, NOW), NOW)
  assert.match(text, /还欠 1 件，利息合计 120/)
  assert.match(text, /欠得最狠的是「不想碰」这一类/)
  assert.match(text, /最久的那件拖了 20 天：看那段协程调度/)
})

test('summaryText：不给 now 也不会算错成长尾天数（默认取当前时钟）', () => {
  const fresh = debt({ id: 'a', createdAt: Date.now() })
  const text = summaryText(summary(dbOf([fresh]), Date.now()))
  assert.match(text, /拖了 0 天/)
})
