# 定时刷新指南（自托管 / VPS）

看板**不会**在进程内按墙钟自动刷新全部资产。它只提供鉴权后的刷新入口；你必须在**同一台服务器**上用 cron 或 systemd timer 周期性调用它。

> 本项目推荐方案：**纯 VPS 本地定时**（`127.0.0.1` + `CRON_SECRET`）。不依赖任何外部云闹钟仓库。

## 为什么必须配定时器？

- 只部署网页、不配定时器时：UI 能打开、能登录，但钱包 / CEX / DeFi **不会自动更新**
- 把「何时刷新」放在宿主机 systemd/cron，稳定、免费、不吃第三方额度

## 刷新 API

```http
POST /api/cron/refresh?mode=auto
Authorization: Bearer <CRON_SECRET>
```

常用查询参数：

| 参数 | 说明 |
|---|---|
| `mode=auto` | 常规增量 / 自适应刷新（推荐定时任务） |
| `mode=fast` | 较快一轮（适合 30s–1min 高频本地钟） |
| `mode=full` | 更完整的一轮（耗时更长，可偶尔手动跑） |
| `walletBudget` | 可选，限制本轮处理的钱包数量 |

成功时响应 JSON 大致包含 `ok`、`refreshStatus`（如 `ok` / `partial`）等。若已有刷新在跑，可能返回 `ran=skipped` / `reason=refresh_in_progress`（正常）。

也可用已登录 Session 在浏览器内手动触发；生产自动化请用 `CRON_SECRET`。

## 鉴权：`CRON_SECRET`

看板环境：

```bash
CRON_SECRET=generate-a-long-random-string
```

同机调用示例：

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3000/api/cron/refresh?mode=auto"
```

把 `CRON_SECRET` 放进受保护的环境文件（权限 `600`），**不要**写进公开 Git。

> 代码里仍保留可选的第三方 OIDC 校验字段，便于高级用户自建；**默认文档与示例一律走本机 `CRON_SECRET`，不必配置 OIDC。**

## 方案 A：systemd timer（推荐）

仓库提供脱敏示例：

| 文件 | 用途 |
|---|---|
| [examples/cron-refresh.sh](./examples/cron-refresh.sh) | 调用刷新 API 的 shell |
| [examples/dashboard-refresh.service](./examples/dashboard-refresh.service) | systemd oneshot |
| [examples/dashboard-refresh.timer](./examples/dashboard-refresh.timer) | 周期触发（默认约每分钟） |

安装步骤（路径可按你的机器调整）：

```bash
sudo install -m 0755 docs/examples/cron-refresh.sh /usr/local/bin/dashboard-cron-refresh.sh
sudo install -m 0644 docs/examples/dashboard-refresh.service /etc/systemd/system/
sudo install -m 0644 docs/examples/dashboard-refresh.timer /etc/systemd/system/

# 仅本机可达的看板地址 + 与看板相同的 CRON_SECRET
sudo tee /etc/dashboard-refresh.env >/dev/null <<'ENV'
CRON_SECRET=replace-me
DASHBOARD_URL=http://127.0.0.1:3000
ENV
sudo chmod 600 /etc/dashboard-refresh.env

sudo systemctl daemon-reload
sudo systemctl enable --now dashboard-refresh.timer
systemctl list-timers dashboard-refresh.timer
```

调试验收：

```bash
sudo systemctl start dashboard-refresh.service
journalctl -u dashboard-refresh.service -n 20 --no-pager
```

期望：HTTP 2xx，JSON 含 `ok: true`（或 `ran=skipped` 表示上一轮还在跑）。

## 方案 B：crontab

```bash
* * * * * CRON_SECRET=... DASHBOARD_URL=http://127.0.0.1:3000 \
  /usr/local/bin/dashboard-cron-refresh.sh >>/var/log/dashboard-refresh.log 2>&1
```

或把变量放进 `/etc/dashboard-refresh.env`，脚本里 `source` 后再 curl。

## 高频刷新提示

- 单机 VPS 可把 timer 设到 **30s–2min**；接口会跳过进行中的刷新，不必担心叠爆
- 钱包总额走币安 Web3，Rabby 只做每日对账。定时器仍按大约 3 个钱包 / 90 秒轮转；上游限流时保留上次成功余额。
- 反向代理只暴露 UI；定时器继续打 `127.0.0.1`，避免把 `CRON_SECRET` 打到公网

## 验收清单

1. 手动 `curl` 带正确 Bearer → 2xx 且 `ok` / `partial` / 或 `refresh_in_progress`
2. 故意错误 Secret → 401 / 403
3. `systemctl list-timers`（或 crontab）显示定时器在跑，看板快照时间持续推进
4. 公开 Git 历史中无真实域名、IP、Key、钱包地址

## wallet-batch 熔断与冷却

完整示例脚本 `docs/examples/vps-refresh-cron.sh` 在本地 `wallet-batch` 连续失败达到阈值后会短暂熔断；**冷却约 15 分钟后自动复位重试**，避免某一轮限流把刷新停死整天。

应用侧同时：优先刷新「最久未尝试」的地址（避免单个限流地址霸占预算），并在提供商限流时保留上次成功余额并推进新鲜度时间戳。
