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
    name: "markets-sim",
    script: path.join(__dirname, "src/markets/runner.js"),
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "400M",
    error_file: path.join(__dirname, "logs/pm2-markets-sim-error.log"),
    out_file: path.join(__dirname, "logs/pm2-markets-sim-out.log"),
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: "production"
    }
  },
  {
    name: "weather-sim",
    script: path.join(__dirname, "src/weather/runner.js"),
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    kill_timeout: 10000,
    error_file: path.join(__dirname, "logs/pm2-weather-sim-error.log"),
    out_file: path.join(__dirname, "logs/pm2-weather-sim-out.log"),
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
