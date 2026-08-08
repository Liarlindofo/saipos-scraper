import express from 'express';
import { assertCredentials, config } from './config.js';
import { closeBrowser, clearChromiumLocks } from './browser.js';
import { scrapeReport } from './scrapeReport.js';
import type { ScrapeRequest } from './types.js';
import { log } from './utils/logger.js';

assertCredentials();
clearChromiumLocks();

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'saipos-scraper' });
});

app.post('/scrape', async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body as ScrapeRequest;
    log.info('http', 'POST /scrape', {
      data: body?.data,
      escopoLoja: body?.escopoLoja,
      lojas: body?.lojas,
      campos: body?.campos?.map((c) => c.key),
    });

    const result = await scrapeReport(body);
    log.info('http', `POST /scrape OK em ${Date.now() - started}ms`);
    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('http', `POST /scrape FALHOU em ${Date.now() - started}ms: ${message}`);
    res.status(500).json({ erro: message });
  }
});

const server = app.listen(config.port, config.host, () => {
  log.info(
    'server',
    `saipos-scraper ouvindo em http://${config.host}:${config.port} (headless=${config.headless})`,
  );
});

async function shutdown(signal: string): Promise<void> {
  log.info('server', `Recebido ${signal} — encerrando`);
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
