// 工具定义的小工具函数。
//
// 不 import 宿主内部的 dsh-tools 包：profile 里解析不到它，
// 多一层依赖就多一个装不上的理由。自己拼一个同形的对象就够了。
//
// 踩过的坑：宿主校验的是 `output` 里必须有 `schema` 和 `render` 两样。
// 把 render 放在工具对象顶层不算数——宿主报
// `tool "x" must declare output { schema, render, presentationMeta? }`，
// 而且是 warn 级：插件照常加载，工具却一个都调不到，日志里只有一行不起眼的警告。
// render 的返回值也要是内容块数组 [{ type: 'text', text }]，不是裸字符串。

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
      render:
        render ||
        ((_args, value) => [
          {
            type: 'text',
            text:
              value && value.ok === false
                ? '✗ ' + ((value && value.message) || '没成功')
                : (value && value.message) || '✓',
          },
        ]),
    },
    async execute(args = {}) {
      try {
        return await execute(args)
      } catch (e) {
        return { ok: false, message: '出错了：' + ((e && e.message) || String(e)) }
      }
    },
  }
}

export const str = (description) => ({ type: 'string', description })
export const int = (description) => ({ type: 'integer', description })
export const num = (description) => ({ type: 'number', description })
export const bool = (description) => ({ type: 'boolean', description })
