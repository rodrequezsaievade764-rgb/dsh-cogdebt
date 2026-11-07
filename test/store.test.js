import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  STATUSES,
  REASON_KEYS,
  defaultStorePath,
  emptyDb,
  createStore,
  newId,
  normReason,
  clampWeight,
  daysSince,
} from '../lib/store.js'

function tempStorePath() {
  const dir = mkdtempSync(join(tmpdir(), 'cogdebt-store-'))
  return { dir, storePath: join(dir, 'nested', 'debts.json') }
}

test('STATUSES / REASON_KEYS 是文档承诺的那几个值', () => {
  assert.deepEqual(STATUSES, ['open', 'paid', 'dropped'])
  assert.deepEqual(REASON_KEYS, ['avoid', 'hard', 'interrupted', 'time', 'later'])
})

test('defaultStorePath 落在 ~/.dsh/cogdebt/debts.json', () => {
  const p = defaultStorePath().replace(/\\/g, '/')
  assert.match(p, /\/\.dsh\/cogdebt\/debts\.json$/)
})

test('emptyDb 结构完整', () => {
  const db = emptyDb()
  assert.equal(db.version, 1)
  assert.deepEqual(db.debts, [])
  assert.equal(db.meta.lastScanAt, 0)
  assert.deepEqual(db.meta.lastNag, {})
  assert.equal(typeof db.meta.createdAt, 'number')
})

test('newId 形如 c + 8 位十六进制且不重复', () => {
  const ids = new Set()
  for (let i = 0; i < 200; i++) {
    const id = newId()
    assert.match(id, /^c[0-9a-f]{8}$/)
    ids.add(id)
  }
  assert.equal(ids.size, 200)
})

test('normReason：空输入返回空串（未指定）', () => {
  assert.equal(normReason(undefined), '')
  assert.equal(normReason(null), '')
  assert.equal(normReason(''), '')
  assert.equal(normReason('   '), '')
})

test('normReason：认不出来的返回空串，绝不静默降级成 later', () => {
  assert.equal(normReason('xx'), '')
  assert.equal(normReason('aviod'), '')
  assert.equal(normReason('随便'), '')
  assert.equal(normReason(123), '')
})

test('normReason：五个枚举与中文别名都能认', () => {
  assert.equal(normReason('avoid'), 'avoid')
  assert.equal(normReason('AVOID'), 'avoid')
  assert.equal(normReason('  hard '), 'hard')
  assert.equal(normReason('interrupted'), 'interrupted')
  assert.equal(normReason('time'), 'time')
  assert.equal(normReason('later'), 'later')
  assert.equal(normReason('逃避'), 'avoid')
  assert.equal(normReason('不想看'), 'avoid')
  assert.equal(normReason('看不懂'), 'hard')
  assert.equal(normReason('被打断'), 'interrupted')
  assert.equal(normReason('没时间'), 'time')
  assert.equal(normReason('以后'), 'later')
})

test('clampWeight：夹到 1-3，非数字回默认 2', () => {
  assert.equal(clampWeight(1), 1)
  assert.equal(clampWeight(3), 3)
  assert.equal(clampWeight(0), 1)
  assert.equal(clampWeight(99), 3)
  assert.equal(clampWeight(2.4), 2)
  assert.equal(clampWeight(2.6), 3)
  assert.equal(clampWeight('2'), 2)
  assert.equal(clampWeight('x'), 2)
  assert.equal(clampWeight(undefined), 2)
  assert.equal(clampWeight(NaN), 2)
})

test('daysSince：负数归零，缺时间戳归零', () => {
  const now = 1_700_000_000_000
  assert.equal(daysSince(now - 86400000, now), 1)
  assert.equal(daysSince(now + 86400000, now), 0)
  assert.equal(daysSince(0, now), 0)
  assert.equal(daysSince(undefined, now), 0)
})

test('createStore：不存在的文件读出空库', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    assert.equal(store.path, storePath)
    const db = store.read()
    assert.deepEqual(db.debts, [])
    assert.equal(store.size, 0)
    // 读不该建文件
    assert.equal(existsSync(storePath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createStore：write 建父目录、roundtrip 一致', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    const db = emptyDb()
    db.debts.push({ id: 'c00000001', topic: '那段协程调度', reason: 'hard', weight: 2, status: 'open', createdAt: 1 })
    store.write(db)
    assert.ok(existsSync(storePath))
    const back = store.read()
    assert.equal(back.debts.length, 1)
    assert.equal(back.debts[0].topic, '那段协程调度')
    assert.equal(store.size, 1)
    // 落盘是格式化过的 JSON，人能直接看
    assert.match(readFileSync(storePath, 'utf8'), /\n {2}"version": 1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createStore：mutate 读改写并返回回调结果', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    const out = store.mutate((db) => {
      db.debts.push({ id: 'c00000002', topic: 'X', reason: 'later', weight: 1, status: 'open', createdAt: 1 })
      return 'done'
    })
    assert.equal(out, 'done')
    assert.equal(store.read().debts.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createStore：坏文件改名留档，然后返回空库，绝不覆盖', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    store.write(emptyDb())
    writeFileSync(storePath, '{ 这不是 JSON', 'utf8')

    const db = store.read()
    assert.deepEqual(db.debts, [])

    const names = readdirSync(join(dir, 'nested'))
    const broken = names.filter((n) => n.startsWith('debts.json.broken-'))
    assert.equal(broken.length, 1)
    assert.equal(readFileSync(join(dir, 'nested', broken[0]), 'utf8'), '{ 这不是 JSON')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createStore：空文件按空库处理，不改名', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    store.write(emptyDb())
    writeFileSync(storePath, '   \n', 'utf8')
    assert.deepEqual(store.read().debts, [])
    assert.equal(readdirSync(join(dir, 'nested')).filter((n) => n.includes('.broken-')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createStore：手改缺字段的旧文件自动补齐', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    store.write(emptyDb())
    writeFileSync(storePath, JSON.stringify({ debts: [{ id: 'c1' }] }), 'utf8')
    const db = store.read()
    assert.equal(db.version, 1)
    assert.equal(db.debts.length, 1)
    assert.deepEqual(db.meta.lastNag, {})
    assert.equal(db.meta.lastScanAt, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createStore：debts 不是数组时重置为空数组', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    store.write(emptyDb())
    writeFileSync(storePath, JSON.stringify({ version: 1, debts: 'nope', meta: {} }), 'utf8')
    assert.deepEqual(store.read().debts, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createStore：坏条目丢弃，status / reason 归一化', () => {
  const { dir, storePath } = tempStorePath()
  try {
    const store = createStore(storePath)
    store.write(emptyDb())
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      debts: [
        null,
        'not-an-object',
        { id: 'a', topic: 'A', status: 'Open', reason: 'avoid', weight: 2, createdAt: 1 },
        { id: 'b', topic: 'B', status: 'PAID', reason: '', weight: 2, createdAt: 1 },
        { id: 'c', topic: 'C', status: 'dropped', reason: 'hard', weight: 2, createdAt: 1 },
      ],
      meta: {},
    }), 'utf8')

    const db = store.read()
    assert.equal(db.debts.length, 3)
    const byId = Object.fromEntries(db.debts.map((d) => [d.id, d]))
    // 拼错的 status 会让人「账本里明明有，工具说没有」，一律回 open
    assert.equal(byId.a.status, 'open')
    assert.equal(byId.b.status, 'open')
    assert.equal(byId.c.status, 'dropped')
    assert.equal(byId.b.reason, 'later')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
