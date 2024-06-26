import { Bot, camelCase, Context, h, HTTP, snakeCase, Universal } from '@satorijs/core'

export function transformKey(source: any, callback: (key: string) => string) {
  if (!source || typeof source !== 'object') return source
  if (Array.isArray(source)) return source.map(value => transformKey(value, callback))
  return Object.fromEntries(Object.entries(source).map(([key, value]) => {
    if (key.startsWith('_')) return [key, value]
    return [callback(key), transformKey(value, callback)]
  }))
}

function createInternal(bot: SatoriBot, prefix = '') {
  return new Proxy(() => {}, {
    apply(target, thisArg, args) {
      const key = snakeCase(prefix.slice(1))
      bot.logger.debug('[request.internal]', key, args)
      return bot.http.post('/v1/internal/' + key, args)
    },
    get(target, key, receiver) {
      if (typeof key === 'symbol' || key in target) {
        return Reflect.get(target, key, receiver)
      }
      return createInternal(bot, prefix + '.' + key)
    },
  })
}

export class SatoriBot<C extends Context = Context> extends Bot<C, Universal.Login> {
  public http: HTTP
  public internal = createInternal(this)

  constructor(ctx: C, config: Universal.Login) {
    super(ctx, config, 'satori')
    Object.assign(this, config)
  }
}

for (const [key, method] of Object.entries(Universal.Methods)) {
  SatoriBot.prototype[method.name] = async function (this: SatoriBot, ...args: any[]) {
    let payload: any
    if (method.name === 'createUpload') {
      payload = new FormData()
      for (const { data, type, filename } of args as Universal.Upload[]) {
        payload.append('file', new Blob([data], { type }), filename)
      }
    } else {
      payload = {}
      for (const [index, field] of method.fields.entries()) {
        if (method.name === 'createMessage' && field.name === 'content') {
          const session = this.session({
            type: 'send',
            channel: { id: args[0], type: 0 },
            ...args[3]?.session?.event,
          })
          session.elements = await session.transform(h.normalize(args[index]))
          if (await session.app.serial(session, 'before-send', session, args[3] ?? {})) return
          payload[field.name] = session.elements.join('')
        } else {
          payload[field.name] = transformKey(args[index], snakeCase)
        }
      }
    }
    this.logger.debug('[request]', key, payload)
    const result = await this.http.post('/v1/' + key, payload)
    return transformKey(result, camelCase)
  }
}
