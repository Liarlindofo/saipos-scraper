import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  email: process.env.SAIPOS_EMAIL ?? '',
  password: process.env.SAIPOS_PASSWORD ?? '',
  port: intEnv('PORT', 4001),
  host: process.env.HOST ?? '127.0.0.1',
  headless: boolEnv('HEADLESS', true),
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  userDataDir: path.resolve(
    process.env.USER_DATA_DIR ?? path.resolve(__dirname, '../browser-data'),
  ),
  navTimeoutMs: intEnv('NAV_TIMEOUT_MS', 60_000),
  selectorTimeoutMs: intEnv('SELECTOR_TIMEOUT_MS', 45_000),
  baseUrl: 'https://conta.saipos.com',
  loginHash: '#/access/login',
  reportHash: '#/app/report/sales-by-period',
};

export function assertCredentials(): void {
  if (!config.email || !config.password) {
    throw new Error(
      'SAIPOS_EMAIL e SAIPOS_PASSWORD são obrigatórios no .env',
    );
  }
}
