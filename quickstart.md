# EC2 quickstart (headless / background)

Run the Polymarket BTC assistant on an **Ubuntu 22.04 LTS** (or 24.04) EC2 instance under **PM2** so it survives SSH disconnects and can restart on reboot.

Assumptions:

- You can SSH to the instance as `ubuntu` (Ubuntu AMI) or your chosen user.
- Outbound HTTPS/WSS is allowed (default in most VPCs).

---

## 1) EC2 before you SSH

1. **AMI:** Ubuntu Server 22.04 LTS (64-bit x86) or arm64 if you use Graviton.
2. **Instance type:** `t3.small` or larger is usually enough for Node + WS traffic.
3. **Storage:** 20 GiB gp3 is a comfortable default.
4. **Security group**
   - **Inbound:** TCP `22` from **your IP only** (SSH).
   - **Optional:** TCP `3000` from your IP if you want the dashboard (`src/server.js`) reachable without an SSH tunnel. The dashboard binds to `127.0.0.1` by default (`DASHBOARD_HOST`), so the SSH tunnel below is the recommended way in. If you set `DASHBOARD_HOST=0.0.0.0`, never open `3000` to `0.0.0.0/0` and set `DASHBOARD_SECRET`.

---

## 2) SSH in

Replace the host with your instance’s public DNS or IP.

```bash
ssh -i /path/to/your-key.pem ubuntu@ec2-xx-xx-xx-xx.compute-1.amazonaws.com
```

---

## 3) System packages and Node.js 20

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential
```

Install **Node.js 20.x** (project requires Node **18+**):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

---

## 4) Clone the repo and install dependencies

Use your fork or this repository URL.

```bash
cd ~
git clone https://github.com/FrondEnt/PolymarketBTC15mAssistant.git
cd PolymarketBTC15mAssistant
npm install
mkdir -p logs
```

---

## 5) Environment file

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Fill at least:

- Nothing is required for paper trading. See `.env.example` for simulation, learning and (optional) live-trading settings.
- For live trading: **`PRIVATE_KEY`**, **`POLYMARKET_FUNDER_ADDRESS`**, **`ENABLE_LIVE_TRADING=true`** — see `README.md` and `.env.example`.

The app loads `.env` via `import "dotenv/config"` in `src/index.js` and `src/server.js`, so you do **not** need to `export` variables manually when using PM2 with `cwd` set to the project root (as in `ecosystem.config.cjs`).

**Headless tip:** if the console UI misbehaves over SSH, set:

```bash
QUIET_CONSOLE=true
```

in `.env`.

---

## 6) Install PM2 globally (recommended for `startup` + `save`)

Local PM2 from `npm install` works for `npm run pm2:start`, but **restart on reboot** is simplest with a global `pm2` on your `PATH`:

```bash
sudo npm install -g pm2
```

---

## 7) Start the bot and dashboard in the background

From the project directory:

```bash
cd ~/PolymarketBTC15mAssistant
pm2 start ecosystem.config.cjs
```

This starts:

- **`btc-assistant`** — main bot (`src/index.js`)
- **`btc-dashboard`** — HTTP dashboard on port **`DASHBOARD_PORT`** (default `3000`)

Useful commands:

```bash
pm2 status
pm2 logs
pm2 logs btc-assistant
pm2 logs btc-dashboard
pm2 restart all
pm2 stop all
```

Log files are also written under `logs/` per `ecosystem.config.cjs` (e.g. `logs/pm2-btc-assistant-out.log`).

---

## 8) Survive reboot: PM2 startup

Still in the project (or any directory), run **once** per machine:

```bash
pm2 save
pm2 startup systemd
```

The last command prints a **`sudo env PATH=...`** line — **copy and run that exact line**, then:

```bash
pm2 save
```

After the next reboot, PM2 should restore `btc-assistant` and `btc-dashboard`.

---

## 9) Optional: open the dashboard only on localhost + SSH tunnel

If you did **not** open port `3000` in the security group, browse the dashboard from your laptop:

```bash
ssh -i /path/to/your-key.pem -L 3000:127.0.0.1:3000 ubuntu@ec2-xx-xx-xx-xx.compute-1.amazonaws.com
```

Then open **http://127.0.0.1:3000** in your local browser. The dashboard listens on **`127.0.0.1`** by default, so it is only reachable through this tunnel unless you change `DASHBOARD_HOST`.

---

## 10) Deploy updates

```bash
cd ~/PolymarketBTC15mAssistant
git pull
npm install
pm2 restart all
```

---

## Alternative: single process with `nohup` (no PM2)

If you only want the **assistant** (no dashboard) without PM2:

```bash
cd ~/PolymarketBTC15mAssistant
nohup npm start > logs/nohup-assistant.log 2>&1 &
echo $! > logs/nohup-assistant.pid
```

Stop later:

```bash
kill "$(cat logs/nohup-assistant.pid)"
```

`nohup` does not auto-restart on crash or reboot; prefer PM2 for production.

---

## Optional: `ufw` host firewall (Ubuntu)

If you use `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow from YOUR.HOME.IP.ADDR to any port 3000 proto tcp
sudo ufw enable
sudo ufw status
```

Adjust or omit the `3000` rule if you use SSH tunneling only.
