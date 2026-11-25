# dsh-whale-balance

给 DeepSeek Harness 加一个工具 `deepseek_balance`，让模型自己就能查账户余额，返回一个数字（默认人民币，单位元）。

装好之后**不用填任何 key**：只要你在 DSH 里登录过 DeepSeek 账号，插件直接复用那份登录凭据。

## 它怎么取数

| 顺序 | 来源 | 接口 |
| --- | --- | --- |
| 1 | 环境变量 `DEEPSEEK_API_KEY`（sk- 开头） | `GET https://api.deepseek.com/user/balance` |
| 2 | DSH credentials 里的 `DEEPSEEK_API_KEY` | 同上 |
| 3 | `~/.dsh/deepseek-api-key.txt`（一行纯文本） | 同上 |
| 4 | DSH 自己网页登录的 grant（`deepseek-account-platform/default`） | `GET https://platform.deepseek.com/api/v0/users/get_user_summary`，头 `x-dsh-auth-token` |

第 4 条是默认路径：取 `normal_wallets` + `bonus_wallets` 里对应币种的 `balance` 相加，保留两位小数。
前三条只是给「手上正好有 API key」的人用的。

## 安装

在 profile 的 `package.json` 里加依赖和 bundle：

```json
{
  "dependencies": { "dsh-whale-balance": "file:D:/path/to/dsh-whale-balance" },
  "dsh": { "profile": { "bundles": ["dsh-whale-balance"] } }
}
```

然后重载 DSH。插件自带 `cordis.patch.yml`，会自动挂进插件树。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉就整个插件不注册 |
| `currency` | `CNY` | 要查哪个币种的钱包 |
| `ttlMs` | `15000` | 成功结果缓存多久（毫秒），失败不缓存 |
| `timeoutMs` | `10000` | 单次请求超时 |
| `keyFile` | `''` | 额外指定一个 key 文件路径 |

## 想喂白饭的话

包里带一个 `sponsors.json`：`channels` 放微信/支付宝收款码图片，`tiers` 是六个价位和它们对应的白话（1/5/10/20/50/100）。
删掉文件就不显示，留空也不影响插件本身。作者自己的码放在包根目录（`sponsor-wechat.png`、`sponsor-alipay.png`）。

## 打包了哪些文件

`lib/`（代码）、`cordis.patch.yml`（挂载点）、`README.md`、`icon.png`（插件图标）、`sponsors.json` + 两张收款码。

## 说明

- 只读，不会花你一分钱，也不会改账号资料。
- 余额数字来自官方接口，跟你充值页面看到的一致（可能有几分钟延迟）。
- 拿到的是网页登录凭据，插件只在本地读完直接请求，不上报任何地方。

MIT
