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

test('render：默认取 message', () => {
  const t = defineTool({ name: 'r', description: 'd', execute: async () => ({ ok: true, message: 'hi' }) })
  assert.equal(t.render({ ok: true, message: 'hi' }), 'hi')
  assert.equal(t.render(null), '')
})

test('render：可自定义', () => {
  const t = defineTool({
    name: 'r2',
    description: 'd',
    execute: async () => ({ ok: true, message: 'hi' }),
    render: (r) => 'R:' + r.message,
  })
  assert.equal(t.render({ message: 'hi' }), 'R:hi')
})

test('类型小工具产出正确 type', () => {
  assert.deepEqual(str('a'), { type: 'string', description: 'a' })
  assert.deepEqual(int('b'), { type: 'integer', description: 'b' })
  assert.deepEqual(num('c'), { type: 'number', description: 'c' })
  assert.deepEqual(bool('d'), { type: 'boolean', description: 'd' })
})
