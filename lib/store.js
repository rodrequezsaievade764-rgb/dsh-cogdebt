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
      // 不是对象的条目丢弃；status 不在枚举里的一律回 open。
      // 不归一化的话，一条 status 拼错（'Open' / 'OEPN'）的债会同时从 ranked、
      // summary、pay 里消失 —— 用户眼里就是「账本里明明有，工具说没有」。
      db.debts = db.debts.filter((d) => d && typeof d === 'object')
      for (const d of db.debts) {
        if (!STATUSES.includes(String(d.status))) d.status = 'open'
        if (typeof d.reason !== 'string' || !d.reason) d.reason = 'later'
        // tags 早期写成裸字符串（手改文件或老版本），统一成数组。
        // 不归一化的话，list 的 tag 筛选对老数据一律筛不到。
        if (!Array.isArray(d.tags)) d.tags = normTags(d.tags)
        if (typeof d.note !== 'string') d.note = ''
      }
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

/** 五个合法 reason。顺序即文档顺序，tool 的报错文案直接用它拼。 */
export const REASON_KEYS = ['avoid', 'hard', 'interrupted', 'time', 'later']

const REASON_ALIAS = {
  avoid: 'avoid', 逃避: 'avoid', 不想看: 'avoid', 烦: 'avoid',
  hard: 'hard', 难: 'hard', 看不懂: 'hard', 太难: 'hard',
  interrupted: 'interrupted', 被打断: 'interrupted', 中断: 'interrupted',
  time: 'time', 没时间: 'time', 忙: 'time',
  later: 'later', 以后: 'later', 回头: 'later', 稍后: 'later',
}

// 认不出来就返回 ''，表示「没指定」。
// 早先这里返回 'later'，于是把 'xx' 或拼错一律记成「明天再说」——
// 静默降级比报错更坏：用户以为自己标了原因，账本却按 0.5 的系数算利息。
// 到底「没指定」还是「写错了」由调用方判断：tool 层拿原始输入区分空串与非法值。
export function normReason(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s) return ''
  return REASON_ALIAS[s] || ''
}

export function clampWeight(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 2
  return Math.max(1, Math.min(3, Math.round(n)))
}

/**
 * 标签归一化：逗号、中文逗号、空白都算分隔符，去空、去重、小写、最多 8 个。
 * 早先这段逻辑内联在 owe 里，list 按 tag 筛的时候没有同一套规则，
 * 结果「存进去的 tag」和「能筛到的 tag」两套口径 —— 用户填了筛不到。
 */
export const MAX_TAGS = 8

export function normTags(v) {
  const raw = Array.isArray(v) ? v.join(',') : String(v == null ? '' : v)
  const out = []
  for (const piece of raw.split(/[,，、\s]+/)) {
    const t = piece.trim().toLowerCase()
    if (!t) continue
    if (!out.includes(t)) out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** 一条债 / 一个任务是否带某个标签。标签比较同样走小写归一。 */
export function hasTag(item, tag) {
  const want = String(tag == null ? '' : tag).trim().toLowerCase()
  if (!want) return false
  const list = Array.isArray(item && item.tags) ? item.tags : []
  return list.some((t) => String(t).toLowerCase() === want)
}

export function daysSince(ts, now = Date.now()) {
  const t = Number(ts) || 0
  if (!t) return 0
  return Math.max(0, (now - t) / 86400000)
}
