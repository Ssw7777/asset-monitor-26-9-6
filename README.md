# Asset Monitor

**中文：** 安全优先、自托管、只读的加密资产看板。把多钱包链上资产、DeFi 仓位、交易所余额和手动登记资产汇总到同一个界面。

**English:** A security-first, self-hosted, read-only crypto portfolio dashboard for multi-wallet on-chain assets, DeFi positions, exchange balances and manual assets.

> 仅自用，搞着玩，DYOR。Personal use only, experimental; do your own research. Nothing here is financial advice. Never commit API keys, private keys, seed phrases or real wallet data.

## 当前 UI / Sections

保持精简的六个板块：

- **总览 / Overview** — 总资产、链上/交易所/手动拆分、净值曲线、最近变动与资金流
- **代币 / Tokens** — 多链代币持仓、价格、占比、垃圾币过滤
- **DeFi / DeFi** — 协议仓位与收益概览
- **交易所 / Exchanges** — OKX、Binance、Gate、Bitget 等只读余额
- **手动 / Manual** — 法币、线下资产等手动登记
- **地址 / Addresses** — 钱包地址增删、批量导入、暂停刷新

不包含站点的其他业务板块（Elysium LP、AGC、PRL、交易记录独立页等）。

## 快速开始 / Quick start

```bash
git clone https://github.com/Ssw7777/asset-monitor-26-9-6.git
cd asset-monitor-26-9-6/apps/web
cp .env.example .env.local
# 编辑 .env.local，至少设置 DASHBOARD_PASSWORD 和 SESSION_SECRET
pnpm install
pnpm dev
```

打开 `http://localhost:3000`。首次启动会使用演示数据；在“地址 / 手动 / 交易所”里换成自己的数据。

生产构建：

```bash
pnpm build
pnpm start
```

## 配置 / Configuration

完整变量见 [`apps/web/.env.example`](./apps/web/.env.example)。最少需要：

```bash
DASHBOARD_PASSWORD=change-me
SESSION_SECRET=replace-with-a-long-random-string
```

推荐：

```bash
ENCRYPTION_KEY=...          # 用于加密保存在数据库里的只读 CEX key
CRON_SECRET=...             # 本机 cron / systemd 调用刷新 API
```

### 交易所 API / Exchange APIs

全部使用**只读**权限，不要开启交易、提现或转账权限：

- OKX：`OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE`
- Binance：`BINANCE_API_KEY` / `BINANCE_API_SECRET`
- Gate：`GATE_API_KEY` / `GATE_API_SECRET`
- Gate B / Gate C（可选）：`GATE_B_KEY` / `GATE_B_SECRET`、`GATE_C_KEY` / `GATE_C_SECRET`
- Bitget：`BITGET_API_KEY` / `BITGET_API_SECRET` / `BITGET_API_PASSPHRASE`

### 链上数据 / On-chain providers

以下全部可选，按需申请自己的 key；不配置时对应数据源会跳过或降级：

- `ALCHEMY_API_KEY` — EVM RPC / 转账
- `ZERION_API_KEY`（或 `ZERION_API_KEYS`）— 地址仓位校准
- `COINSTATS_API_KEY` — 代币价格
- `DEBANK_ACCESS_KEY` — DeFi 仓位
- `BN_WEB3_API_KEY` / `BN_WEB3_API_SECRET` — Binance Web3 只读数据
- `OKX_WEB3_API_KEY` / `OKX_WEB3_API_SECRET` / `OKX_WEB3_PASSPHRASE` — OKX Web3 只读数据
- `OKX_ONCHAINOS_API_KEY` / `OKX_ONCHAINOS_API_SECRET` / `OKX_ONCHAINOS_API_PASSPHRASE` — OKX OnchainOS（可选）

不要把任何真实 key 写进源码、README、Issue 或提交记录。本项目只提供占位符，申请和保管 key 是使用者自己的责任。

## 数据与隐私 / Data and privacy

- 仓库不包含个人钱包地址、真实余额、API key、session 或数据库。
- `apps/web/data/store.json`、`.env*`、数据库文件和日志都在 `.gitignore` 中。
- 首次启动使用演示地址/演示余额；请通过 UI 替换。
- 服务端不托管私钥，不代签交易。
- 只读 API key 仍然属于敏感信息；请使用独立 key、最小权限和加密存储。

## 定时刷新 / Scheduled refresh

看板本身只提供 Web UI 和刷新 API，不会在后台自动持续拉数据。生产环境需要在同一台机器配置 cron / systemd，定时调用：

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3000/api/cron/refresh?mode=fast"
```

更多示例见 [`docs/scheduled-refresh.md`](./docs/scheduled-refresh.md)。

## 目录结构 / Layout

```text
apps/web/        Next.js 15 application (UI, API, tests, scripts)
docs/             scheduled refresh and operations notes
.env.example      copy into apps/web/.env.local
```

## 技术栈 / Stack

Next.js 15 · React 19 · TypeScript · Tailwind CSS · ethers v6 · Recharts · Turso/libSQL（可选）

## 说明 / Notes

- 个人实验项目，不构成投资建议。
- 第三方数据源可能限流、变更或不可用；失败时保留上一次余额，不伪造数据。
- 本仓库只做只读展示，不执行交易。
- License: MIT
