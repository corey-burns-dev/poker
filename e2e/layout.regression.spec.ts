import { expect, test, type Page } from '@playwright/test';

type Mode = {
  name: string;
  width: number;
  height: number;
};

const modes: Mode[] = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet portrait', width: 834, height: 1112 },
  { name: 'mobile portrait', width: 390, height: 844 },
  { name: 'mobile landscape', width: 844, height: 390 },
];

async function getRect(page: Page, selector: string) {
  const locator = page.locator(selector);
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

function expectInViewport(
  rect: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  label: string,
) {
  expect(rect.width, `${label} width`).toBeGreaterThan(0);
  expect(rect.height, `${label} height`).toBeGreaterThan(0);
  expect(rect.x, `${label} left`).toBeGreaterThanOrEqual(-1);
  expect(rect.y, `${label} top`).toBeGreaterThanOrEqual(-1);
  expect(rect.x + rect.width, `${label} right`).toBeLessThanOrEqual(width + 1);
  expect(rect.y + rect.height, `${label} bottom`).toBeLessThanOrEqual(height + 1);
}

for (const mode of modes) {
  test(`keeps seats and controls in bounds (${mode.name})`, async ({ page }) => {
    await page.setViewportSize({ width: mode.width, height: mode.height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.locator('.poker-table')).toBeVisible();
    await expect(page.locator('.controls-container')).toBeVisible();

    const tableRect = await getRect(page, '.poker-table');
    const controlsRect = await getRect(page, '.controls-container');

    expectInViewport(controlsRect, mode.width, mode.height, 'controls');

    const criticalControls = ['#btn-fold', '#btn-call', '#btn-raise', '#bet-slider', '#bet-amount-display'];
    for (const selector of criticalControls) {
      const el = page.locator(selector);
      await expect(el, `${selector} should be visible`).toBeVisible();
      const rect = await getRect(page, selector);
      expectInViewport(rect, mode.width, mode.height, selector);
    }

    const heroRect = await getRect(page, '#seat-0');
    expect(heroRect.y + heroRect.height, 'hero seat should stay above controls').toBeLessThanOrEqual(controlsRect.y + 8);

    const tableCenterX = tableRect.x + tableRect.width / 2;
    const tableCenterY = tableRect.y + tableRect.height / 2;
    const tableRadiusX = tableRect.width / 2;
    const tableRadiusY = tableRect.height / 2;
    const minEllipseDistance = mode.name === 'mobile landscape' ? 0.55 : 0.6;

    for (let seat = 0; seat < 8; seat += 1) {
      const seatRect = await getRect(page, `#seat-${seat}`);
      expectInViewport(seatRect, mode.width, mode.height, `seat-${seat}`);

      const seatCenterX = seatRect.x + seatRect.width / 2;
      const seatCenterY = seatRect.y + seatRect.height / 2;
      const dx = (seatCenterX - tableCenterX) / tableRadiusX;
      const dy = (seatCenterY - tableCenterY) / tableRadiusY;
      const ellipseDistance = Math.sqrt(dx ** 2 + dy ** 2);

      expect(ellipseDistance, `seat-${seat} should sit near the table oval`).toBeGreaterThan(minEllipseDistance);
      expect(ellipseDistance, `seat-${seat} should not drift off the oval`).toBeLessThan(0.99);
    }
  });
}
