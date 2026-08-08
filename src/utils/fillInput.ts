import type { Page } from 'puppeteer-core';

/**
 * Preenche input de forma compatível com AngularJS (ng-model).
 * page.type sozinho muitas vezes não atualiza o model.
 */
export async function fillAngularInput(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  await page.waitForSelector(selector, { visible: true });

  const ok = await page.$eval(
    selector,
    (el, val) => {
      const input = el as HTMLInputElement;
      input.focus();
      const proto = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      proto?.set?.call(input, '');
      proto?.set?.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // AngularJS às vezes escuta keyup
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      return input.value === val;
    },
    value,
  );

  if (!ok) {
    await page.click(selector, { count: 3 });
    await page.type(selector, value, { delay: 30 });
  }
}
