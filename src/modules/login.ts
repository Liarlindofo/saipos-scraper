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

const SIM_CONFIRM_TIMEOUT_MS = 7000;

type SimButtonCenter = { x: number; y: number };

/** Localiza o botão SIM do modal de sessão duplicada (sem clicar). */
async function findAlreadyConnectedSimCenter(page: Page): Promise<SimButtonCenter | null> {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    const hasDialog = Boolean(document.querySelector('md-dialog, .md-dialog, md-dialog-content'));
    const bodyLower = body.toLowerCase();
    const looksLikeModal =
      bodyLower.includes('conectado') ||
      bodyLower.includes('ooops') ||
      bodyLower.includes('oops') ||
      hasDialog;
    if (!looksLikeModal) return null;

    const candidates = Array.from(
      document.querySelectorAll(
        'md-dialog button, .md-dialog button, md-dialog-actions button, button.md-primary, button',
      ),
    );
    for (const btn of candidates) {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
      if (text !== 'SIM') continue;
      const rect = (btn as HTMLElement).getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  });
}

/** True enquanto o modal de sessão duplicada ainda parece presente no DOM. */
async function alreadyConnectedModalPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const body = (document.body?.innerText || '').toLowerCase();
    const hasSim = Array.from(
      document.querySelectorAll('md-dialog button, .md-dialog button, button'),
    ).some((b) => (b.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase() === 'SIM');
    if (!hasSim) return false;
    return (
      body.includes('já está conectado') ||
      body.includes('ja esta conectado') ||
      body.includes('já esta conectado') ||
      ((body.includes('conectado') || body.includes('ooops') || body.includes('oops')) &&
        Boolean(document.querySelector('md-dialog, .md-dialog')))
    );
  });
}

/**
 * Aguarda o modal sumir ou a URL sair de /access/login (~5–8s).
 */
async function waitForSimDismissConfirmation(
  page: Page,
  timeoutMs: number,
): Promise<{ confirmed: boolean; reason: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isLoginUrl(page.url())) {
      return { confirmed: true, reason: 'url_left_login' };
    }
    if (!(await alreadyConnectedModalPresent(page))) {
      return { confirmed: true, reason: 'modal_gone' };
    }
    await sleep(250);
  }
  return {
    confirmed: false,
    reason: isLoginUrl(page.url()) ? 'still_on_login_and_modal' : 'timeout',
  };
}

/** Clique 1: DOM click no botão SIM (Angular Material). */
async function clickSimDom(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    const hasDialog = Boolean(document.querySelector('md-dialog, .md-dialog, md-dialog-content'));
    const bodyLower = body.toLowerCase();
    const looksLikeModal =
      bodyLower.includes('conectado') ||
      bodyLower.includes('ooops') ||
      bodyLower.includes('oops') ||
      hasDialog;
    if (!looksLikeModal) return false;

    const candidates = Array.from(
      document.querySelectorAll(
        'md-dialog button, .md-dialog button, md-dialog-actions button, button.md-primary, button',
      ),
    );
    for (const btn of candidates) {
      const text = (btn.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
      if (text !== 'SIM') continue;
      (btn as HTMLElement).click();
      return true;
    }
    return false;
  });
}

/** Clique 2: mouse no centro do botão (coordenadas viewport). */
async function clickSimByCoordinates(page: Page): Promise<boolean> {
  const center = await findAlreadyConnectedSimCenter(page);
  if (!center) {
    // Fallback: seletor md-dialog + filter text
    const handles = await page.$$('md-dialog button, .md-dialog button, md-dialog-actions button');
    for (const handle of handles) {
      const text = await handle.evaluate((el) =>
        (el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase(),
      );
      if (text === 'SIM') {
        const box = await handle.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          return true;
        }
        await handle.click({ delay: 50 });
        return true;
      }
    }
    return false;
  }
  await page.mouse.click(center.x, center.y, { delay: 50 });
  return true;
}

/**
 * Modal Angular Material: "Ôoops! Este usuário já está conectado..."
 * Clica SIM, confirma sumiço/navegação, e tenta 2ª abordagem se falhar.
 */
export async function dismissAlreadyConnectedModal(page: Page): Promise<boolean> {
  const center = await findAlreadyConnectedSimCenter(page);
  if (!center) return false;

  // --- Tentativa 1: click DOM ---
  log.info('login', 'Modal "usuário já conectado" — clique em SIM');
  const clicked1 = await clickSimDom(page);
  if (!clicked1) {
    log.warn('login', 'Modal "usuário já conectado" — botão SIM sumiu antes do clique DOM');
    return false;
  }

  await dumpDebug(page, 'after-sim-click');

  let confirm = await waitForSimDismissConfirmation(page, SIM_CONFIRM_TIMEOUT_MS);
  if (confirm.confirmed) {
    log.info('login', 'Modal "usuário já conectado" — confirmação OK após clique SIM', {
      reason: confirm.reason,
      url: page.url(),
      attempt: 1,
    });
    return true;
  }

  log.warn('login', 'Modal "usuário já conectado" — clique SIM NÃO confirmado', {
    reason: confirm.reason,
    url: page.url(),
    attempt: 1,
    timeoutMs: SIM_CONFIRM_TIMEOUT_MS,
  });

  // --- Tentativa 2: clique por coordenadas / seletor md-dialog ---
  if (!(await alreadyConnectedModalPresent(page))) {
    log.info('login', 'Modal "usuário já conectado" — modal sumiu entre tentativas', {
      url: page.url(),
    });
    return true;
  }

  log.info(
    'login',
    'Modal "usuário já conectado" — retry: clique via coordenadas do centro do botão',
  );
  const clicked2 = await clickSimByCoordinates(page);
  if (!clicked2) {
    log.warn('login', 'Modal "usuário já conectado" — retry falhou: botão SIM não encontrado');
    await dumpDebug(page, 'after-sim-click-retry-miss');
    return false;
  }

  await dumpDebug(page, 'after-sim-click-retry');

  confirm = await waitForSimDismissConfirmation(page, SIM_CONFIRM_TIMEOUT_MS);
  if (confirm.confirmed) {
    log.info('login', 'Modal "usuário já conectado" — confirmação OK após retry', {
      reason: confirm.reason,
      url: page.url(),
      attempt: 2,
    });
    return true;
  }

  log.warn('login', 'Modal "usuário já conectado" — retry também NÃO confirmou', {
    reason: confirm.reason,
    url: page.url(),
    attempt: 2,
    timeoutMs: SIM_CONFIRM_TIMEOUT_MS,
  });
  return false;
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
