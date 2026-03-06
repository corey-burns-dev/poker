import type { BackendTable } from "../types/backend";

export type PokerSoundEvent =
	| { type: "hand_start" }
	| { type: "turn_start"; seat: number }
	| { type: "fold"; seat: number }
	| { type: "check"; seat: number }
	| { type: "call"; seat: number }
	| { type: "bet"; seat: number; amount: number }
	| { type: "raise"; seat: number; amount: number }
	| { type: "street_flop" }
	| { type: "street_turn" }
	| { type: "street_river" }
	| { type: "street_showdown" }
	| { type: "pot_awarded"; winners: number };

export interface HandResultSummary {
	heading: string;
	lines: string[];
	heroOutcome: "win" | "loss" | "split" | "folded" | "info";
}

type TableActionPayload = {
	amount?: number;
	seat?: number;
	show_cards?: boolean;
};

export type ClientPlayer = {
	seat: number;
	name: string;
	stack: number;
	status: string;
	isBot: boolean;
	isCurrentUser: boolean;
	willPlayNextHand: boolean;
	showCards: boolean;
	betThisStreet: number;
	hand: Array<string | null>;
};

export type ClientState = {
	players: Array<ClientPlayer | null>;
	actionTo: number | null;
	street: "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";
	pots: Array<{ amount: number }>;
	currentBets: Map<number, number>;
	smallBlind: number;
	bigBlind: number;
	lastRaiseAmount: number;
	board: string[];
	winners: Array<{ seat: number; amount: number }> | null;
	buttonSeat: number;
};

export class PhoenixPokerGame {
	config = {
		maxPlayers: 8,
		smallBlind: 10,
		bigBlind: 20,
	};

	onStateChange: () => void = () => {};
	onMessage: (msg: string) => void = () => {};
	onActionLogUpdate: (entries: readonly string[]) => void = () => {};
	onHandResultUpdate: (result: HandResultSummary | null) => void = () => {};
	onSoundEvent: (event: PokerSoundEvent) => void = () => {};

	private table: BackendTable | null = null;
	private readonly playerId: string;
	private readonly sendActionFn: (
		action: string,
		payload?: TableActionPayload,
	) => Promise<void>;

	constructor(
		playerId: string,
		sendAction: (action: string, payload?: TableActionPayload) => Promise<void>,
	) {
		this.playerId = playerId;
		this.sendActionFn = sendAction;
	}

	sync(table: BackendTable) {
		const previous = this.table;
		this.table = table;

		if (previous?.hand_state.hand_number !== table.hand_state.hand_number) {
			this.onSoundEvent({ type: "hand_start" });
			this.onMessage(`Hand ${table.hand_state.hand_number} started.`);
		}

		const previousStage = previous?.hand_state.stage;
		if (previousStage !== table.hand_state.stage) {
			if (table.hand_state.stage === "flop")
				this.onSoundEvent({ type: "street_flop" });
			if (table.hand_state.stage === "turn")
				this.onSoundEvent({ type: "street_turn" });
			if (table.hand_state.stage === "river")
				this.onSoundEvent({ type: "street_river" });
			if (table.hand_state.stage === "showdown")
				this.onSoundEvent({ type: "street_showdown" });
		}

		const previousActor = previous?.hand_state.acting_seat;
		if (
			previousActor !== table.hand_state.acting_seat &&
			table.hand_state.acting_seat
		) {
			this.onSoundEvent({
				type: "turn_start",
				seat: table.hand_state.acting_seat - 1,
			});
		}

		const log = this.actionLogEntries;
		this.onActionLogUpdate(log);
		this.onHandResultUpdate(this.handResultSummary);
		this.onStateChange();
	}

	get state(): ClientState {
		return this.buildState();
	}

	get view(): ClientState {
		return this.buildState();
	}

	get actionLogEntries(): readonly string[] {
		return this.table?.hand_state.action_log ?? ["Connecting to table..."];
	}

	get handResultSummary(): HandResultSummary | null {
		const result = this.table?.hand_state.hand_result;
		if (!result) return null;
		return {
			heading: result.heading,
			lines: result.lines,
			heroOutcome: result.hero_outcome,
		};
	}

	get thinkingSeat(): number | null {
		const actingSeat = this.table?.hand_state.acting_seat;
		const heroSeat = this.heroSeatIndex;
		if (!actingSeat || actingSeat - 1 === heroSeat) return null;
		return actingSeat - 1;
	}

	get heroSeatIndex(): number | null {
		const seat = this.table?.players.find(
			(player) => player.player_id === this.playerId,
		)?.seat;
		return seat ? seat - 1 : null;
	}

	async startRound() {
		await this.sendActionFn("next_hand");
	}

	async handlePlayerAction(
		action: "fold" | "check" | "call" | "bet" | "raise",
		amount?: number,
	) {
		await this.sendActionFn(action, amount == null ? undefined : { amount });
	}

	private buildState(): ClientState {
		const table = this.table;
		const players = table?.players ?? [];
		const currentBets = new Map<number, number>();
		const heroSeatIndex = this.heroSeatIndex;

		const mappedPlayers: Array<ClientPlayer | null> = Array.from(
			{ length: this.config.maxPlayers },
			(_, index) => {
				const backendPlayer = players.find(
					(candidate) => candidate.seat === index + 1,
				);
				if (!backendPlayer) {
					return null;
				}

				const betThisStreet = backendPlayer.bet_this_street ?? 0;
				currentBets.set(index, betThisStreet);

				const holeCards = (backendPlayer.hole_cards ?? [null, null]).map(
					(card) => {
						if (card == null) return null;
						if (
							index === heroSeatIndex ||
							backendPlayer.is_bot ||
							backendPlayer.show_cards
						) {
							return card;
						}
						return "__back__";
					},
				);

				return {
					seat: index,
					name: backendPlayer.name,
					stack: backendPlayer.stack,
					status: this.mapStatus(backendPlayer.status),
					isBot: backendPlayer.is_bot,
					isCurrentUser: backendPlayer.player_id === this.playerId,
					willPlayNextHand: backendPlayer.will_play_next_hand,
					showCards: backendPlayer.show_cards,
					betThisStreet,
					hand: holeCards,
				};
			},
		);

		const committedBets = Array.from(currentBets.values()).reduce(
			(sum, bet) => sum + bet,
			0,
		);
		const potBase = Math.max((table?.hand_state.pot ?? 0) - committedBets, 0);
		const stage = this.mapStage(table?.hand_state.stage ?? "preflop");
		const winners =
			table?.hand_state.winner_seats?.map((seat: number) => ({
				seat: seat - 1,
				amount:
					table.hand_state.winner_amounts?.[String(seat)] ??
					table.hand_state.pot,
			})) ?? null;

		return {
			players: mappedPlayers,
			actionTo:
				table?.hand_state.acting_seat != null
					? table.hand_state.acting_seat - 1
					: null,
			street: stage,
			pots: [{ amount: potBase }],
			currentBets,
			smallBlind: this.config.smallBlind,
			bigBlind: this.config.bigBlind,
			lastRaiseAmount: table?.hand_state.minimum_raise ?? this.config.bigBlind,
			board: table?.hand_state.community_cards ?? [],
			winners: table?.hand_state.status === "complete" ? winners : null,
			buttonSeat: (table?.hand_state.dealer_seat ?? 1) - 1,
		};
	}

	private mapStatus(status: string) {
		if (status === "FOLDED") return "FOLDED";
		if (status === "BUSTED") return "BUSTED";
		if (status === "ALL_IN") return "ALL_IN";
		if (status === "SITTING_OUT") return "SITTING_OUT";
		if (status === "READY") return "READY";
		return "ACTIVE";
	}

	private mapStage(stage: string): ClientState["street"] {
		if (stage === "flop") return "FLOP";
		if (stage === "turn") return "TURN";
		if (stage === "river") return "RIVER";
		if (stage === "showdown") return "SHOWDOWN";
		return "PREFLOP";
	}
}
