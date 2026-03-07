import type { CSSProperties } from "react";
import {
	useCallback,
	useEffect,
	useEffectEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import { PhoenixPokerGame } from "./game/PhoenixPokerGame";
import { usePhoenixTable } from "./hooks/usePhoenixTable";
import type { BackendTable } from "./types/backend";
import type { Renderer } from "./ui/Renderer";

const MAX_SEATS = 8;
const TABLE_HASH_PREFIX = "#/tables/";
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";
const TABLE_STORAGE_KEY = "poker.lobby_tables";
const PROFILE_STORAGE_KEY = "poker.profile";

type SeatLayout = {
	seatX: number;
	seatY: number;
	betX: number;
	betY: number;
};

type SeatCoordinate = Pick<SeatLayout, "seatX" | "seatY">;

type LobbyTable = {
	tableId: string;
	name: string;
	stakes: string;
	createdAt?: string;
};

type LobbyGame = {
	tableId: string;
	name: string;
	stakes: string;
	bots: number;
	openSeats: number;
	humanPlayers: number;
	status: string;
	lastEvent: string;
	connectedClients: number;
};

type AuthProfile = {
	displayName: string;
};

type TableActionPayload = {
	amount?: number;
	seat?: number;
	show_cards?: boolean;
};

const DEFAULT_TABLE: LobbyTable = {
	tableId: "default",
	name: "Bot Warmup Table",
	stakes: "10 / 20",
};

function createSeatLayouts(
	coordinates: SeatCoordinate[],
	betInsetFactor: number,
): SeatLayout[] {
	return coordinates.map(({ seatX, seatY }) => ({
		seatX,
		seatY,
		betX: Number((50 + (seatX - 50) * betInsetFactor).toFixed(1)),
		betY: Number((50 + (seatY - 50) * betInsetFactor).toFixed(1)),
	}));
}

const DESKTOP_SEAT_LAYOUTS = createSeatLayouts(
	[
		{ seatX: 50, seatY: 96 },
		{ seatX: 18, seatY: 86 },
		{ seatX: 6, seatY: 50 },
		{ seatX: 18, seatY: 14 },
		{ seatX: 50, seatY: 4 },
		{ seatX: 82, seatY: 14 },
		{ seatX: 94, seatY: 50 },
		{ seatX: 82, seatY: 86 },
	],
	0.4,
);

const TABLET_SEAT_LAYOUTS = createSeatLayouts(
	[
		{ seatX: 50, seatY: 96 },
		{ seatX: 18, seatY: 86 },
		{ seatX: 6, seatY: 50 },
		{ seatX: 18, seatY: 14 },
		{ seatX: 50, seatY: 4 },
		{ seatX: 82, seatY: 14 },
		{ seatX: 94, seatY: 50 },
		{ seatX: 82, seatY: 86 },
	],
	0.4,
);

const MOBILE_PORTRAIT_SEAT_LAYOUTS = createSeatLayouts(
	[
		{ seatX: 50, seatY: 96 },
		{ seatX: 18, seatY: 86 },
		{ seatX: 8, seatY: 50 },
		{ seatX: 18, seatY: 14 },
		{ seatX: 50, seatY: 4 },
		{ seatX: 82, seatY: 14 },
		{ seatX: 92, seatY: 50 },
		{ seatX: 82, seatY: 86 },
	],
	0.4,
);

const MOBILE_LANDSCAPE_SEAT_LAYOUTS = createSeatLayouts(
	[
		{ seatX: 50, seatY: 96 },
		{ seatX: 18, seatY: 86 },
		{ seatX: 8, seatY: 50 },
		{ seatX: 18, seatY: 14 },
		{ seatX: 50, seatY: 4 },
		{ seatX: 82, seatY: 14 },
		{ seatX: 92, seatY: 50 },
		{ seatX: 82, seatY: 86 },
	],
	0.4,
);

function pickSeatLayout(width: number, height: number): SeatLayout[] {
	const shortLandscape = width > height && height <= 560;
	if (shortLandscape) return MOBILE_LANDSCAPE_SEAT_LAYOUTS;
	if (width <= 760) return MOBILE_PORTRAIT_SEAT_LAYOUTS;
	if (width <= 1100) return TABLET_SEAT_LAYOUTS;
	return DESKTOP_SEAT_LAYOUTS;
}

function getTableIdFromHash(hash: string): string | null {
	if (!hash.startsWith(TABLE_HASH_PREFIX)) return null;
	const tableId = hash.slice(TABLE_HASH_PREFIX.length).trim();
	return tableId || null;
}

function navigateToLobby() {
	window.location.hash = "";
}

function navigateToTable(tableId: string) {
	window.location.hash = `${TABLE_HASH_PREFIX}${tableId}`;
}

function slugifyLabel(label: string) {
	return label
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
}

function createTableId(label: string) {
	const slug = slugifyLabel(label) || "table";
	const suffix = Math.random().toString(36).slice(2, 7);
	return `${slug}-${suffix}`;
}

function loadStoredTables(): LobbyTable[] {
	if (typeof window === "undefined") return [];

	const raw = window.localStorage.getItem(TABLE_STORAGE_KEY);
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw) as LobbyTable[];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(table) =>
				typeof table?.tableId === "string" &&
				table.tableId.trim().length > 0 &&
				table.tableId !== DEFAULT_TABLE.tableId,
		);
	} catch {
		return [];
	}
}

function storeTables(tables: LobbyTable[]) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(TABLE_STORAGE_KEY, JSON.stringify(tables));
}

function loadProfile(): AuthProfile | null {
	if (typeof window === "undefined") return null;

	const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as AuthProfile;
		if (!parsed?.displayName) return null;
		return { displayName: String(parsed.displayName) };
	} catch {
		return null;
	}
}

function saveProfile(profile: AuthProfile | null) {
	if (typeof window === "undefined") return;
	if (profile == null) {
		window.localStorage.removeItem(PROFILE_STORAGE_KEY);
		return;
	}
	window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

async function fetchTableState(tableId: string): Promise<BackendTable | null> {
	try {
		const response = await fetch(`${BACKEND_URL}/api/tables/${tableId}`);
		if (!response.ok) return null;
		return (await response.json()) as BackendTable;
	} catch {
		return null;
	}
}

async function postTableAction(
	tableId: string,
	action: string,
	payload: Record<string, unknown> = {},
) {
	const actionUrl = new URL(`${BACKEND_URL}/api/tables/${tableId}/actions`);
	actionUrl.searchParams.set("action", action);

	const response = await fetch(actionUrl.toString(), {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`Action failed: ${action}`);
	}

	return (await response.json()) as BackendTable;
}

function LobbyScreen() {
	const [storedTables, setStoredTables] = useState<LobbyTable[]>(() =>
		loadStoredTables(),
	);
	const [games, setGames] = useState<LobbyGame[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [profile, setProfile] = useState<AuthProfile | null>(() =>
		loadProfile(),
	);
	const [authMode, setAuthMode] = useState<"login" | "register" | null>(null);
	const [authName, setAuthName] = useState("");
	const [createName, setCreateName] = useState("Friday Night Hold'em");
	const [createStakes, setCreateStakes] = useState("10 / 20");
	const [createBusy, setCreateBusy] = useState(false);
	const [lobbyMessage, setLobbyMessage] = useState<string | null>(null);

	const lobbyTables = useMemo(() => {
		const map = new Map<string, LobbyTable>();
		map.set(DEFAULT_TABLE.tableId, DEFAULT_TABLE);
		for (const table of storedTables) {
			map.set(table.tableId, table);
		}
		return Array.from(map.values());
	}, [storedTables]);

	const refreshGames = useCallback(async () => {
		const loaded = await Promise.all(
			lobbyTables.map(async (table): Promise<LobbyGame> => {
				const state = await fetchTableState(table.tableId);
				const activeBots =
					state?.players.filter((player) => player.is_bot && player.stack > 0)
						.length ?? 0;
				const openSeats =
					state?.players.filter((player) => player.is_bot).length ?? MAX_SEATS;
				const humanPlayers =
					state?.players.filter((player) => !player.is_bot).length ?? 0;
				const status =
					state == null
						? "Offline"
						: state.game_state === "hand_in_progress"
							? "In hand"
							: "Waiting";

				return {
					tableId: table.tableId,
					name: table.name,
					stakes: table.stakes,
					bots: activeBots,
					openSeats,
					humanPlayers,
					status,
					lastEvent: state?.last_event ?? "unreachable",
					connectedClients: state?.connected_clients ?? 0,
				};
			}),
		);

		setGames(loaded);
		setIsLoading(false);
	}, [lobbyTables]);

	useEffect(() => {
		void refreshGames();

		const timer = window.setInterval(() => {
			void refreshGames();
		}, 8_000);

		return () => {
			window.clearInterval(timer);
		};
	}, [refreshGames]);

	const submitAuth = useCallback(() => {
		const name = authName.trim();
		if (!name) return;
		const nextProfile = { displayName: name };
		saveProfile(nextProfile);
		setProfile(nextProfile);
		setAuthMode(null);
		setAuthName("");
	}, [authName]);

	const logout = useCallback(() => {
		saveProfile(null);
		setProfile(null);
		setAuthMode(null);
		setAuthName("");
	}, []);

	const createTable = useCallback(async () => {
		setCreateBusy(true);
		setLobbyMessage(null);
		const tableId = createTableId(createName);
		const nextTable: LobbyTable = {
			tableId,
			name: createName.trim() || "Custom Table",
			stakes: createStakes.trim() || "10 / 20",
			createdAt: new Date().toISOString(),
		};

		const nextTables = [nextTable, ...storedTables].slice(0, 24);
		storeTables(nextTables);
		setStoredTables(nextTables);

		try {
			await fetchTableState(tableId);
			await postTableAction(tableId, "clear_table");
			navigateToTable(tableId);
		} catch {
			setLobbyMessage("Could not create table right now. Try again.");
		}

		setCreateBusy(false);
	}, [createName, createStakes, storedTables]);

	return (
		<div id="app" className="app-lobby">
			<div className="lobby-bg-shape"></div>
			<header className="top-bar glass-panel anim-slide-up">
				<div className="brand-mark">
					<div className="brand-token">P</div>
					<div>
						<p className="brand-title">Poker Royale</p>
						<p className="brand-subtitle">No-limit Texas Hold'em</p>
					</div>
				</div>

				<div className="top-actions">
					{profile ? (
						<>
							<button type="button" className="btn tiny profile-btn">
								Profile: {profile.displayName}
							</button>
							<button type="button" className="btn tiny" onClick={logout}>
								Logout
							</button>
						</>
					) : (
						<>
							<button
								type="button"
								className="btn tiny"
								onClick={() => setAuthMode("login")}
							>
								Login
							</button>
							<button
								type="button"
								className="btn primary tiny"
								onClick={() => setAuthMode("register")}
							>
								Register
							</button>
						</>
					)}
				</div>
			</header>

			<main
				className="lobby-shell glass-panel anim-slide-up"
				style={{ animationDelay: "0.08s" }}
			>
				<section className="lobby-hero">
					<div className="lobby-copy">
						<p className="backend-eyebrow">Live lobby</p>
						<h1>Find a table, create one, or launch your own bot arena.</h1>
						<p className="lobby-subcopy">
							Track active games, jump into open seats, and spin up a private
							table in one click.
						</p>
					</div>
					<div className="lobby-highlights">
						<div>
							<span>Open tables</span>
							<strong>{games.length}</strong>
						</div>
						<div>
							<span>Players seated</span>
							<strong>
								{games.reduce((sum, game) => sum + game.humanPlayers, 0)}
							</strong>
						</div>
						<div>
							<span>Bots in play</span>
							<strong>{games.reduce((sum, game) => sum + game.bots, 0)}</strong>
						</div>
					</div>
				</section>

				<section className="lobby-main-grid">
					<div className="lobby-column">
						<div className="create-table-card glass-panel">
							<h2>Create Table</h2>
							<p>
								New tables start empty. Add bots inside the table one seat at a
								time.
							</p>
							<label>
								Table Name
								<input
									type="text"
									value={createName}
									onChange={(event) => setCreateName(event.target.value)}
								/>
							</label>
							<label>
								Stakes
								<input
									type="text"
									value={createStakes}
									onChange={(event) => setCreateStakes(event.target.value)}
								/>
							</label>
							<button
								type="button"
								className="btn primary"
								disabled={createBusy}
								onClick={() => void createTable()}
							>
								{createBusy ? "Creating..." : "Create Table"}
							</button>
							{lobbyMessage ? (
								<p className="lobby-inline-note">{lobbyMessage}</p>
							) : null}
						</div>

						{authMode ? (
							<div className="auth-card glass-panel">
								<h2>{authMode === "login" ? "Login" : "Register"}</h2>
								<p>
									Auth is local for now. This sets your display name for table
									actions.
								</p>
								<label>
									Display Name
									<input
										type="text"
										value={authName}
										onChange={(event) => setAuthName(event.target.value)}
									/>
								</label>
								<div className="auth-actions">
									<button
										type="button"
										className="btn primary tiny"
										onClick={submitAuth}
									>
										Continue
									</button>
									<button
										type="button"
										className="btn tiny"
										onClick={() => setAuthMode(null)}
									>
										Cancel
									</button>
								</div>
							</div>
						) : null}
					</div>

					<div className="lobby-column wide">
						<div className="games-card glass-panel">
							<div className="games-card-header">
								<h2>Live Games</h2>
								<button
									type="button"
									className="btn tiny"
									onClick={() => void refreshGames()}
								>
									Refresh
								</button>
							</div>
							<ul className="lobby-list" aria-label="Open games">
								{games.map((game) => (
									<li key={game.tableId} className="lobby-card glass-panel">
										<div>
											<p className="lobby-card-label">Cash Game</p>
											<h3>{game.name}</h3>
											<p className="lobby-card-meta">
												Blinds {game.stakes} | {game.humanPlayers} players |{" "}
												{game.bots} active bots
											</p>
										</div>

										<div className="lobby-card-stats">
											<div>
												<span>Table</span>
												<strong>{game.tableId}</strong>
											</div>
											<div>
												<span>Status</span>
												<strong>{game.status}</strong>
											</div>
											<div>
												<span>Open Seats</span>
												<strong>{game.openSeats}</strong>
											</div>
											<div>
												<span>Watchers</span>
												<strong>{game.connectedClients}</strong>
											</div>
										</div>

										<div className="lobby-card-actions">
											<button
												type="button"
												className="btn primary lobby-join-btn"
												onClick={() => navigateToTable(game.tableId)}
											>
												Open Table
											</button>
											<p className="lobby-card-event">Last: {game.lastEvent}</p>
										</div>
									</li>
								))}
							</ul>
							{isLoading ? (
								<p className="lobby-inline-note">Loading tables...</p>
							) : null}
						</div>

						<div className="extras-grid">
							<div className="extra-card glass-panel">
								<h3>Featured Format</h3>
								<p>
									6-max turbo cash with deep stacks and faster blind pressure.
								</p>
							</div>
							<div className="extra-card glass-panel">
								<h3>Daily Challenge</h3>
								<p>
									Win one showdown with pocket pairs and log three clean folds.
								</p>
							</div>
							<div className="extra-card glass-panel">
								<h3>Table Notes</h3>
								<p>
									Custom tables can be started empty and filled with bots from
									inside the table view.
								</p>
							</div>
						</div>
					</div>
				</section>
			</main>
		</div>
	);
}

function TableScreen({
	tableId,
	isCustomTable,
}: {
	tableId: string;
	isCustomTable: boolean;
}) {
	const gameRef = useRef<PhoenixPokerGame | null>(null);
	const rendererRef = useRef<Renderer | null>(null);
	const autoStartAttemptRef = useRef<string | null>(null);
	const customInitRef = useRef(false);
	const [backendOverlayCollapsed, setBackendOverlayCollapsed] = useState(true);
	const [handLogCollapsed, setHandLogCollapsed] = useState(true);
	const [seatLayouts, setSeatLayouts] =
		useState<SeatLayout[]>(DESKTOP_SEAT_LAYOUTS);
	const { playerId, backendHealth, backendTable, backendState, sendAction } =
		usePhoenixTable(tableId);
	const occupiedSeats = backendTable?.players.length ?? 0;
	const botSeats =
		backendTable?.players.filter((player) => player.is_bot && player.stack > 0)
			.length ?? 0;
	const emptySeatCount =
		backendTable?.players.filter((player) => player.is_bot && player.stack <= 0)
			.length ?? 0;
	const ownedPlayer =
		backendTable?.players.find((player) => player.player_id === playerId) ??
		null;
	const pendingPlayer =
		backendTable?.pending_players.find(
			(player) => player.player_id === playerId,
		) ?? null;
	const heroSeatIndex = ownedPlayer ? ownedPlayer.seat - 1 : null;
	const reservedSeats = new Set(
		backendTable?.pending_players.map((player) => player.desired_seat) ?? [],
	);
	const reservedSeatLabels = new Map(
		backendTable?.pending_players.map((player) => [
			player.desired_seat,
			player.player_id === playerId ? "Reserved for you" : "Reserved",
		]) ?? [],
	);
	const readySeats =
		backendTable?.players.filter(
			(player) => player.stack > 0 && player.will_play_next_hand,
		).length ?? 0;
	const canRevealCompletedHand =
		backendTable?.hand_state.status === "complete" &&
		ownedPlayer != null &&
		ownedPlayer.hole_cards.some((card) => card != null);
	const canAddBot =
		backendTable?.hand_state.status !== "in_progress" && emptySeatCount > 0;
	const canClearTable = backendTable?.hand_state.status !== "in_progress";
	const manualNextHandRequired =
		backendTable?.players.some(
			(player) =>
				!player.is_bot && player.stack > 0 && player.will_play_next_hand,
		) ?? false;
	const logControlDebug = useEffectEvent((message: string) => {
		const timestamp = new Date().toLocaleTimeString("en-US", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		const entry = `${timestamp} ${message}`;
		console.debug("[betting-ui]", entry);
	});
	const sendActionWithDebug = useCallback(
		async (action: string, payload?: TableActionPayload, source = "ui") => {
			const payloadLabel = payload == null ? "none" : JSON.stringify(payload);
			logControlDebug(
				`${source}: sending action=${action} payload=${payloadLabel}`,
			);

			try {
				await sendAction(action, payload);
				logControlDebug(`${source}: action=${action} synced`);
			} catch (error) {
				const reason =
					error instanceof Error ? error.message : "Unknown action failure";
				logControlDebug(`${source}: action=${action} failed: ${reason}`);
				throw error;
			}
		},
		[sendAction],
	);
	const showGameMessage = useCallback((message: string) => {
		rendererRef.current?.showMessage(message);
	}, []);
	const syncSliderDisplay = useCallback(() => {
		const slider = document.getElementById(
			"bet-slider",
		) as HTMLInputElement | null;
		const display = document.getElementById("bet-amount-display");
		if (!slider || !display) return;
		display.textContent = `🪙 ${slider.value}`;
	}, []);
	const setSliderValue = useCallback(
		(nextValue: number) => {
			const slider = document.getElementById(
				"bet-slider",
			) as HTMLInputElement | null;
			if (!slider) return;
			slider.value = String(nextValue);
			syncSliderDisplay();
		},
		[syncSliderDisplay],
	);
	const handleSliderInput = useCallback(() => {
		const slider = document.getElementById(
			"bet-slider",
		) as HTMLInputElement | null;
		if (!slider) return;
		syncSliderDisplay();
		logControlDebug(`slider: value=${slider.value}`);
	}, [syncSliderDisplay]);
	const handleSliderPreset = useCallback(
		(preset: "min" | "halfpot" | "pot" | "max") => {
			const slider = document.getElementById(
				"bet-slider",
			) as HTMLInputElement | null;
			if (!slider) return;

			const min = Number.parseInt(slider.min, 10) || 0;
			const max = Number.parseInt(slider.max, 10) || min;

			if (preset === "min") {
				setSliderValue(min);
				logControlDebug(`preset:min -> ${min}`);
				return;
			}

			if (preset === "halfpot") {
				const potStr = document.getElementById("total-pot")?.textContent || "0";
				const potVal = Number.parseInt(potStr.replace(/[^\d]/g, ""), 10) || 0;
				const value = Math.min(Math.max(Math.round(potVal * 0.5), min), max);
				setSliderValue(value);
				logControlDebug(
					`preset:halfpot -> ${value} (pot=${potVal} min=${min} max=${max})`,
				);
				return;
			}

			if (preset === "pot") {
				const potStr = document.getElementById("total-pot")?.textContent || "0";
				const potVal = Number.parseInt(potStr.replace(/[^\d]/g, ""), 10) || 0;
				const value = Math.min(Math.max(potVal, min), max);
				setSliderValue(value);
				logControlDebug(
					`preset:pot -> ${value} (pot=${potVal} min=${min} max=${max})`,
				);
				return;
			}

			setSliderValue(max);
			logControlDebug(`preset:max -> ${max}`);
		},
		[setSliderValue],
	);

	const handleSliderPresetBB = useCallback(
		(multiplier: number) => {
			const slider = document.getElementById(
				"bet-slider",
			) as HTMLInputElement | null;
			if (!slider) return;
			const bigBlind = gameRef.current?.view.bigBlind ?? 20;
			const min = Number.parseInt(slider.min, 10) || 0;
			const max = Number.parseInt(slider.max, 10) || min;
			const target = Math.round(bigBlind * multiplier);
			const value = Math.min(Math.max(target, min), max);
			setSliderValue(value);
			logControlDebug(`preset:${multiplier}bb -> ${value} (bb=${bigBlind})`);
		},
		[setSliderValue],
	);
	const runPlayerAction = useCallback(
		async (
			action: "fold" | "check" | "call" | "bet" | "raise",
			amount?: number,
		) => {
			const game = gameRef.current;
			if (!game) {
				logControlDebug(`action:${action} skipped because game is not ready`);
				showGameMessage("Game connection is not ready yet.");
				return;
			}

			try {
				await game.handlePlayerAction(action, amount);
			} catch (error) {
				const reason =
					error instanceof Error ? error.message : "Unknown action failure";
				logControlDebug(`action:${action} failed in UI: ${reason}`);
				showGameMessage(`Action failed: ${reason}`);
			}
		},
		[showGameMessage],
	);
	const handleFoldClick = useCallback(() => {
		const foldBtn = document.getElementById(
			"btn-fold",
		) as HTMLButtonElement | null;
		logControlDebug(
			`click:fold disabled=${String(foldBtn?.disabled ?? false)}`,
		);
		void runPlayerAction("fold");
	}, [runPlayerAction]);
	const handleCallClick = useCallback(() => {
		const callBtn = document.getElementById(
			"btn-call",
		) as HTMLButtonElement | null;
		if (!callBtn) return;
		const action = (callBtn.dataset.action || "call") as "call" | "check";
		logControlDebug(
			`click:${action} disabled=${String(callBtn.disabled)} label=${callBtn.textContent ?? ""}`,
		);
		void runPlayerAction(action);
	}, [runPlayerAction]);
	const handleRaiseClick = useCallback(() => {
		const raiseBtn = document.getElementById(
			"btn-raise",
		) as HTMLButtonElement | null;
		const slider = document.getElementById(
			"bet-slider",
		) as HTMLInputElement | null;
		if (!raiseBtn || !slider) return;
		const action = (raiseBtn.dataset.action || "raise") as "raise" | "bet";
		const amount = Number.parseInt(slider.value, 10);
		logControlDebug(
			`click:${action} disabled=${String(raiseBtn.disabled)} amount=${Number.isNaN(amount) ? "NaN" : amount}`,
		);
		void runPlayerAction(action, Number.isNaN(amount) ? undefined : amount);
	}, [runPlayerAction]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const syncLayouts = () => {
			setSeatLayouts(pickSeatLayout(window.innerWidth, window.innerHeight));
		};

		syncLayouts();
		window.addEventListener("resize", syncLayouts);
		return () => {
			window.removeEventListener("resize", syncLayouts);
		};
	}, []);

	useEffect(() => {
		if (typeof window === "undefined" || gameRef.current) return;

		let disposed = false;
		let cleanup: (() => void) | undefined;

		void (async () => {
			const [{ PokerSoundEngine }, { Renderer }] = await Promise.all([
				import("./ui/PokerSoundEngine"),
				import("./ui/Renderer"),
			]);

			if (disposed || gameRef.current) return;

			const game = new PhoenixPokerGame(playerId, (action, payload) =>
				sendActionWithDebug(action, payload, "game"),
			);
			const renderer = new Renderer(game);
			const sounds = new PokerSoundEngine();

			game.onStateChange = () => renderer.update();
			game.onMessage = (msg: string) => renderer.showMessage(msg);
			game.onActionLogUpdate = () => renderer.update();
			game.onHandResultUpdate = () => renderer.update();
			game.onSoundEvent = (event) => sounds.play(event);

			gameRef.current = game;
			rendererRef.current = renderer;
			if (backendTable) {
				game.sync(backendTable);
				renderer.update();
			}

			cleanup = () => {
				game.onSoundEvent = () => {};
				sounds.dispose();
			};
		})();

		return () => {
			disposed = true;
			cleanup?.();
		};
	}, [backendTable, playerId, sendActionWithDebug]);

	useEffect(() => {
		if (!backendTable || !gameRef.current || !rendererRef.current) return;
		gameRef.current.sync(backendTable);
		rendererRef.current.update();
	}, [backendTable]);

	useEffect(() => {
		if (
			!isCustomTable ||
			!backendTable ||
			customInitRef.current ||
			backendTable.last_event !== "table_created"
		) {
			return;
		}

		const hasHumans = backendTable.players.some((player) => !player.is_bot);
		if (hasHumans || backendTable.pending_players.length > 0) {
			customInitRef.current = true;
			return;
		}

		customInitRef.current = true;
		void sendActionWithDebug("clear_table", undefined, "setup");
	}, [backendTable, isCustomTable, sendActionWithDebug]);

	useEffect(() => {
		if (!backendTable) return;

		if (backendTable.game_state !== "waiting_for_hand") {
			autoStartAttemptRef.current = null;
			return;
		}

		if (readySeats < 2) return;

		const attemptKey = `${backendTable.hand_number}:${backendTable.last_event}`;
		if (autoStartAttemptRef.current === attemptKey) return;

		if (
			backendTable.last_event !== "hand_complete" &&
			backendTable.last_event !== "table_created"
		) {
			return;
		}

		if (manualNextHandRequired) {
			return;
		}

		autoStartAttemptRef.current = attemptKey;
		logControlDebug(
			`recovery: scheduling next_hand from waiting state (hand=${backendTable.hand_number} ready=${readySeats})`,
		);

		const timer = window.setTimeout(() => {
			if (gameRef.current?.view.street === "SHOWDOWN") return;
			void sendActionWithDebug("next_hand", undefined, "recovery");
		}, 5_400);

		return () => {
			window.clearTimeout(timer);
		};
	}, [backendTable, manualNextHandRequired, readySeats, sendActionWithDebug]);

	useEffect(() => {
		if (!backendTable) return;

		const hero = backendTable.players.find(
			(player) => player.player_id === playerId,
		);
		const actionState =
			document.getElementById("action-state")?.textContent?.trim() || "n/a";
		logControlDebug(
			[
				`state:update`,
				`hand=${backendTable.hand_state.hand_number}`,
				`stage=${backendTable.hand_state.stage}`,
				`actingSeat=${backendTable.hand_state.acting_seat ?? "-"}`,
				`heroSeat=${hero?.seat ?? "-"}`,
				`heroStatus=${hero?.status ?? "not-seated"}`,
				`heroWillPlay=${hero?.will_play_next_hand ?? false}`,
				`actionState="${actionState}"`,
			].join(" "),
		);
	}, [backendTable, playerId]);

	return (
		<div id="app" className="app-table">
			<div className="game-info glass-panel">
				Pot: <span id="total-pot">🪙 0</span> | Blinds:{" "}
				<span id="blind-level">10 / 20</span>
			</div>

			<div className="table-nav">
				<button
					type="button"
					className="btn tiny table-nav-btn"
					onClick={navigateToLobby}
				>
					Back to Lobby
				</button>
			</div>

			<section
				className={`backend-status glass-panel anim-slide-up${backendOverlayCollapsed ? " is-collapsed" : ""}`}
			>
				<div className="backend-status-header">
					{!backendOverlayCollapsed ? (
						<p className="backend-eyebrow">Dev stats</p>
					) : null}
					<div className="backend-status-title-row">
						{!backendOverlayCollapsed ? <h2>{backendState}</h2> : null}
						<button
							type="button"
							className="btn tiny backend-toggle"
							onClick={() =>
								setBackendOverlayCollapsed((collapsed) => !collapsed)
							}
						>
							{backendOverlayCollapsed ? "Dev Stats" : "Hide Dev Stats"}
						</button>
					</div>
				</div>
				<div className="backend-grid">
					<div>
						<span>Service</span>
						<strong>{backendHealth?.service || "poker_backend"}</strong>
					</div>
					<div>
						<span>Framework</span>
						<strong>{backendHealth?.framework || "phoenix"}</strong>
					</div>
					<div>
						<span>Table</span>
						<strong>{backendTable?.table_id || tableId}</strong>
					</div>
					<div>
						<span>Live clients</span>
						<strong>{backendTable?.connected_clients ?? 0}</strong>
					</div>
					<div>
						<span>Seats</span>
						<strong>
							{occupiedSeats} / {MAX_SEATS}
						</strong>
					</div>
					<div>
						<span>Bots</span>
						<strong>{botSeats}</strong>
					</div>
					<div>
						<span>Last event</span>
						<strong>{backendTable?.last_event || "waiting"}</strong>
					</div>
					<div>
						<span>Stage</span>
						<strong>{backendTable?.hand_state.stage || "preflop"}</strong>
					</div>
					<div>
						<span>Server pot</span>
						<strong>🪙 {backendTable?.hand_state.pot ?? 0}</strong>
					</div>
					<div>
						<span>Acting seat</span>
						<strong>{backendTable?.hand_state.acting_seat ?? "-"}</strong>
					</div>
				</div>
			</section>

			<div id="game-message" className="game-message glass-panel">
				Joining table {tableId}...
			</div>

			<div className="table-layout">
				<div className="table-stage anim-slide-up">
					<div className="poker-table">
						<div className="community-cards" id="community-cards">
							<div className="card-slot board-slot"></div>
							<div className="card-slot board-slot"></div>
							<div className="card-slot board-slot"></div>
							<div className="card-slot board-slot"></div>
							<div className="card-slot board-slot"></div>
						</div>
					</div>

					<div className="table-seats">
						{Array.from({ length: MAX_SEATS }, (_, seat) => {
							const layout = seatLayouts[seat] || DESKTOP_SEAT_LAYOUTS[seat];
							const style = {
								"--seat-x": `${layout.seatX}%`,
								"--seat-y": `${layout.seatY}%`,
								"--bet-x": `${layout.betX}%`,
								"--bet-y": `${layout.betY}%`,
							} as CSSProperties;
							const playerId = `p${seat + 1}`;
							const isHeroSeat = heroSeatIndex === seat;
							const isBottom = layout.seatY > 65;
							const isTop = layout.seatY < 35;
							const isLeft = layout.seatX < 35;
							const isRight = layout.seatX > 65;
							const posClass = isBottom
								? "pos-bottom"
								: isTop
									? "pos-top"
									: isLeft
										? "pos-left"
										: isRight
											? "pos-right"
											: "";

							const backendSeat = seat + 1;
							const backendPlayer = backendTable?.players.find(
								(player) => player.seat === backendSeat,
							);
							const queuedSeatClaim =
								backendPlayer?.is_bot &&
								(backendPlayer.stack > 0 ||
									backendTable?.hand_state.status === "in_progress");
							const canClaimSeat =
								!ownedPlayer &&
								!pendingPlayer &&
								backendPlayer?.is_bot &&
								!reservedSeats.has(backendSeat);
							const reservedSeatLabel = reservedSeatLabels.get(backendSeat);
							const claimButtonLabel = queuedSeatClaim
								? `Join Seat ${backendSeat} Next Hand`
								: `Take Seat ${backendSeat}`;

							return (
								<div className="seat-slot" key={playerId}>
									<div className="seat-anchor" style={style}>
										<div
											className={`player-area ${posClass}${isHeroSeat ? " is-you" : ""}${canClaimSeat ? " is-claimable" : ""}${reservedSeatLabel ? " is-reserved" : ""}`}
											id={`seat-${seat}`}
										>
											<div
												className={`player-cards${isHeroSeat ? " compact" : " compact is-avatar-stack"}`}
												id={`${playerId}-cards`}
											>
												{isHeroSeat ? (
													<>
														<div className="card-slot hole-slot"></div>
														<div className="card-slot hole-slot"></div>
													</>
												) : null}
											</div>

											<div className="player-avatar" id={`${playerId}-avatar`}>
												{isHeroSeat ? "Y" : seat + 1}
											</div>

											<div className="player-info glass-panel">
												<div className="player-name" id={`${playerId}-name`}>
													Seat {seat + 1}
												</div>
												<div className="player-chips" id={`${playerId}-chips`}>
													Waiting...
												</div>
											</div>
											<div
												className="player-status"
												id={`${playerId}-status`}
											></div>
											{canClaimSeat ? (
												<button
													type="button"
													className="seat-claim-btn"
													onClick={() =>
														void sendActionWithDebug(
															"join_game",
															{
																seat: backendSeat,
															},
															"seat",
														)
													}
												>
													{claimButtonLabel}
												</button>
											) : reservedSeatLabel ? (
												<div className="seat-reserved-badge">
													{reservedSeatLabel}
												</div>
											) : null}
										</div>
									</div>

									<div className="seat-bet-anchor" style={style}>
										<div className="seat-bet" id={`${playerId}-bet`}></div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>

			<div
				className="controls-container glass-panel anim-slide-up"
				style={{ animationDelay: "0.2s" }}
			>
				<div className="controls-top">
					<div className="action-state" id="action-state">
						Waiting for action...
					</div>
					<div className="controls-strip-actions">
						{ownedPlayer ? (
							<button
								type="button"
								className="btn tiny"
								onClick={() =>
									void sendActionWithDebug(
										ownedPlayer.will_play_next_hand ? "sit_out" : "sit_in",
										undefined,
										"seat-control",
									)
								}
							>
								{ownedPlayer.will_play_next_hand ? "Sit Out" : "Sit In"}
							</button>
						) : pendingPlayer ? (
							<>
								<span className="controls-strip-hint">
									{pendingPlayer.will_play_next_hand
										? `Queued for seat ${pendingPlayer.desired_seat} next hand`
										: `Waiting: seat ${pendingPlayer.desired_seat}`}
								</span>
								<button
									type="button"
									className="btn tiny"
									onClick={() =>
										void sendActionWithDebug(
											pendingPlayer.will_play_next_hand ? "sit_out" : "sit_in",
											undefined,
											"seat-control",
										)
									}
								>
									{pendingPlayer.will_play_next_hand
										? "Sit Out"
										: "Play Next Hand"}
								</button>
							</>
						) : (
							<span className="controls-strip-hint">Click a seat to join</span>
						)}
						{canRevealCompletedHand ? (
							<button
								type="button"
								className="btn tiny"
								onClick={() =>
									void sendActionWithDebug(
										"set_card_visibility",
										{ show_cards: !ownedPlayer.show_cards },
										"post-hand",
									)
								}
							>
								{ownedPlayer.show_cards ? "Hide Cards" : "Show Cards"}
							</button>
						) : null}
						{isCustomTable &&
						backendTable?.hand_state.status !== "in_progress" ? (
							<>
								<button
									type="button"
									className="btn tiny"
									disabled={!canAddBot}
									onClick={() =>
										void sendActionWithDebug(
											"add_bot",
											undefined,
											"table-setup",
										)
									}
								>
									+ Bot
								</button>
								<button
									type="button"
									className="btn tiny"
									disabled={!canClearTable}
									onClick={() =>
										void sendActionWithDebug(
											"clear_table",
											undefined,
											"table-setup",
										)
									}
								>
									Clear
								</button>
							</>
						) : null}
						{backendTable?.game_state === "waiting_for_hand" &&
						readySeats >= 2 ? (
							<button
								type="button"
								className="btn primary tiny"
								onClick={() =>
									void sendActionWithDebug("next_hand", undefined, "manual")
								}
							>
								Next Hand
							</button>
						) : null}
					</div>
				</div>

				<div className="bet-sizing-row">
					<div className="preset-group">
						<button
							type="button"
							className="preset-btn bb-preset"
							id="btn-min"
							onClick={() => handleSliderPreset("min")}
						>
							Min
						</button>
						<button
							type="button"
							className="preset-btn bb-preset"
							onClick={() => handleSliderPresetBB(2)}
						>
							2BB
						</button>
						<button
							type="button"
							className="preset-btn bb-preset"
							onClick={() => handleSliderPresetBB(3)}
						>
							3BB
						</button>
					</div>
					<div className="preset-sep" />
					<div className="preset-group">
						<button
							type="button"
							className="preset-btn pot-preset"
							onClick={() => handleSliderPreset("halfpot")}
						>
							½ Pot
						</button>
						<button
							type="button"
							className="preset-btn pot-preset"
							id="btn-pot"
							onClick={() => handleSliderPreset("pot")}
						>
							Pot
						</button>
					</div>
					<div className="slider-zone">
						<input
							type="range"
							id="bet-slider"
							min="0"
							max="1000"
							defaultValue="0"
							onInput={handleSliderInput}
						/>
						<span id="bet-amount-display">🪙 0</span>
					</div>
					<button
						type="button"
						className="preset-btn allin-preset"
						id="btn-max"
						onClick={() => handleSliderPreset("max")}
					>
						All-in
					</button>
				</div>

				<div className="main-actions">
					<button
						type="button"
						className="btn action-fold danger"
						id="btn-fold"
						onClick={handleFoldClick}
					>
						Fold
					</button>
					<button
						type="button"
						className="btn action-call"
						id="btn-call"
						data-action="check"
						onClick={handleCallClick}
					>
						Check
					</button>
					<button
						type="button"
						className="btn action-raise primary"
						id="btn-raise"
						data-action="bet"
						onClick={handleRaiseClick}
					>
						Bet
					</button>
				</div>
			</div>

			<aside
				className={`action-sidebar glass-panel anim-slide-up${handLogCollapsed ? " is-collapsed" : ""}`}
				style={{ animationDelay: "0.12s" }}
			>
				<div className="action-sidebar-header">
					{!handLogCollapsed ? <h2>Hand Log</h2> : null}
					<button
						type="button"
						className="btn tiny action-sidebar-toggle"
						onClick={() => setHandLogCollapsed((collapsed) => !collapsed)}
					>
						{handLogCollapsed ? "Hand Log" : "Hide Hand Log"}
					</button>
				</div>

				<section className="hand-result">
					<div className="hand-result-title" id="hand-result-title">
						Hand in progress
					</div>
					<ul className="hand-result-lines" id="hand-result-lines">
						<li>Every action will be listed here live.</li>
					</ul>
				</section>

				<section className="action-log">
					<ol id="action-log-list"></ol>
				</section>
			</aside>
		</div>
	);
}

export default function App() {
	const [selectedTableId, setSelectedTableId] = useState<string | null>(() =>
		typeof window === "undefined"
			? null
			: getTableIdFromHash(window.location.hash),
	);

	useEffect(() => {
		if (typeof window === "undefined") return;

		const syncRoute = () => {
			setSelectedTableId(getTableIdFromHash(window.location.hash));
		};

		syncRoute();
		window.addEventListener("hashchange", syncRoute);

		return () => {
			window.removeEventListener("hashchange", syncRoute);
		};
	}, []);

	if (!selectedTableId) {
		return <LobbyScreen />;
	}

	return (
		<TableScreen
			key={selectedTableId}
			tableId={selectedTableId}
			isCustomTable={selectedTableId !== DEFAULT_TABLE.tableId}
		/>
	);
}
