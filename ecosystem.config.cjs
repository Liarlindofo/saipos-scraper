/**
 * Processo PM2 separado do WPPConnect e do Plateful.
 * Na VPS: pm2 start ecosystem.config.cjs
 * Path sugerido: /var/www/saipos-scraper
 */
module.exports = {
  apps: [
    {
      name: 'saipos-scraper',
      cwd: __dirname,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      // Bind interno — o .env define HOST=127.0.0.1 e PORT=4001
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
