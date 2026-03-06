import { expect, test } from "@playwright/test";

test("shows open games, enters the bot table, and starts the hand", async ({
	page,
}) => {
	await page.goto("/");

	await expect(
		page.getByRole("heading", { name: "Join a table that is ready to run." }),
	).toBeVisible();
	await expect(
		page.locator(".lobby-card").filter({ hasText: "Bot Warmup Table" }),
	).toBeVisible();
	await expect(
		page.getByText("7 bots, 1 open seat, blinds 10 / 20"),
	).toBeVisible();

	await page.getByRole("button", { name: "Open Table" }).click();

	await expect(page).toHaveURL(/#\/tables\/default$/);
	await expect(page.locator(".poker-table")).toBeVisible();
	await expect(page.locator(".backend-status")).toHaveClass(/is-collapsed/);
	await page.getByRole("button", { name: "Dev Stats" }).click();
	await expect(
		page
			.locator(".backend-grid div")
			.filter({ has: page.locator("span", { hasText: "Table" }) }),
	).toContainText("default");
	await page.getByRole("button", { name: "Hide Dev Stats" }).click();
	await expect(page.locator(".backend-status")).toHaveClass(/is-collapsed/);

	const availableSeatButton = page
		.getByRole("button", { name: /Take Seat \d+/ })
		.first();
	if (await availableSeatButton.isVisible()) {
		await availableSeatButton.click();
	}

	const playWhenSeatedButton = page.getByRole("button", {
		name: "Play When Seated",
	});
	const playNextHandButton = page.getByRole("button", {
		name: "Play Next Hand",
	});
	const playQueuedHandButton = page.getByRole("button", {
		name: /Play When Seated|Play Next Hand/,
	});
	await expect(playQueuedHandButton).toBeVisible({ timeout: 10_000 });
	if (await playWhenSeatedButton.isVisible()) {
		await playWhenSeatedButton.click();
	} else if (await playNextHandButton.isVisible()) {
		await playNextHandButton.click();
	}

	await page.getByRole("button", { name: "Hand Log" }).click();
	await expect(
		page.getByRole("button", { name: "Hide Hand Log" }),
	).toBeVisible();
	await expect(page.locator("#action-log-list")).toBeVisible();
	await page.getByRole("button", { name: "Hide Hand Log" }).click();
	await expect(page.getByRole("button", { name: "Hand Log" })).toBeVisible();

	await expect(page.locator("#action-state")).toContainText("Your turn", {
		timeout: 30_000,
	});
	await expect(page.locator("#btn-call")).toBeEnabled();
	await expect(page.locator("#btn-fold")).toBeEnabled();
	await expect(page.locator("#btn-raise")).toBeEnabled();

	await page.getByRole("button", { name: "Dev Stats" }).click();
	await expect(page.locator(".backend-status")).not.toHaveClass(/is-collapsed/);
});
