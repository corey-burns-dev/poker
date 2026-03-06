import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	timeout: 30_000,
	expect: {
		timeout: 5_000,
	},
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? "dot" : [["list"], ["html", { open: "never" }]],
	use: {
		baseURL: "http://127.0.0.1:4173",
		trace: "on-first-retry",
	},
	webServer: [
		{
			command: "mix phx.server",
			url: "http://127.0.0.1:4000/api/health",
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
			cwd: "../backend",
		},
		{
			command:
				"npx vite build --outDir dist-playwright && npx vite preview --outDir dist-playwright --host 0.0.0.0 --port 4173",
			url: "http://127.0.0.1:4173",
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
		},
	],
	projects: [
		{
			name: "chromium",
			use: { browserName: "chromium" },
		},
	],
});
