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

async function dumpDebug(page: Page, tag: string): Promise<string | null> {
  try {
    const dir = path.resolve('logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `debug-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log.warn('login', `Screenshot de debug: ${file}`, { url: page.url() });
    return file;
  } catch (err) {
    log.warn('login', 'Falha ao salvar screenshot de debug', err);
    return null;
  }
}

const SIM_CONFIRM_TIMEOUT_MS = 9000;

type ModalDump = {
  present: boolean;
  dialogSelector: string;
  dialogText: string;
  dialogHtml: string;
  simButtons: Array<{
    text: string;
    className: string;
    ngClick: string;
    disabled: boolean;
    visible: boolean;
    x: number;
    y: number;
    w: number;
    h: number;
    outerHTML: string;
  }>;
};

/** Inspecta o modal de sessão duplicada (HTML + botões SIM). */
async function dumpAlreadyConnectedModal(page: Page): Promise<ModalDump> {
  return page.evaluate(() => {
    // SweetAlert / Bootstrap confirm (Saipos real) OU Angular Material
    const dialogCandidates = [
      document.querySelector('.sweet-alert') as HTMLElement | null,
      document.querySelector('.sweet-alert.showSweetAlert') as HTMLElement | null,
      document.querySelector('.sa-confirm-button-container')?.closest(
        '.sweet-alert, .sa-button-container, div',
      ) as HTMLElement | null,
      document.querySelector('md-dialog') as HTMLElement | null,
      document.querySelector('.md-dialog') as HTMLElement | null,
      document.querySelector('[class*="md-dialog"]') as HTMLElement | null,
      document.querySelector('md-dialog-content') as HTMLElement | null,
    ].filter(Boolean) as HTMLElement[];

    let dialog = dialogCandidates[0] || null;

    // Se só achamos o botão .confirm "Sim", sobe até o container do alerta
    if (!dialog) {
      const confirmBtn = Array.from(document.querySelectorAll('button.confirm, button')).find(
        (b) => (b.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase() === 'SIM',
      ) as HTMLElement | undefined;
      if (confirmBtn) {
        let el: HTMLElement | null = confirmBtn;
        for (let i = 0; i < 8 && el; i++) {
          const cls = String(el.className || '').toLowerCase();
          if (
            cls.includes('sweet-alert') ||
            cls.includes('swal') ||
            cls.includes('modal') ||
            cls.includes('dialog') ||
            el.getAttribute('role') === 'dialog'
          ) {
            dialog = el;
            break;
          }
          el = el.parentElement;
        }
        if (!dialog && confirmBtn.parentElement) {
          // sobe 3 níveis como fallback (sa-button-container → sweet-alert)
          dialog =
            confirmBtn.closest('.sweet-alert, .swal2-popup, .modal, [role="dialog"]') ||
            confirmBtn.parentElement?.parentElement?.parentElement ||
            confirmBtn.parentElement;
        }
      }
    }

    const body = (document.body?.innerText || '').toLowerCase();
    const looksLike =
      Boolean(dialog) ||
      body.includes('conectado') ||
      body.includes('ooops') ||
      body.includes('oops') ||
      Boolean(document.querySelector('button.confirm'));

    const root: ParentNode = dialog || document;
    const buttons = Array.from(root.querySelectorAll('button, md-button, [role="button"]'));
    const simButtons = buttons
      .filter((b) => {
        const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
        return t === 'SIM' || /^SIM\b/.test(t);
      })
      .map((b) => {
        const el = b as HTMLElement;
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          className: String(el.className || ''),
          ngClick: el.getAttribute('ng-click') || '',
          disabled: Boolean((el as HTMLButtonElement).disabled) || el.getAttribute('disabled') !== null,
          visible: rect.width > 0 && rect.height > 0,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          w: rect.width,
          h: rect.height,
          outerHTML: el.outerHTML.slice(0, 2000),
        };
      });

    const dialogText = dialog
      ? (dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
      : '';
    const dialogHtml = dialog ? dialog.outerHTML.slice(0, 8000) : '';

    return {
      present: looksLike && (Boolean(dialog) || simButtons.length > 0),
      dialogSelector: dialog
        ? dialog.tagName.toLowerCase() +
          (dialog.className ? `.${String(dialog.className).split(/\s+/).slice(0, 3).join('.')}` : '')
        : '',
      dialogText,
      dialogHtml,
      simButtons,
    };
  });
}

/** True enquanto o modal de sessão duplicada ainda parece presente no DOM. */
async function alreadyConnectedModalPresent(page: Page): Promise<boolean> {
  const dump = await dumpAlreadyConnectedModal(page);
  if (!dump.present) return false;
  const text = `${dump.dialogText} ${(await page.evaluate(() => document.body?.innerText || ''))}`.toLowerCase();
  const hasSim = dump.simButtons.some((b) => b.text.toUpperCase().includes('SIM') && b.visible);
  return (
    hasSim &&
    (text.includes('conectado') ||
      text.includes('ooops') ||
      text.includes('oops') ||
      Boolean(dump.dialogHtml))
  );
}

/**
 * Aguarda (a) modal sumir do DOM ou (b) URL sair de /access/login (~8–10s).
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
  const stillModal = await alreadyConnectedModalPresent(page);
  return {
    confirmed: false,
    reason: stillModal
      ? 'neither_modal_gone_nor_url_changed'
      : 'timeout_ambiguous',
  };
}

/** Clique 1: DOM/JS click no botão SIM (SweetAlert `.confirm` ou md-dialog). */
async function clickSimDom(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isSim = (el: Element): boolean => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
      const spanSim = Array.from(el.querySelectorAll('span')).some(
        (s) => (s.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase() === 'SIM',
      );
      return text === 'SIM' || spanSim;
    };

    // Preferência: SweetAlert real do Saipos
    const sweetConfirm = document.querySelector(
      '.sweet-alert button.confirm, .sweet-alert.showSweetAlert button.confirm, button.confirm.btn-warning',
    );
    if (sweetConfirm && isSim(sweetConfirm)) {
      (sweetConfirm as HTMLElement).click();
      return true;
    }

    const roots: ParentNode[] = [
      document.querySelector('.sweet-alert') ||
        document.querySelector('md-dialog') ||
        document.querySelector('.md-dialog') ||
        document.querySelector('[class*="md-dialog"]') ||
        document,
    ];

    for (const root of roots) {
      for (const btn of Array.from(root.querySelectorAll('button, md-button'))) {
        if (!isSim(btn)) continue;
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
}

/** Clique 2: mouse no centro do botão (coordenadas viewport). */
async function clickSimByCoordinates(page: Page): Promise<boolean> {
  const dump = await dumpAlreadyConnectedModal(page);
  const sim = dump.simButtons.find((b) => b.visible && b.text.toUpperCase().includes('SIM'));
  if (sim) {
    await page.mouse.click(sim.x, sim.y, { delay: 50 });
    return true;
  }

  const handles = await page.$$(
    'md-dialog button, .md-dialog button, md-dialog-actions button, button',
  );
  for (const handle of handles) {
    const text = await handle.evaluate((el) =>
      (el.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase(),
    );
    if (text === 'SIM' || text.includes('SIM')) {
      const box = await handle.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 50 });
        return true;
      }
      await handle.click({ delay: 50 });
      return true;
    }
  }
  return false;
}

/**
 * Modal Angular Material: "Ôoops! Este usuário já está conectado..."
 * Detecta → screenshot + HTML → clica SIM → screenshot → confirma sumiço/URL.
 */
export async function dismissAlreadyConnectedModal(page: Page): Promise<boolean> {
  const dump = await dumpAlreadyConnectedModal(page);
  if (!dump.present || dump.simButtons.length === 0) return false;

  log.info('login', 'Modal "usuário já conectado" DETECTADO', {
    url: page.url(),
    dialogSelector: dump.dialogSelector,
    dialogText: dump.dialogText,
    simButtons: dump.simButtons.map((b) => ({
      text: b.text,
      className: b.className,
      ngClick: b.ngClick,
      disabled: b.disabled,
      visible: b.visible,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
    })),
  });
  log.info('login', 'Modal "usuário já conectado" — outerHTML do dialog', {
    dialogHtml: dump.dialogHtml || '(dialog não encontrado — veja botões)',
    simButtonHtml: dump.simButtons.map((b) => b.outerHTML),
  });

  // 1) Screenshot ANTES do clique
  await dumpDebug(page, 'modal-detected');

  // 2) Clique DOM
  log.info('login', 'Modal "usuário já conectado" — clique em SIM');
  const clicked1 = await clickSimDom(page);
  if (!clicked1) {
    log.warn('login', 'Modal "usuário já conectado" — botão SIM não clicável via DOM');
  }

  // 3) Screenshot IMEDIATO após o clique (antes de qualquer wait longo)
  await dumpDebug(page, 'modal-clicked');

  // 4) Confirmação ativa: modal some OU URL sai de /access/login
  let confirm = await waitForSimDismissConfirmation(page, SIM_CONFIRM_TIMEOUT_MS);
  if (confirm.confirmed) {
    log.info('login', 'Modal "usuário já conectado" — confirmação OK', {
      reason: confirm.reason,
      url: page.url(),
      attempt: 1,
      clickedDom: clicked1,
    });
    return true;
  }

  log.warn('login', 'Modal "usuário já conectado" — clique SIM NÃO confirmou (nem modal sumiu, nem URL mudou)', {
    reason: confirm.reason,
    url: page.url(),
    attempt: 1,
    timeoutMs: SIM_CONFIRM_TIMEOUT_MS,
  });

  // Retry: coordenadas
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
  await dumpDebug(page, 'modal-clicked-retry');

  if (!clicked2) {
    log.warn('login', 'Modal "usuário já conectado" — retry falhou: botão SIM não encontrado');
    return false;
  }

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

  const after = await dumpAlreadyConnectedModal(page);
  log.warn('login', 'Modal ainda presente após retries — HTML atual', {
    dialogHtml: after.dialogHtml.slice(0, 4000),
    dialogText: after.dialogText,
    simButtons: after.simButtons,
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
