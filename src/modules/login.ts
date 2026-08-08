import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { config } from '../config.js';
import { fillAngularInput } from '../utils/fillInput.js';
import { log } from '../utils/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isLoginUrl(url: string): boolean {
  return /access\/login/i.test(url);
}

async function loginFormVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const form = document.querySelector('form[name="loginForm"]');
    if (form) return true;
    const email = document.querySelector(
      'input[type="email"], input[type="text"][placeholder*="mail" i], input[ng-model="lctrl.account.email"]',
    );
    const pass = document.querySelector('input[type="password"]');
    return Boolean(email && pass);
  });
}

async function dumpDebug(page: Page, tag: string): Promise<void> {
  try {
    const dir = path.resolve('logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `debug-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log.warn('login', `Screenshot de debug: ${file}`, { url: page.url() });
  } catch (err) {
    log.warn('login', 'Falha ao salvar screenshot de debug', err);
  }
}

/**
 * Modal Angular Material: "Ôoops! Este usuário já está conectado..."
 */
export async function dismissAlreadyConnectedModal(page: Page): Promise<boolean> {
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
      if (text === 'SIM') {
        const body = (document.body?.innerText || '').toLowerCase();
        // Só clica SIM se parece o modal de sessão duplicada (evita outros diálogos)
        if (
          body.includes('conectado') ||
          body.includes('ooops') ||
          body.includes('oops') ||
          document.querySelector('md-dialog, .md-dialog')
        ) {
          btn.click();
          return true;
        }
      }
    }
    return false;
  });

  if (clicked) {
    log.info('login', 'Modal "usuário já conectado" — clique em SIM');
    await sleep(1500);
  }
  return clicked;
}

async function isLoggedIn(page: Page): Promise<boolean> {
  if (isLoginUrl(page.url())) return false;
  if (await loginFormVisible(page)) return false;
  return page.evaluate(() => {
    const hash = window.location.hash || '';
    if (/#\/app\//i.test(hash)) return true;
    return Array.from(document.querySelectorAll('button, a')).some((b) =>
      /selecionar loja/i.test(b.textContent || ''),
    );
  });
}

/**
 * Faz login se a sessão persistente tiver expirado.
 */
export async function login(page: Page): Promise<void> {
  log.info('login', 'Verificando sessão...');

  await page.goto(`${config.baseUrl}/${config.reportHash}`, {
    waitUntil: 'domcontentloaded',
    timeout: config.navTimeoutMs,
  });

  await sleep(2000);
  await dismissAlreadyConnectedModal(page);

  await page
    .waitForFunction(
      () => {
        const hash = window.location.hash || '';
        const hasLogin = /access\/login/i.test(hash);
        const hasApp = /#\/app\//i.test(hash);
        const form = document.querySelector('form[name="loginForm"]');
        const storeBtn = Array.from(document.querySelectorAll('button')).some((b) =>
          /selecionar loja/i.test(b.textContent || ''),
        );
        return hasLogin || hasApp || Boolean(form) || storeBtn;
      },
      { timeout: config.selectorTimeoutMs },
    )
    .catch(() => undefined);

  await sleep(1000);

  if (await isLoggedIn(page)) {
    log.info('login', 'Sessão válida — login desnecessário', { url: page.url() });
    return;
  }

  log.info('login', 'Sessão expirada — realizando login');

  if (!isLoginUrl(page.url()) && !(await loginFormVisible(page))) {
    await page.goto(`${config.baseUrl}/${config.loginHash}`, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });
    await sleep(1500);
  }

  const emailSel =
    'form[name="loginForm"] input[type="text"], form[name="loginForm"] input[type="email"], input[ng-model="lctrl.account.email"], input[placeholder="E-mail"], input[type="email"]';
  const passSel =
    'form[name="loginForm"] input[type="password"], input[ng-model="lctrl.account.password"], input[type="password"]';

  try {
    await page.waitForSelector(emailSel, {
      visible: true,
      timeout: config.selectorTimeoutMs,
    });
  } catch {
    await dumpDebug(page, 'no-login-form');
    throw new Error(
      `login: formulário de login não apareceu (url=${page.url()}). ` +
        'Verifique se conta.saipos.com está acessível.',
    );
  }

  await fillAngularInput(page, emailSel, config.email);
  await fillAngularInput(page, passSel, config.password);
  log.info('login', 'Credenciais preenchidas (Angular-compatible)');

  // O submit do Saipos é o botão circular vermelho (md-fab) ao lado do card
  const submitted = await page.evaluate(() => {
    const form = document.querySelector('form[name="loginForm"]') as HTMLFormElement | null;
    const candidates: Array<Element | null | undefined> = [
      document.querySelector('button.md-fab'),
      document.querySelector('button[ng-click*="lctrl.login"]'),
      form?.querySelector('button[type="submit"]'),
      form?.querySelector('button[ng-click*="login"]'),
      ...Array.from(document.querySelectorAll('button')).filter((b) =>
        /entrar|login/i.test(b.textContent || ''),
      ),
    ];
    for (const btn of candidates) {
      if (btn instanceof HTMLElement) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!submitted) {
    log.warn('login', 'Botão submit não encontrado — enviando Enter');
    await page.keyboard.press('Enter');
  } else {
    log.info('login', 'Submit clicado');
  }

  // Poll: modal SIM / saída do login
  const deadline = Date.now() + config.navTimeoutMs;
  while (Date.now() < deadline) {
    await dismissAlreadyConnectedModal(page);
    if (await isLoggedIn(page)) {
      log.info('login', 'Login concluído', { url: page.url() });
      return;
    }

    const errText = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      if (/e-mail ou senha inv[aá]lidos/i.test(body)) {
        return 'E-mail ou senha inválidos';
      }
      const candidates = Array.from(
        document.querySelectorAll('.alert, .error, .md-toast-content, [class*="error"]'),
      );
      return candidates
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(' | ');
    });

    if (errText && /senha inv[aá]lida|inv[aá]lidos|credencial/i.test(errText)) {
      await dumpDebug(page, 'login-invalid');
      throw new Error(
        `login: Saipos rejeitou as credenciais ("${errText}"). ` +
          'Atualize SAIPOS_EMAIL / SAIPOS_PASSWORD no .env e tente de novo.',
      );
    }
    if (errText) {
      log.warn('login', `Mensagem na tela: ${errText}`);
    }

    await sleep(1000);
  }

  await dumpDebug(page, 'login-timeout');
  throw new Error(
    `login: timeout aguardando sair da tela de login (url=${page.url()}). ` +
      'Possíveis causas: credenciais inválidas, modal bloqueando, ou mudança no fluxo Saipos. ' +
      'Veja screenshot em logs/.',
  );
}
