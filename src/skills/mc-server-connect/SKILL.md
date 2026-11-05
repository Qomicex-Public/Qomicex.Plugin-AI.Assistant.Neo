---
name: mc-server-connect
description: 联机开房与服务器连接排查：NAT/端口、版本与模组对齐、局域网/在线房间的固定流程
whenToUse: 用户要「和朋友联机 / 开个房间 / 连不上服务器 / 进服被踢」时
version: 1
---

# 联机与服务器连接

目标：先确定联机方式，再逐层排查 **地址 → 端口/NAT → 版本 → 模组 → 账户/白名单**。不要一上来就让人关防火墙。

## 1. 确定联机方式

| 方式 | 适用 | 入口 |
| --- | --- | --- |
| 启动器在线房间（Connector） | 朋友之间、无公网 IP | `hostRoom` / `joinRoom` |
| 局域网（LAN） | 同一路由器下 | 游戏内「对局域网开放」 |
| 专用服务器 | 长期、多人 | `server.properties` + 服务端 |
| 第三方面板服 | 托管 | 面板给的地址/端口 |

## 2. 开房（主机侧）

1. `getConnectorStatus()` — 连接器是否就绪。
2. `getNatType()` — NAT 类型。
3. `hostRoom({ instanceId })` 或 `hostRoom({ port })`。
4. 把返回的房间码/端口发给朋友；让对方用 `joinRoom({ code })`。
5. 主机必须保持游戏与启动器运行；主机退出房间即解散。

### NAT 知识要点

- `easy` / `normal`：通常可直连或自动打洞。
- `hard` / `symmetric`（对称 NAT）：打洞成功率低，需要中继/端口映射。
- 公司/校园网、双重 NAT、运营商 CGNAT 常导致失败；此时换中继或让一方用手机热点测试。

## 3. 加入（客户端侧）

1. `joinRoom({ code })` — 在线房间。
2. 或 `addServer({ instanceId, name, ip })` 添加到服务器列表。
3. `pingServer({ instanceId, address })` — 看延迟/在线状态。
4. `listServers(instanceId)` — 核对地址是否写错。

## 4. 排查顺序（固定，不要跳步）

1. **地址/端口**：`host:port`，默认 `25565`；不要带 `http://`。
2. **服务端是否在跑**：面板/主机确认进程；`pingServer` 无响应先查这个。
3. **版本一致**：客户端与服务端 MC 版本必须完全一致。
4. **模组一致**：服务端需要的模组客户端也要有；客户端专属模组（小地图/HUD/光影）不要装服务端。
5. **账户/验证**：正版验证、白名单、封禁列表；`online-mode` 与登录方式要匹配。
6. **网络/NAT**：见上表；对称 NAT 换中继。
7. **防火墙**：只放行必要端口（TCP 25565，部分连接器还需 UDP），不要整段关闭防火墙。
8. **服务端日志**：看 `latest.log` 的 `Disconnect`、`mismatched mod channel`、`Incompatible mod set`。

## 5. 常见错误对照

| 提示 | 含义 | 处理 |
| --- | --- | --- |
| `Connection refused` | 地址/端口不对或服务端没开 | 核对端口、启动服务端 |
| `Connection timed out` | 网络/NAT/防火墙 | 换网络、查 NAT、放行端口 |
| `Incompatible mod set` | 模组列表不一致 | 两端对齐 mods |
| `Mismatched mod channel` | 模组版本不同 | 统一版本 |
| `You are not whitelisted` | 白名单 | 服务端加白名单 |
| `Failed to verify username` | 正版验证/登录 | 检查账户与 online-mode |
| `Internal Exception: io.netty...` | 协议/版本不匹配 | 对齐版本与加载器 |

## 6. 安全边界

- 不索要或记录用户的账号密码、正版令牌、RCON 密码。
- 公网开服时提醒：不要用弱密码/默认 RCON，不要把管理端口直接暴露。
- 修改 `server.properties` 前先备份，并说明每项影响。
- 不替用户关闭杀毒/防火墙；只给出精确的放行建议。

## 输出格式

```md
**联机方式**：Connector / LAN / 专用服务器
**主机**：房间码或 host:port；NAT 类型
**卡点**：地址 / 版本 / 模组 / NAT / 白名单
**证据**：ping 结果或服务端日志关键行
**下一步**：具体到「谁改什么」
```
