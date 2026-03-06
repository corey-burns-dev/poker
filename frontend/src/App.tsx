import type { CSSProperties } from "react";
import {
	useCallback,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";
import { PhoenixPokerGame } from "./game/PhoenixPokerGame";
import { usePhoenixTable } from "./hooks/usePhoenixTable";
import type { Renderer } from "./ui/Renderer";

const MAX_SEATS = 8;
const TABLE_HASH_PREFIX = "#/tables/";

type SeatLayout = {
	seatX: number;
	seatY: number;
	betX: number;
	betY: number;
};

type OpenGame = {
	tableId: string;
	name: string;
	stakes: string;
	bots: number;
	openSeats: number;
};

type TableActionPayload = {
	amount?: number;
	seat?: number;
	show_cards?: boolean;
};

const OPEN_GAMES: OpenGame[] = [
	{
		tableId: "default",
		name: "Bot Warmup Table",
		stakes: "10 / 20",
		bots: 7,
		openSeats: 1,
	},
];

const DESKTOP_SEAT_LAYOUTS: SeatLayout[] = [
	{ seatX: 50, seatY: 92, betX: 50, betY: 79 },
	{ seatX: 23, seatY: 82, betX: 30, betY: 72 },
	{ seatX: 10, seatY: 50, betX: 23, betY: 50 },
	{ seatX: 23, seatY: 18, betX: 30, betY: 28 },
	{ seatX: 50, seatY: 8, betX: 50, betY: 21 },
	{ seatX: 77, seatY: 18, betX: 70, betY: 28 },
	{ seatX: 90, seatY: 50, betX: 77, betY: 50 },
	{ seatX: 77, seatY: 82, betX: 70, betY: 72 },
];

const TABLET_SEAT_LAYOUTS: SeatLayout[] = [
	{ seatX: 50, seatY: 90, betX: 50, betY: 78 },
	{ seatX: 22, seatY: 80, betX: 30, betY: 70 },
	{ seatX: 11, seatY: 50, betX: 24, betY: 50 },
	{ seatX: 22, seatY: 20, betX: 30, betY: 30 },
	{ seatX: 50, seatY: 17, betX: 50, betY: 29 },
	{ seatX: 78, seatY: 20, betX: 70, betY: 30 },
	{ seatX: 89, seatY: 50, betX: 76, betY: 50 },
	{ seatX: 78, seatY: 80, betX: 70, betY: 70 },
];

const MOBILE_PORTRAIT_SEAT_LAYOUTS: SeatLayout[] = [
	{ seatX: 50, seatY: 88, betX: 50, betY: 76 },
	{ seatX: 24, seatY: 77, betX: 31, betY: 68 },
	{ seatX: 13, seatY: 50, betX: 24, betY: 50 },
	{ seatX: 24, seatY: 28, betX: 31, betY: 36 },
	{ seatX: 50, seatY: 18, betX: 50, betY: 29 },
	{ seatX: 76, seatY: 28, betX: 69, betY: 36 },
	{ seatX: 87, seatY: 50, betX: 76, betY: 50 },
	{ seatX: 76, seatY: 77, betX: 69, betY: 68 },
];

const MOBILE_LANDSCAPE_SEAT_LAYOUTS: SeatLayout[] = [
	{ seatX: 50, seatY: 84, betX: 50, betY: 71 },
	{ seatX: 26, seatY: 73, betX: 32, betY: 64 },
	{ seatX: 15, seatY: 50, betX: 25, betY: 50 },
	{ seatX: 26, seatY: 29, betX: 32, betY: 37 },
	{ seatX: 50, seatY: 21, betX: 50, betY: 33 },
	{ seatX: 74, seatY: 29, betX: 68, betY: 37 },
	{ seatX: 85, seatY: 50, betX: 75, betY: 50 },
	{ seatX: 74, seatY: 73, betX: 68, betY: 64 },
];

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

function LobbyScreen() {
	return (
		<div id="app" className="app-lobby">
			<section className="lobby-shell glass-panel anim-slide-up">
				<div className="lobby-copy">
					<p className="backend-eyebrow">Open games</p>
					<h1>Join a table that is ready to run.</h1>
					<p className="lobby-subcopy">
						For now the lobby exposes a single table with seven bots and one
						open seat for you.
					</p>
				</div>

				<ul className="lobby-list" aria-label="Open games">
					{OPEN_GAMES.map((game) => (
						<li key={game.tableId} className="lobby-card glass-panel">
							<div>
								<p className="lobby-card-label">Cash game</p>
								<h2>{game.name}</h2>
								<p className="lobby-card-meta">
									{game.bots} bots, {game.openSeats} open seat, blinds{" "}
									{game.stakes}
								</p>
							</div>

							<div className="lobby-card-stats">
								<div>
									<span>Table ID</span>
									<strong>{game.tableId}</strong>
								</div>
								<div>
									<span>Status</span>
									<strong>Open</strong>
								</div>
							</div>

							<button
								type="button"
								className="btn primary lobby-join-btn"
								onClick={() => navigateToTable(game.tableId)}
							>
								Open Table
							</button>
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}

function TableScreen({ tableId }: { tableId: string }) {
	const gameRef = useRef<PhoenixPokerGame | null>(null);
	const rendererRef = useRef<Renderer | null>(null);
	const autoStartAttemptRef = useRef<string | null>(null);
	const [backendOverlayCollapsed, setBackendOverlayCollapsed] = useState(true);
	const [handLogCollapsed, setHandLogCollapsed] = useState(true);
	const [seatLayouts, setSeatLayouts] =
		useState<SeatLayout[]>(DESKTOP_SEAT_LAYOUTS);
	const { playerId, backendHealth, backendTable, backendState, sendAction } =
		usePhoenixTable(tableId);
	const occupiedSeats = backendTable?.players.length ?? 0;
	const botSeats =
		backendTable?.players.filter((player) => player.is_bot).length ?? 0;
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
		(preset: "min" | "half" | "pot" | "max") => {
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

			if (preset === "half") {
				const value = Math.floor((min + max) / 2);
				setSliderValue(value);
				logControlDebug(`preset:half -> ${value} (min=${min} max=${max})`);
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
	}, [backendTable, readySeats, sendActionWithDebug]);

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
							const backendSeat = seat + 1;
							const backendPlayer = backendTable?.players.find(
								(player) => player.seat === backendSeat,
							);
							const canClaimSeat =
								!ownedPlayer &&
								!pendingPlayer &&
								backendPlayer?.is_bot &&
								!reservedSeats.has(backendSeat);
							const reservedSeatLabel = reservedSeatLabels.get(backendSeat);

							return (
								<div className="seat-slot" key={playerId}>
									<div className="seat-anchor" style={style}>
										<div
											className={`player-area${isHeroSeat ? " is-you" : ""}${canClaimSeat ? " is-claimable" : ""}${reservedSeatLabel ? " is-reserved" : ""}`}
											id={`seat-${seat}`}
										>
											<div className="avatar-row">
												<div
													className="player-avatar"
													id={`${playerId}-avatar`}
												>
													{isHeroSeat ? "Y" : seat + 1}
												</div>
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
													Take Seat {backendSeat}
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
				<div className="table-seat-controls">
					{ownedPlayer ? (
						<>
							<div className="seat-control-copy">
								<span>Your seat</span>
								<strong>
									{ownedPlayer.name} at seat {ownedPlayer.seat}
								</strong>
								<p>
									{ownedPlayer.will_play_next_hand
										? "You are seated and will be dealt into the next hand after the 5 second pause."
										: "You are still seated at this table, but you are sitting out until you opt back in."}
								</p>
							</div>
							<div className="seat-control-actions">
								<button
									type="button"
									className="btn"
									onClick={() =>
										void sendActionWithDebug(
											ownedPlayer.will_play_next_hand ? "sit_out" : "sit_in",
											undefined,
											"seat-control",
										)
									}
								>
									{ownedPlayer.will_play_next_hand
										? "Sit Out"
										: "Play Next Hand"}
								</button>
							</div>
						</>
					) : pendingPlayer ? (
						<>
							<div className="seat-control-copy">
								<span>Waiting for seat</span>
								<strong>
									{pendingPlayer.name} for seat {pendingPlayer.desired_seat}
								</strong>
								<p>
									{pendingPlayer.will_play_next_hand
										? "You are queued for the next available seat and will be dealt in when assigned."
										: "You are on the waitlist. Opt in when you want the next available seat."}
								</p>
							</div>
							<button
								type="button"
								className="btn"
								onClick={() =>
									void sendActionWithDebug(
										pendingPlayer.will_play_next_hand ? "sit_out" : "sit_in",
										undefined,
										"seat-control",
									)
								}
							>
								{pendingPlayer.will_play_next_hand
									? "Wait Without Playing"
									: "Play When Seated"}
							</button>
						</>
					) : (
						<div className="seat-control-copy">
							<span>Choose seat</span>
							<strong>Click an open seat on the table</strong>
							<p>
								You will replace that bot as soon as the current hand reaches a
								safe swap point.
							</p>
						</div>
					)}
				</div>

				{backendTable?.game_state === "waiting_for_hand" && readySeats >= 2 ? (
					<div className="between-hand-actions">
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
						<button
							type="button"
							className="btn primary"
							onClick={() =>
								void sendActionWithDebug("next_hand", undefined, "manual")
							}
						>
							Start Next Hand
						</button>
					</div>
				) : null}

				<div className="action-state" id="action-state">
					Waiting for action...
				</div>

				<div className="bet-slider-container">
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

				<div className="btn-group">
					<button
						type="button"
						className="btn tiny"
						id="btn-min"
						onClick={() => handleSliderPreset("min")}
					>
						Min
					</button>
					<button
						type="button"
						className="btn tiny"
						id="btn-half"
						onClick={() => handleSliderPreset("half")}
					>
						1/2
					</button>
					<button
						type="button"
						className="btn tiny"
						id="btn-pot"
						onClick={() => handleSliderPreset("pot")}
					>
						Pot
					</button>
					<button
						type="button"
						className="btn tiny"
						id="btn-max"
						onClick={() => handleSliderPreset("max")}
					>
						Max
					</button>
				</div>

				<div className="main-actions">
					<button
						type="button"
						className="btn danger"
						id="btn-fold"
						onClick={handleFoldClick}
					>
						Fold
					</button>
					<button
						type="button"
						className="btn"
						id="btn-call"
						data-action="check"
						onClick={handleCallClick}
					>
						Check
					</button>
					<button
						type="button"
						className="btn primary"
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

	return <TableScreen key={selectedTableId} tableId={selectedTableId} />;
}
