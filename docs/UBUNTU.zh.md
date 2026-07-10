# Ubuntu 部署

> [English](./UBUNTU.md) · [中文](./UBUNTU.zh.md)

最小化自托管部署：

```bash
sudo apt-get update
sudo apt-get install -y git curl

curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone https://github.com/JupiterTheWarlock/cultivagent.git /opt/cultivagent
cd /opt/cultivagent
npm run smoke
```

创建 `/etc/systemd/system/cultivagent.service`：

```ini
[Unit]
Description=Cultivagent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/cultivagent
Environment=HOST=127.0.0.1
Environment=PORT=3737
Environment=CULTIVAGENT_DB=/opt/cultivagent/data/cultivagent.sqlite
Environment=CULTIVAGENT_TOKEN=change-me
ExecStart=/usr/bin/node /opt/cultivagent/bin/cultivagent.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cultivagent
sudo systemctl status cultivagent
```

用 Caddy、Nginx 或 Cloudflare Tunnel 对外暴露。接收其他机器的事件前，务必先启用 `CULTIVAGENT_TOKEN`。
