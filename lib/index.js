/**
 * dsh-whale-balance — 让模型自己查 DeepSeek 余额
 *
 * 注册一个工具 deepseek_balance，调用官方接口
 *   GET https://api.deepseek.com/user/balance
 * 返回一个数字：currency 匹配的那条 total_balance（默认 CNY，单位元）。
 *
 * 取数顺序（前两条都要求 sk- 开头的 API key）：
 *   1. 环境变量 DEEPSEEK_API_KEY → GET https://api.deepseek.com/user/balance
 *   2. DSH 的 credentials 服务（resolve('DEEPSEEK_API_KEY')）→ 同上
 *   3. <DSH_HOME>/deepseek-api-key.txt 或 ~/.dsh/deepseek-api-key.txt（一行纯文本）→ 同上
 *   4. 没有 API key 时，用 DSH 自己网页登录的 grant（credentials 里的
 *      'deepseek-account-platform/default'）请求平台接口：
 *        GET https://platform.deepseek.com/api/v0/users/get_user_summary
 *        头：x-dsh-auth-token: <grant token>
 *      取 normal_wallets + bonus_wallets 里 currency 匹配的 balance 相加。
 *      这样别人装了插件、只要登录过 DSH 就能直接用，不用填 key。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-whale-balance'
export const inject = []
export const Config = undefined

const VERSION = '0.2.0'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const PLATFORM_ORIGIN = 'https://platform.deepseek.com'
const SUMMARY_URL = `${PLATFORM_ORIGIN}/api/v0/users/get_user_summary`
const PLATFORM_CREDENTIAL = 'deepseek-account-platform/default'

// ---------------------------------------------------------------------------
// 输出结构（和 DSH 工具约定一致）
// ---------------------------------------------------------------------------

const okSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    count: { type: 'integer' },
  },
  required: ['ok', 'text'],
}

const textRender = (args, value) => [{ type: 'text', text: String(value?.text ?? '') }]

// ---------------------------------------------------------------------------
// 拿 key
// ---------------------------------------------------------------------------

function keyFileCandidates(cfg) {
  const list = []
  if (cfg.keyFile) list.push(cfg.keyFile)
  const dshHome = process.env.DSH_HOME
  const userProfile = process.env.USERPROFILE || process.env.HOME || ''
  if (dshHome) list.push(path.join(dshHome, 'deepseek-api-key.txt'))
  if (userProfile) list.push(path.join(userProfile, '.dsh', 'deepseek-api-key.txt'))
  try {
    list.push(path.join(os.homedir(), '.dsh', 'deepseek-api-key.txt'))
  } catch {
    /* ignore */
  }
  return [...new Set(list)]
}

function cleanKey(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim()
}

function keyFromFile(cfg) {
  for (const file of keyFileCandidates(cfg)) {
    try {
      const key = cleanKey(fs.readFileSync(file, 'utf8'))
      if (key) return key
    } catch {
      /* 下一个 */
    }
  }
  return ''
}

async function resolveKey(ctx, cfg) {
  const fromEnv = cleanKey(process.env.DEEPSEEK_API_KEY)
  if (fromEnv) return { key: fromEnv, source: 'env' }

  try {
    const creds = ctx?.get?.('credentials')
    if (creds && typeof creds.resolve === 'function') {
      const got = await creds.resolve('DEEPSEEK_API_KEY')
      const key = cleanKey(typeof got === 'string' ? got : got?.value ?? got?.secret ?? got?.token)
      if (key) return { key, source: 'credentials' }
    }
  } catch {
    /* 没有就没有 */
  }

  const key = keyFromFile(cfg)
  if (key) return { key, source: 'file' }
  return { key: '', source: '' }
}

// ---------------------------------------------------------------------------
// 没有 API key 时：用 DSH 自己网页登录的 grant
// ---------------------------------------------------------------------------

async function resolvePlatformToken(ctx) {
  try {
    const creds = ctx?.get?.('credentials')
    if (!creds || typeof creds.resolve !== 'function') return ''
    const got = await creds.resolve(PLATFORM_CREDENTIAL)
    return String(
      (typeof got === 'string' ? got : got?.token ?? got?.secret ?? got?.value) ?? '',
    ).trim()
  } catch {
    return ''
  }
}

function parseAmount(value) {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) ? n : null
}

async function fetchPlatformBalance(token, currency, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(SUMMARY_URL, {
      method: 'GET',
      headers: {
        'x-dsh-auth-token': token,
        Accept: 'application/json',
        'User-Agent': `dsh-whale-balance/${VERSION}`,
      },
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 200)}` }
    let data
    try {
      data = JSON.parse(body)
    } catch {
      return { ok: false, error: `返回不是 JSON：${body.slice(0, 200)}` }
    }
    if (data?.code !== 0) {
      return { ok: false, error: `平台返回 code=${data?.code} ${data?.msg ?? ''}`.trim() }
    }
    const biz = data?.data?.biz_data ?? {}
    const wallets = [...(biz.normal_wallets ?? []), ...(biz.bonus_wallets ?? [])]
    if (!wallets.length) return { ok: false, error: '没有 wallets 数据' }
    let sum = 0
    let hit = false
    for (const w of wallets) {
      if (String(w?.currency ?? '').toUpperCase() !== currency.toUpperCase()) continue
      const n = parseAmount(w?.balance)
      if (n === null) continue
      sum += n
      hit = true
    }
    if (!hit) return { ok: false, error: `钱包里没有 ${currency} 余额` }
    const total = String(Number(sum.toFixed(2)))
    return { ok: true, total, currency }
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : String(err?.message ?? err)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 查余额
// ---------------------------------------------------------------------------

async function fetchBalance(key, currency, fetchImpl, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${body.slice(0, 200)}` }
    }
    let data
    try {
      data = JSON.parse(body)
    } catch {
      return { ok: false, error: `返回不是 JSON：${body.slice(0, 200)}` }
    }
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
    if (!infos.length) return { ok: false, error: '没有 balance_infos' }
    const hit =
      infos.find((x) => String(x?.currency ?? '').toUpperCase() === currency.toUpperCase()) ?? infos[0]
    const total = String(hit?.total_balance ?? '').trim()
    if (!total) return { ok: false, error: '没取到 total_balance' }
    return { ok: true, total, currency: String(hit?.currency ?? currency) }
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : String(err?.message ?? err)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig = {}) {
  const cfg = {
    enabled: rawConfig?.enabled !== false,
    keyFile: typeof rawConfig?.keyFile === 'string' ? rawConfig.keyFile.trim() : '',
    currency: typeof rawConfig?.currency === 'string' && rawConfig.currency.trim()
      ? rawConfig.currency.trim()
      : 'CNY',
    ttlMs: Number.isFinite(Number(rawConfig?.ttlMs)) ? Number(rawConfig.ttlMs) : 15000,
    timeoutMs: Number.isFinite(Number(rawConfig?.timeoutMs)) ? Number(rawConfig.timeoutMs) : 10000,
  }

  if (!cfg.enabled) return

  const fetchImpl = typeof rawConfig?.fetchImpl === 'function' ? rawConfig.fetchImpl : globalThis.fetch
  const now = () => Date.now()

  let cached = null
  let pending = null

  async function balance() {
    if (cached && now() - cached.at < cfg.ttlMs) return cached.value
    if (pending) return pending
    pending = (async () => {
      const { key, source } = await resolveKey(ctx, cfg)
      let got
      if (key) {
        got = await fetchBalance(key, cfg.currency, fetchImpl, cfg.timeoutMs)
        if (!got.ok) got = { ...got, from: `key 来源 ${source}` }
      } else {
        // 没填 key：直接用 DSH 自己网页登录的凭据
        const token = await resolvePlatformToken(ctx)
        if (!token) {
          return {
            ok: false,
            text: '没找到 DeepSeek 凭据：在 DSH 里登录账号，或设置环境变量 DEEPSEEK_API_KEY',
          }
        }
        got = await fetchPlatformBalance(token, cfg.currency, fetchImpl, cfg.timeoutMs)
        if (!got.ok) got = { ...got, from: 'DSH 登录凭据' }
      }
      if (!got.ok) return { ok: false, text: `查余额失败（${got.from}）：${got.error}` }
      cached = { at: now(), value: got } // 缓存只存成功的结果
      return got
    })()
    try {
      return await pending
    } finally {
      pending = null
    }
  }

  const registerTools = (tools) => {
    const register = (definition) => {
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => tools.register(definition), `balance.tool.${definition.name}`)
      } else {
        tools.register(definition)
      }
    }

    register({
      name: 'deepseek_balance',
      description:
        `查 DeepSeek 账户余额，返回一个数字（${cfg.currency}，单位元），也就是当前还剩多少钱。不需要 API key，直接用 DSH 登录的账号凭据。`,
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      output: { schema: okSchema, render: textRender },
      execute: async () => {
        const got = await balance()
        if (!got.ok) return { ok: false, text: got.text }
        return { ok: true, text: got.total, count: 1 }
      },
    })
  }

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx?.tools
      if (!tools || typeof tools.register !== 'function') return
      registerTools(tools)
    })
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      cached = null
      pending = null
    }, 'balance.dispose')
  }
}

export const version = VERSION
