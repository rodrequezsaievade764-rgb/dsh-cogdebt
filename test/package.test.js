import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('零运行时依赖：没有 dependencies / optionalDependencies', () => {
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.optionalDependencies, undefined)
})

test('package.json：type=module，main 指向 lib/index.js', () => {
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
})

test('package.json：有 test 脚本与 files 白名单', () => {
  assert.equal(pkg.scripts.test, 'node --test "test/**/*.test.js"')
  assert.ok(Array.isArray(pkg.files))
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
})

test('lib 下所有 import 只指向 node: 内置模块或相对路径', () => {
  const dir = join(ROOT, 'lib')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 4)

  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    // tool.js 自给自足，一条 import 都没有；其余文件必须有
    if (f !== 'tool.js') assert.ok(specs.length > 0, `${f} 应该至少有一处 import`)
    for (const s of specs) {
      const ok = s.startsWith('node:') || s.startsWith('./') || s.startsWith('../')
      assert.ok(ok, `${f} 里出现了非内置、非相对的 import：${s}`)
    }
  }
})

test('cordis.patch.yml 里 insert 的 id 与包名一致', () => {
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(yml, /- insert:/)
  assert.match(yml, new RegExp(`id: ${pkg.name}`))
  assert.match(yml, new RegExp(`name: ${pkg.name}`))
})

test('README 提到的工具名与代码里注册的一致', async () => {
  const { apply } = await import('../lib/index.js')
  const registered = []
  let dispose = () => {}
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    get: () => undefined,
    tools: { register: (t) => { registered.push(t.name); return () => {} } },
    // 必须把清理函数拿住：effect 里挂了 setInterval，不拆的话测试进程退不出去
    effect: (fn) => { dispose = fn() || (() => {}); return () => {} },
  }
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'cogdebt-readme-'))
  try {
    apply(ctx, { storePath: join(dir, 'debts.json'), quietHours: [0, 0] })
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    for (const n of registered) assert.ok(readme.includes(n), `README 没写 ${n}`)
  } finally {
    dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
