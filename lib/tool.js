// 工具定义的小工具函数。
//
// 不 import 宿主内部的 dsh-tools 包：profile 里解析不到它，
// 多一层依赖就多一个装不上的理由。自己拼一个同形的对象就够了。

export function defineTool({ name, description, properties = {}, required = [], execute, render, slow = false }) {
  const parameters = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }

  return {
    name,
    description,
    slow,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
    },
    async execute(args = {}) {
      try {
        return await execute(args)
      } catch (e) {
        return { ok: false, message: '出错了：' + ((e && e.message) || String(e)) }
      }
    },
    render: render || ((r) => (r && r.message) || ''),
  }
}

export const str = (description) => ({ type: 'string', description })
export const int = (description) => ({ type: 'integer', description })
export const num = (description) => ({ type: 'number', description })
export const bool = (description) => ({ type: 'boolean', description })
