/**
 * PM2 cluster configuration for multi-core scaling.
 * Run with: pm2 start ecosystem.config.cjs
 * NOTE: sticky sessions are required for WebSocket upgrades across workers.
 */
module.exports = {
  apps: [
    {
      name: "webproxy",
      script: "./dist/server.js",
      instances: "max",
      exec_mode: "cluster",
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
    },
  ],
};
