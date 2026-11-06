// 存储层：一个 JSON 文件，坏了不覆盖，先改名留档再重开。
//
// 为什么不用数据库：这是个人级的数据量（几百条撑死）。
// 数据库带来的是依赖、是版本迁移、是「换个机器就读不出来」。
// 一个 JSON 文件，你能直接打开看、能扔进 git、能自己 diff。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export const STATUSES = ['open', 'paid', 'dropped']

/** 默认路径：~/.dsh/cogdebt/debts.json */
export function defaultStorePath() {
  return join(homedir(), '.dsh', 'cogdebt', 'debts.json')
}

export function emptyDb() {
  return {
    version: 1,
    debts: [],
    meta: { lastScanAt: 0, lastNag: {}, createdAt: Date.now() },
  }
}

export function createStore(file) {
  const path = file || defaultStorePath()

  function write(db) {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    renameSync(tmp, path)
  }

  function read() {
    try {
      if (!existsSync(path)) return emptyDb()
      const raw = readFileSync(path, 'utf8').trim()
      if (!raw) return emptyDb()
      const db = JSON.parse(raw)
      // 老版本 / 手改过的文件可能缺字段，补齐，别让插件崩
      if (!Array.isArray(db.debts)) db.debts = []
      if (!db.meta || typeof db.meta !== 'object') db.meta = {}
      if (!db.meta.lastNag || typeof db.meta.lastNag !== 'object') db.meta.lastNag = {}
      if (typeof db.meta.lastScanAt !== 'number') db.meta.lastScanAt = 0
      if (typeof db.version !== 'number') db.version = 1
      return db
    } catch {
      // 解析失败：把坏文件改名留档，绝不悄悄覆盖用户数据
      try {
        renameSync(path, `${path}.broken-${Date.now()}`)
      } catch {}
      return emptyDb()
    }
  }

  function mutate(fn) {
    const db = read()
    const out = fn(db)
    write(db)
    return out
  }

  return {
    path,
    read,
    write,
    mutate,
    get size() {
      return read().debts.length
    },
  }
}

export function newId() {
  return 'c' + randomBytes(4).toString('hex')
}

const REASON_ALIAS = {
  avoid: 'avoid', 逃避: 'avoid', 不想看: 'avoid', 烦: 'avoid',
  hard: 'hard', 难: 'hard', 看不懂: 'hard', 太难: 'hard',
  interrupted: 'interrupted', 被打断: 'interrupted', 中断: 'interrupted',
  time: 'time', 没时间: 'time', 忙: 'time',
  later: 'later', 以后: 'later', 回头: 'later', 稍后: 'later',
}

export function normReason(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return 'later'
  return REASON_ALIAS[s] || 'later'
}

export function normStatus(v) {
  const s = String(v || '').trim().toLowerCase()
  if (STATUSES.includes(s)) return s
  const alias = {
    open: 'open', 欠着: 'open', 没还: 'open', 待还: 'open',
    paid: 'paid', 已还: 'paid', 懂了: 'paid', 还了: 'paid',
    dropped: 'dropped', 放弃: 'dropped', 不还: 'dropped', 划掉: 'dropped',
  }
  return alias[s] || ''
}

export function clampWeight(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(3, Math.round(n)))
}

export function daysSince(ts, now = Date.now()) {
  const t = Number(ts) || 0
  if (!t) return 0
  return Math.max(0, (now - t) / 86400000)
}
