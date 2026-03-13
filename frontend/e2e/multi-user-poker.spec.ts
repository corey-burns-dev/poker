import { expect, test } from "@playwright/test";

test("multi-user poker: register, login, create table, and play", async ({
	browser,
}) => {
	// Setup two independent browser contexts
	const context1 = await browser.newContext();
	const context2 = await browser.newContext();

	const page1 = await context1.newPage();
	const page2 = await context2.newPage();

	// --- User 1: Register and Create Table ---
	await page1.goto("/");
	await page1.getByRole("button", { name: "Register" }).first().click();
	await page1.getByLabel("Email").fill("user1@example.com");
	await page1.getByLabel("Display Name").fill("UserOne");
	await page1.getByLabel("Password").fill("password123");
	await page1.getByRole("button", { name: "Register" }).last().click();

	await expect(page1.getByText("Welcome back, UserOne")).toBeVisible();

	const tableName = "E2E Test Table";
	await page1.getByLabel("Table Name").fill(tableName);
	await page1.getByRole("button", { name: "Create Table" }).click();

	await expect(page1).toHaveURL(/#\/tables\//);
	const tableUrl = page1.url();
	const tableId = tableUrl.split("/").pop() || "";

	// --- User 2: Register and Join User 1's Table ---
	await page2.goto("/");
	await page2.getByRole("button", { name: "Register" }).first().click();
	await page2.getByLabel("Email").fill("user2@example.com");
	await page2.getByLabel("Display Name").fill("UserTwo");
	await page2.getByLabel("Password").fill("password123");
	await page2.getByRole("button", { name: "Register" }).last().click();

	await expect(page2.getByText("Welcome back, UserTwo")).toBeVisible();

	// Join the same table
	await page2.goto(tableUrl);
	await expect(page2.locator(".poker-table")).toBeVisible();

	// --- Both: Take Seats ---
	// User 1 takes Seat 1
	await page1.getByRole("button", { name: "Take Seat 1" }).click();
	await expect(page1.locator("#p1-name")).toContainText("UserOne");

	// User 2 takes Seat 2
	await page2.getByRole("button", { name: "Take Seat 2" }).click();
	await expect(page2.locator("#p2-name")).toContainText("UserTwo");

	// --- Start Playing ---
	// Wait for the hand to start (might need manual trigger if bots aren't filling)
	// In our Go backend, it should start if 2 players are ready.
	
	await expect(page1.locator("#action-state")).toContainText("Action on", { timeout: 10000 });
	
	// Check if buttons are visible for the acting player
	const actingSeatText = await page1.locator("#action-state").innerText();
	if (actingSeatText.includes("seat 1")) {
		await expect(page1.locator("#btn-call")).toBeVisible();
		await page1.locator("#btn-call").click();
	} else if (actingSeatText.includes("seat 2")) {
		await expect(page2.locator("#btn-call")).toBeVisible();
		await page2.locator("#btn-call").click();
	}

	await context1.close();
	await context2.close();
});
