# 桌游大厅中转服务

将本目录内的 `server.js`、`package.json`、`package-lock.json`、`render.yaml` 放在 GitHub 仓库根目录，在 Render 中选择 **New → Blueprint** 并连接仓库即可部署。

手动选择 Web Service 时：Node 运行环境；构建命令 `npm ci`；启动命令 `npm start`；健康检查 `/health`；设置一个长期保持不变的随机环境变量 `RELAY_SECRET`。不要选择 Static Site，也不要启用多实例扩容。

部署后，将 `https://你的服务.onrender.com` 填入桌游大厅“设置 → 联机”的中转服务地址。玩家使用同一版本大厅，通过完整邀请或房间码加入。Render 的 HTTPS/WSS 由平台提供，无需开放额外端口。

中转支持预留 AI 席位（`/health` 的 `features` 包含 `reserved-ai-seats`）：创建房间时指定的 AI 席位不接受玩家加入，重连恢复会保留这些预留席位。所有席位仍计入房间总人数。

加入房间只比较大厅版本号与游戏版本号：创建房间时上报的大厅版本号（旧版大厅不上报，则跳过该项）与 `versions[游戏id]` 中的游戏版本号都一致才允许加入。中转不读取游戏文件，因此大厅或游戏作者只需在发布时提升 `package.json` / `boardgame-mod.json` 的 `version`。

`select-seat` 表示支持指定空闲玩家席位。房主读取联机存档时会创建新的等待房间，朋友可选择原席位加入；已占用或预留给 AI 的席位会被拒绝。大厅会将每位玩家已隐藏私人信息的视图以增量消息同步，中转按原样转发，无需保存游戏状态。

本服务只负责消息中转，不能单独作为游戏网页使用。规则、AI 和存档在房主电脑执行；房主需运行桌游大厅。密钥不要放入仓库或发给玩家。服务重启后，房主会使用签名凭证重新注册房间，其他玩家恢复原席位。

本机调试：`npm ci` 后运行 `npm start`，默认端口 10000；可通过 `PORT` 更改。在大厅填写 `http://127.0.0.1:10000`。

免费 Render 服务有休眠和用量限制，仅建议先验证功能。官方文档：<https://render.com/docs/free>。
