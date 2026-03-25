const path = require("node:path");

const apps = [
  {
    name: "btc-assistant",
    script: path.join(__dirname, "src/index.js"),
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "600M",
    error_file: path.join(__dirname, "logs/pm2-btc-assistant-error.log"),
    out_file: path.join(__dirname, "logs/pm2-btc-assistant-out.log"),
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: "production"
    }
  },
  {
    name: "btc-dashboard",
    script: path.join(__dirname, "src/server.js"),
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "200M",
    error_file: path.join(__dirname, "logs/pm2-btc-dashboard-error.log"),
    out_file: path.join(__dirname, "logs/pm2-btc-dashboard-out.log"),
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: "production",
      DASHBOARD_PORT: process.env.DASHBOARD_PORT || "3000"
    }
  }
];

module.exports = { apps };
