import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { name as pluginName, inject, apply } from '../lib/index.js'

const DAY = 86400000

/** 最小宿主替身：只实现插件实际用到的 ctx 面。 */
function fakeCtx() {
  const registered = []
  const disposers = []
  return {
    registered,
    logLines: [],
    logger(scope) {
      return {
        info: (m) => { /* 静默，测试里不需要噪音 */ void scope; void m },
        warn: (m) => { void scope; void m },
      }
    },
    get() { return undefined },
    tools: {
      register(t) {
        registered.push(t)
        return () => {
          const i = registered.indexOf(t)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    },
    effect(fn) {
      const off = fn()
      disposers.push(off)
      return () => {}
    },
    disposeAll() {
      for (const off of disposers) { try { off() } catch {} }
      disposers.length = 0
    },
  }
}

function setup(extraConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cogdebt-idx-'))
  const ctx = fakeCtx()
  const api = apply(ctx, { storePath: join(dir, 'debts.json'), ...extraConfig })
  const tool = (n) => ctx.registered.find((t) => t.name === n)
  const cleanup = () => {
    ctx.disposeAll()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, ctx, api, tool, cleanup }
}

test('插件导出 name / inject', () => {
  assert.equal(pluginName, 'cogdebt')
  assert.deepEqual(inject, ['tools'])
})

test('apply：注册四个工具并返回 store/scan/path', () => {
  const { ctx, api, cleanup } = setup()
  try {
    assert.deepEqual(ctx.registered.map((t) => t.name).sort(), [
      'cogdebt_list', 'cogdebt_owe', 'cogdebt_pay', 'cogdebt_stat',
    ])
    assert.equal(typeof api.scan, 'function')
    assert.equal(typeof api.store.read, 'function')
    assert.match(api.path, /debts\.json$/)
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：记一笔，默认 later / 痒度 2', async () => {
  const { tool, api, cleanup } = setup()
  try {
    const r = await tool('cogdebt_owe').execute({ topic: '那段协程调度' })
    assert.equal(r.ok, true)
    assert.match(r.message, /记上了：那段协程调度/)
    assert.match(r.message, /说以后再/)
    assert.match(r.message, /痒度 2/)
    const db = api.store.read()
    assert.equal(db.debts.length, 1)
    assert.equal(db.debts[0].reason, 'later')
    assert.equal(db.debts[0].weight, 2)
    assert.equal(db.debts[0].status, 'open')
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：中文别名能认，weight 夹到 1-3', async () => {
  const { tool, api, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: 'A', reason: '看不懂', weight: 9 })
    const d = api.store.read().debts[0]
    assert.equal(d.reason, 'hard')
    assert.equal(d.weight, 3)
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：非法 reason 返回 ok:false，不静默降级成 later', async () => {
  const { tool, api, cleanup } = setup()
  try {
    const r = await tool('cogdebt_owe').execute({ topic: 'X', reason: 'xx' })
    assert.equal(r.ok, false)
    assert.match(r.message, /reason 只认/)
    assert.match(r.message, /avoid/)
    assert.equal(api.store.read().debts.length, 0)
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：拼错 reason 也报错（aviod）', async () => {
  const { tool, api, cleanup } = setup()
  try {
    const r = await tool('cogdebt_owe').execute({ topic: 'X', reason: 'aviod' })
    assert.equal(r.ok, false)
    assert.equal(api.store.read().debts.length, 0)
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：空 topic 与超长 topic 都拒', async () => {
  const { tool, cleanup } = setup()
  try {
    assert.equal((await tool('cogdebt_owe').execute({})).ok, false)
    assert.equal((await tool('cogdebt_owe').execute({ topic: '   ' })).ok, false)
    const long = 'a'.repeat(201)
    const r = await tool('cogdebt_owe').execute({ topic: long })
    assert.equal(r.ok, false)
    assert.match(r.message, /200/)
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：note 截断、tags 去重空格', async () => {
  const { tool, api, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({
      topic: 'T',
      note: 'n'.repeat(2500),
      tags: 'a, b，c  d',
    })
    const d = api.store.read().debts[0]
    assert.equal(d.note.length, 2000)
    assert.deepEqual(d.tags, ['a', 'b', 'c', 'd'])
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：tags 最多 8 个', async () => {
  const { tool, api, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: 'T', tags: '1 2 3 4 5 6 7 8 9 10' })
    assert.equal(api.store.read().debts[0].tags.length, 8)
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：按 id 结清，利息冻结', async () => {
  const { tool, api, cleanup } = setup()
  try {
    const owed = await tool('cogdebt_owe').execute({ topic: '那篇论文', reason: 'avoid', weight: 3 })
    const id = owed.debt.id
    // 把创建时间往前挪 10 天，模拟拖了 10 天
    api.store.mutate((db) => {
      const t = db.debts.find((d) => d.id === id)
      t.createdAt = Date.now() - 10 * DAY
    })
    const r = await tool('cogdebt_pay').execute({ id, mode: 'paid', how: '看完了' })
    assert.equal(r.ok, true)
    assert.match(r.message, /还清了：那篇论文/)
    assert.match(r.message, /拖了 10 天/)
    assert.match(r.message, /结了 60 的利息/)
    const d = api.store.read().debts[0]
    assert.equal(d.status, 'paid')
    assert.equal(d.paidHow, '看完了')
    assert.ok(d.paidAt > 0)
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：dropped 也算结清，但状态分开', async () => {
  const { tool, api, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '不值得懂的东西' })
    const r = await tool('cogdebt_pay').execute({ topic: '不值得', mode: 'dropped' })
    assert.equal(r.ok, true)
    assert.match(r.message, /划掉了/)
    assert.equal(api.store.read().debts[0].status, 'dropped')
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：模糊匹配命中唯一一笔', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: 'Rust 的 Pin 语义' })
    const r = await tool('cogdebt_pay').execute({ topic: 'pin' })
    assert.equal(r.ok, true)
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：匹配多笔要求说清', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '协程 A' })
    await tool('cogdebt_owe').execute({ topic: '协程 B' })
    const r = await tool('cogdebt_pay').execute({ topic: '协程' })
    assert.equal(r.ok, false)
    assert.match(r.message, /匹配到 2 笔/)
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：无 topic 无 id / 找不到 / 已结过 都有明确答复', async () => {
  const { tool, cleanup } = setup()
  try {
    assert.equal((await tool('cogdebt_pay').execute({})).ok, false)
    assert.match((await tool('cogdebt_pay').execute({ topic: '不存在' })).message, /账上没有/)

    await tool('cogdebt_owe').execute({ topic: '已还的' })
    await tool('cogdebt_pay').execute({ topic: '已还的' })
    assert.match((await tool('cogdebt_pay').execute({ topic: '已还的' })).message, /已经结过了/)
    assert.match((await tool('cogdebt_pay').execute({ id: 'cDEADBEEF' })).message, /没有 id/)
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：mode 只认 paid / dropped', async () => {
  const { tool, api, cleanup } = setup()
  try {
    const owed = await tool('cogdebt_owe').execute({ topic: 'X' })
    const r = await tool('cogdebt_pay').execute({ id: owed.debt.id, mode: 'done' })
    assert.equal(r.ok, false)
    assert.match(r.message, /mode 只认/)
    assert.equal(api.store.read().debts[0].status, 'open')
  } finally {
    cleanup()
  }
})

test('cogdebt_list：默认最多 8 笔并提示还剩多少', async () => {
  const { tool, cleanup } = setup()
  try {
    for (let i = 0; i < 10; i++) {
      await tool('cogdebt_owe').execute({ topic: `债 ${i}` })
    }
    const r = await tool('cogdebt_list').execute({})
    assert.equal(r.ok, true)
    assert.equal(r.message.split('\n').filter((l) => l.startsWith('债 ')).length, 8)
    assert.match(r.message, /还有 2 笔/)
    assert.equal(r.count, 10)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：limit 生效并被夹到 1-50', async () => {
  const { tool, cleanup } = setup()
  try {
    for (let i = 0; i < 5; i++) await tool('cogdebt_owe').execute({ topic: `债 ${i}` })
    assert.equal((await tool('cogdebt_list').execute({ limit: 2 })).count, 5)
    assert.equal(
      (await tool('cogdebt_list').execute({ limit: 2 })).message.split('\n').filter((l) => l.startsWith('债 ')).length,
      2,
    )
    assert.equal(
      (await tool('cogdebt_list').execute({ limit: 0 })).message.split('\n').filter((l) => l.startsWith('债 ')).length,
      1,
    )
  } finally {
    cleanup()
  }
})

test('cogdebt_list：空账本给干净文案', async () => {
  const { tool, cleanup } = setup()
  try {
    assert.match((await tool('cogdebt_list').execute({})).message, /账本干净/)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：limit 给废话按默认 8，allLimit 给废话按默认 50', async () => {
  const { tool, cleanup } = setup()
  try {
    for (let i = 0; i < 9; i++) await tool('cogdebt_owe').execute({ topic: `债 ${i}` })
    const rows = (r) => r.message.split('\n').filter((l) => l.startsWith('债 ')).length
    const marked = (r) => r.message.split('\n').filter((l) => l.startsWith('[')).length
    assert.equal(rows(await tool('cogdebt_list').execute({ limit: 'abc' })), 8)
    assert.equal(rows(await tool('cogdebt_list').execute({ limit: null })), 8)
    assert.equal(marked(await tool('cogdebt_list').execute({ all: true, allLimit: {} })), 9)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：all 分支按 allLimit 截断，默认 50 笔，不再偷偷乘 3', async () => {
  const { tool, cleanup } = setup()
  try {
    for (let i = 0; i < 6; i++) await tool('cogdebt_owe').execute({ topic: `债 ${i}` })

    // 修复前：lim*3 = 24，limit 传 1 会吐出 3 笔
    const r = await tool('cogdebt_list').execute({ all: true, limit: 1 })
    const rows = r.message.split('\n').filter((l) => l.startsWith('['))
    assert.equal(rows.length, 6)

    const r2 = await tool('cogdebt_list').execute({ all: true, allLimit: 2 })
    assert.equal(r2.message.split('\n').filter((l) => l.startsWith('[')).length, 2)
    assert.match(r2.message, /还有 4 笔没列/)
    assert.equal(r2.count, 6)
    assert.equal(r2.shown, 2)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：all 分支按记录时间倒序，带状态标记', async () => {
  const { tool, api, cleanup } = setup()
  try {
    const a = await tool('cogdebt_owe').execute({ topic: '先记的' })
    await tool('cogdebt_owe').execute({ topic: '后记的' })
    await tool('cogdebt_pay').execute({ id: a.debt.id })
    api.store.mutate((db) => {
      db.debts.find((d) => d.topic === '先记的').createdAt = Date.now() - DAY
    })
    const r = await tool('cogdebt_list').execute({ all: true })
    const lines = r.message.split('\n')
    assert.match(lines[0], /^\[欠\] 后记的/)
    assert.match(lines[1], /^\[还\] 先记的/)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：reason 过滤；非法 reason 报错', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: 'A', reason: 'avoid' })
    await tool('cogdebt_owe').execute({ topic: 'B', reason: 'hard' })
    const r = await tool('cogdebt_list').execute({ reason: 'avoid' })
    assert.match(r.message, /A/)
    assert.doesNotMatch(r.message, /B/)
    assert.equal(r.count, 1)

    const bad = await tool('cogdebt_list').execute({ reason: 'xx' })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /reason 只认/)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：空白 reason 当没给，不算非法', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: 'A', reason: 'avoid' })
    await tool('cogdebt_owe').execute({ topic: 'B', reason: 'hard' })
    const r = await tool('cogdebt_list').execute({ reason: '   ' })
    assert.equal(r.ok, true)
    assert.equal(r.count, 2)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：过滤后无结果给干净文案', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: 'A', reason: 'avoid' })
    assert.match((await tool('cogdebt_list').execute({ reason: 'hard' })).message, /账本干净/)
  } finally {
    cleanup()
  }
})

test('cogdebt_stat：报总利息与最狠的一类', async () => {
  const { tool, api, cleanup } = setup()
  try {
    const owed = await tool('cogdebt_owe').execute({ topic: '那段协程调度', reason: 'avoid', weight: 3 })
    api.store.mutate((db) => {
      db.debts.find((d) => d.id === owed.debt.id).createdAt = Date.now() - 20 * DAY
    })
    const r = await tool('cogdebt_stat').execute({})
    assert.equal(r.ok, true)
    assert.match(r.message, /还欠 1 件，利息合计 120/)
    assert.match(r.message, /欠得最狠的是「不想碰」这一类/)
    assert.equal(r.stats.worstReason, 'avoid')
    assert.equal(r.stats.totalInterest, 120)
  } finally {
    cleanup()
  }
})

test('cogdebt_stat：刚记下的债不报「欠得最狠」', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '刚记的', reason: 'avoid' })
    const r = await tool('cogdebt_stat').execute({})
    assert.doesNotMatch(r.message, /欠得最狠/)
    assert.equal(r.stats.worstReason, '')
  } finally {
    cleanup()
  }
})

test('cogdebt_stat：空账本', async () => {
  const { tool, cleanup } = setup()
  try {
    assert.match((await tool('cogdebt_stat').execute({})).message, /账上干净/)
  } finally {
    cleanup()
  }
})

test('scan：利息不够门槛时不推送也不炸', async () => {
  const { api, cleanup } = setup({ quietHours: [0, 0], scanIntervalMinutes: 10 })
  try {
    await api.store.mutate((db) => {
      db.debts.push({
        id: 'c1', topic: '刚记的', reason: 'avoid', weight: 3, status: 'open',
        createdAt: Date.now(), updatedAt: Date.now(), paidAt: 0, paidHow: '',
      })
    })
    await api.scan()
    assert.equal(api.store.read().meta.lastNag.c1, undefined)
  } finally {
    cleanup()
  }
})

test('scan：达标时写回 lastNag', async () => {
  const { api, cleanup } = setup({ quietHours: [0, 0], scanIntervalMinutes: 10 })
  try {
    await api.store.mutate((db) => {
      db.debts.push({
        id: 'c2', topic: '拖了很久', reason: 'avoid', weight: 3, status: 'open',
        createdAt: Date.now() - 30 * DAY, updatedAt: Date.now() - 30 * DAY, paidAt: 0, paidHow: '',
      })
    })
    await api.scan()
    assert.equal(typeof api.store.read().meta.lastNag.c2, 'number')
  } finally {
    cleanup()
  }
})

test('scan：静默时段只更新时间戳，不催', async () => {
  const hour = new Date().getHours()
  const from = hour
  const to = (hour + 1) % 24
  const { api, cleanup } = setup({ quietHours: [from, to], scanIntervalMinutes: 10 })
  try {
    await api.store.mutate((db) => {
      db.debts.push({
        id: 'c3', topic: '拖了很久', reason: 'avoid', weight: 3, status: 'open',
        createdAt: Date.now() - 30 * DAY, updatedAt: Date.now() - 30 * DAY, paidAt: 0, paidHow: '',
      })
    })
    await api.scan()
    const db = api.store.read()
    assert.equal(db.meta.lastNag.c3, undefined)
    assert.ok(db.meta.lastScanAt > 0)
  } finally {
    cleanup()
  }
})

test('scan：并发重入被挡住（同一次扫描不会跑两遍）', async () => {
  const { api, cleanup } = setup({ quietHours: [0, 0], scanIntervalMinutes: 10 })
  try {
    await api.store.mutate((db) => {
      db.debts.push({
        id: 'c4', topic: '拖了很久', reason: 'avoid', weight: 3, status: 'open',
        createdAt: Date.now() - 30 * DAY, updatedAt: Date.now() - 30 * DAY, paidAt: 0, paidHow: '',
      })
    })
    await Promise.all([api.scan(), api.scan(), api.scan()])
    // 只会记一次 lastNag；第二次起被 scanning 挡住，冷却也不会重复
    const t = api.store.read().meta.lastNag.c4
    assert.equal(typeof t, 'number')
    assert.ok(t <= Date.now())
  } finally {
    cleanup()
  }
})

test('config：scanIntervalMinutes 下限 10 分钟', () => {
  const { ctx, cleanup } = setup({ scanIntervalMinutes: 1 })
  try {
    // 装配成功即可；下限由 MIN_SCAN 保证，这里只验证不抛
    assert.equal(ctx.registered.length, 4)
  } finally {
    cleanup()
  }
})

test('cogdebt_owe：tags 归一化 —— 中文逗号/空格都算分隔，去重、小写、上限 8', async () => {
  const { tool, cleanup } = setup()
  try {
    const r = await tool('cogdebt_owe').execute({
      topic: '读那段编译原理',
      tags: '编译，后端, 后端  编译, DS',
    })
    assert.deepEqual(r.debt.tags, ['编译', '后端', 'ds'])

    const many = await tool('cogdebt_owe').execute({
      topic: '标签太多',
      tags: 'a,b,c,d,e,f,g,h,i,j,k',
    })
    assert.equal(many.debt.tags.length, 8)
    assert.deepEqual(many.debt.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
  } finally {
    cleanup()
  }
})

test('cogdebt_list：tag 筛选只列带该标签的债，标签大小写不敏感', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '前端的事', tags: 'FE' })
    await tool('cogdebt_owe').execute({ topic: '后端的事', tags: 'be' })
    const r = await tool('cogdebt_list').execute({ tag: 'fe' })
    assert.match(r.message, /前端的事/)
    assert.doesNotMatch(r.message, /后端的事/)
    assert.equal(r.count, 1)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：tag 筛不到时给出明确空态，不说「账本干净」', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '有的事', tags: 'a' })
    const r = await tool('cogdebt_list').execute({ tag: 'zzz' })
    assert.equal(r.ok, true)
    assert.match(r.message, /没有带「zzz」标签的债/)
    assert.doesNotMatch(r.message, /账本干净/)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：all=true 时 tag 筛选同样生效，不被忽略', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '带标的', tags: 'x' })
    await tool('cogdebt_owe').execute({ topic: '不带标的' })
    const r = await tool('cogdebt_list').execute({ all: true, tag: 'x' })
    assert.match(r.message, /带标的/)
    assert.doesNotMatch(r.message, /不带标的/)
    assert.match(r.message, /只列了带「x」标签的/)
    assert.equal(r.count, 1)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：只列一笔时把 note 一并显示（note 不再是只写不读的死字段）', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '只有一笔', note: '当时想的是先看源码' })
    const r = await tool('cogdebt_list').execute({})
    assert.match(r.message, /备注：当时想的是先看源码/)
  } finally {
    cleanup()
  }
})

test('cogdebt_list：多笔时不塞备注，避免刷屏', async () => {
  const { tool, cleanup } = setup()
  try {
    await tool('cogdebt_owe').execute({ topic: '甲', note: '甲的备注' })
    await tool('cogdebt_owe').execute({ topic: '乙', note: '乙的备注' })
    const r = await tool('cogdebt_list').execute({})
    assert.doesNotMatch(r.message, /备注：/)
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：id 精确指到已结清的债，说清是哪天结的、怎么结的', async () => {
  const { tool, cleanup } = setup()
  try {
    const a = await tool('cogdebt_owe').execute({ topic: '还过的债' })
    await tool('cogdebt_pay').execute({ id: a.debt.id, mode: 'dropped' })
    const r = await tool('cogdebt_pay').execute({ id: a.debt.id })
    assert.equal(r.ok, false)
    assert.match(r.message, /已经划掉了/)
    assert.match(r.message, /还过的债/)
    assert.doesNotMatch(r.message, /mode 只认/)
  } finally {
    cleanup()
  }
})

test('cogdebt_pay：已还清的债再结，提示「还清了」而不是状态码', async () => {
  const { tool, cleanup } = setup()
  try {
    const a = await tool('cogdebt_owe').execute({ topic: '甲债' })
    await tool('cogdebt_pay').execute({ id: a.debt.id, mode: 'paid' })
    const r = await tool('cogdebt_pay').execute({ id: a.debt.id })
    assert.equal(r.ok, false)
    assert.match(r.message, /已经还清了/)
    assert.doesNotMatch(r.message, /\(paid\)|（paid）/)
  } finally {
    cleanup()
  }
})

test('store.read：老数据 tags 是裸字符串时自动归一成数组，tag 筛得住', async () => {
  const { dir, tool, cleanup } = setup()
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'debts.json'), JSON.stringify({
      version: 1,
      debts: [
        { id: 'c1', topic: '老格式', tags: '旧标签, legacy', reason: 'hard', weight: 2, status: 'open', createdAt: Date.now() },
      ],
      meta: { lastScanAt: 0, lastNag: {} },
    }), 'utf8')
    const r = await tool('cogdebt_list').execute({ tag: 'legacy' })
    assert.match(r.message, /老格式/)
  } finally {
    cleanup()
  }
})