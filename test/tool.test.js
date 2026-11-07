import test from 'node:test'
import assert from 'node:assert/strict'

import { defineTool, str, int, num, bool } from '../lib/tool.js'

test('defineTool：拼出宿主同形的参数 schema', () => {
  const t = defineTool({
    name: 'demo',
    description: '演示',
    properties: { a: str('甲'), b: int('乙') },
    required: ['a'],
    execute: async () => ({ ok: true, message: '好' }),
  })
  assert.equal(t.name, 'demo')
  assert.equal(t.description, '演示')
  assert.equal(t.slow, false)
  assert.deepEqual(t.parameters, {
    type: 'object',
    properties: { a: { type: 'string', description: '甲' }, b: { type: 'integer', description: '乙' } },
    required: ['a'],
    additionalProperties: false,
  })
  assert.equal(t.output.schema.required[0], 'ok')
  assert.equal(t.output.schema.properties.message.type, 'string')
})

test('defineTool：默认不要求参数', () => {
  const t = defineTool({ name: 'x', description: 'y', execute: async () => ({ ok: true, message: '' }) })
  assert.deepEqual(t.parameters.properties, {})
  assert.deepEqual(t.parameters.required, [])
})

test('defineTool：execute 透传返回值与参数', async () => {
  const t = defineTool({
    name: 'echo',
    description: 'd',
    execute: async (args) => ({ ok: true, message: JSON.stringify(args) }),
  })
  const r = await t.execute({ z: 1 })
  assert.deepEqual(r, { ok: true, message: '{"z":1}' })
})

test('defineTool：execute 无参调用拿到空对象', async () => {
  const t = defineTool({ name: 'e', description: 'd', execute: async (args) => ({ ok: true, message: String(Object.keys(args).length) }) })
  assert.equal((await t.execute()).message, '0')
})

test('defineTool：execute 抛错兜成 ok:false，不炸宿主', async () => {
  const t = defineTool({
    name: 'boom',
    description: 'd',
    execute: async () => { throw new Error('内部炸了') },
  })
  const r = await t.execute({})
  assert.equal(r.ok, false)
  assert.match(r.message, /出错了：内部炸了/)
})

test('defineTool：抛非 Error 也能兜住', async () => {
  const t = defineTool({ name: 'boom2', description: 'd', execute: async () => { throw '裸字符串' } })
  assert.equal((await t.execute({})).message, '出错了：裸字符串')
})

test('output：宿主校验的形状——schema 与 render 都在 output 里', () => {
  const t = defineTool({ name: 'shape', description: 'd', execute: async () => ({ ok: true, message: 'hi' }) })
  // 宿主拒收工具的条件就是这个：render 不在 output 里，或者根本不是函数。
  // 曾经 render 被放在工具对象顶层，插件加载正常，四个工具一个都调不到。
  assert.equal(typeof t.output.schema, 'object')
  assert.equal(typeof t.output.render, 'function')
  assert.equal(t.render, undefined, 'render 不能同时挂在顶层，形态只认 output.render')
})

test('render：默认把 message 包成内容块数组', () => {
  const t = defineTool({ name: 'r', description: 'd', execute: async () => ({ ok: true, message: 'hi' }) })
  assert.deepEqual(t.output.render({}, { ok: true, message: 'hi' }), [{ type: 'text', text: 'hi' }])
  assert.deepEqual(t.output.render({}, null), [{ type: 'text', text: '✓' }])
})

test('render：失败时带 ✗ 前缀', () => {
  const t = defineTool({ name: 'rf', description: 'd', execute: async () => ({ ok: false, message: '坏了' }) })
  assert.deepEqual(t.output.render({}, { ok: false, message: '坏了' }), [{ type: 'text', text: '✗ 坏了' }])
  assert.deepEqual(t.output.render({}, { ok: false }), [{ type: 'text', text: '✗ 没成功' }])
})

test('render：可自定义，同样在 output 里', () => {
  const t = defineTool({
    name: 'r2',
    description: 'd',
    execute: async () => ({ ok: true, message: 'hi' }),
    render: (_a, v) => [{ type: 'text', text: 'R:' + v.message }],
  })
  assert.deepEqual(t.output.render({}, { message: 'hi' }), [{ type: 'text', text: 'R:hi' }])
})

test('类型小工具产出正确 type', () => {
  assert.deepEqual(str('a'), { type: 'string', description: 'a' })
  assert.deepEqual(int('b'), { type: 'integer', description: 'b' })
  assert.deepEqual(num('c'), { type: 'number', description: 'c' })
  assert.deepEqual(bool('d'), { type: 'boolean', description: 'd' })
})
