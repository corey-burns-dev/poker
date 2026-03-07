import { describe, expect, test } from "bun:test";
import type { BackendTable } from "../../types/backend";
import { PhoenixPokerGame } from "../PhoenixPokerGame";

function buildTable(overrides: Partial<BackendTable> = {}): BackendTable {
	return {
		table_id: "default",
		players: [
			{
				seat: 1,
				name: "Chris",
				stack: 4980,
				status: "ACTIVE",
				is_bot: false,
				will_play_next_hand: true,
				player_id: "player-test-1",
				connected: true,
				bet_this_street: 20,
				contributed_this_hand: 20,
				hole_cards: ["Ah", "Ad"],
			},
			{
				seat: 2,
				name: "Alice",
				stack: 4980,
				status: "ACTIVE",
				is_bot: true,
				will_play_next_hand: true,
				player_id: null,
				connected: false,
				bet_this_street: 20,
				contributed_this_hand: 20,
				hole_cards: ["Kh", "Qh"],
			},
		],
		pending_players: [],
		game_state: "hand_in_progress",
		hand_number: 2,
		connected_clients: 1,
		last_event: "hand_2_started",
		hand_state: {
			status: "in_progress",
			stage: "flop",
			hand_number: 2,
			pot: 80,
			current_bet: 20,
			minimum_raise: 20,
			acting_seat: 1,
			dealer_seat: 2,
			small_blind_seat: 3,
			big_blind_seat: 4,
			community_cards: ["2h", "7d", "Tc"],
			action_log: ["Hand 2 started."],
			last_action: "hand_started",
			acted_seats: [],
			winner_seats: [],
			winner_amounts: {},
			hand_result: null,
		},
		...overrides,
	};
}

describe("PhoenixPokerGame", () => {
	test("startRound sends next_hand to the backend action handler", async () => {
		const actions: Array<{
			action: string;
			payload?: { amount?: number; seat?: number };
		}> = [];
		const game = new PhoenixPokerGame(
			"player-test-1",
			async (action, payload) => {
				actions.push({ action, payload });
			},
		);

		await game.startRound();

		expect(actions).toEqual([{ action: "next_hand", payload: undefined }]);
	});

	test("maps backend table state into renderer state", () => {
		const game = new PhoenixPokerGame("player-test-1", async () => {});
		game.sync(buildTable());

		expect(game.view.street).toBe("FLOP");
		expect(game.view.actionTo).toBe(0);
		expect(game.view.board).toEqual(["2h", "7d", "Tc"]);
		expect(game.view.players[0]?.hand).toEqual(["Ah", "Ad"]);
		expect(game.view.players[1]?.hand).toEqual(["Kh", "Qh"]);
		expect(game.view.currentBets.get(0)).toBe(20);
	});

	test("exposes showdown winners and result summary", () => {
		const game = new PhoenixPokerGame("player-test-1", async () => {});
		const table = buildTable({
			game_state: "waiting_for_hand",
			hand_state: {
				...buildTable().hand_state,
				status: "complete",
				stage: "showdown",
				acting_seat: null,
				winner_seats: [1],
				winner_amounts: { "1": 80 },
				hand_result: {
					heading: "Seat 1 wins",
					lines: ["Showdown. Seat 1 drags the pot of 80."],
					hero_outcome: "win",
				},
			},
		});

		game.sync(table);

		expect(game.view.winners).toEqual([{ seat: 0, amount: 80 }]);
		expect(game.handResultSummary?.heading).toBe("Chris wins");
		expect(game.handResultSummary?.lines).toEqual([
			"Showdown. Chris drags the pot of 80.",
		]);
		expect(game.handResultSummary?.heroOutcome).toBe("win");
	});

	test("replaces seat numbers with player names in the action log", () => {
		const game = new PhoenixPokerGame("player-test-1", async () => {});
		game.sync(
			buildTable({
				hand_state: {
					...buildTable().hand_state,
					action_log: [
						"Seat 1 calls 20.",
						"Seat 2 raises to 80.",
						"Action on seat 1.",
					],
				},
			}),
		);

		expect(game.actionLogEntries).toEqual([
			"Chris calls 20.",
			"Alice raises to 80.",
			"Action on Chris.",
		]);
	});

	test("treats fold wins as non-showdown completions and requires manual restart for humans", () => {
		const game = new PhoenixPokerGame("player-test-1", async () => {});
		game.sync(
			buildTable({
				game_state: "waiting_for_hand",
				players: [
					{
						seat: 1,
						name: "Chris",
						stack: 5060,
						status: "READY",
						is_bot: false,
						will_play_next_hand: true,
						player_id: "player-test-1",
						connected: true,
						bet_this_street: 0,
						contributed_this_hand: 60,
						hole_cards: ["Ah", "Ad"],
					},
					{
						seat: 2,
						name: "Alice",
						stack: 4940,
						status: "READY",
						is_bot: true,
						will_play_next_hand: true,
						player_id: null,
						connected: false,
						bet_this_street: 0,
						contributed_this_hand: 40,
						hole_cards: ["Kh", "Qh"],
					},
				],
				hand_state: {
					...buildTable().hand_state,
					status: "complete",
					stage: "showdown",
					acting_seat: null,
					winner_seats: [1],
					winner_amounts: { "1": 100 },
					hand_result: {
						heading: "Seat 1 wins by fold",
						lines: ["Hand ends by fold. Seat 1 wins 100."],
						hero_outcome: "win",
					},
				},
			}),
		);

		expect(game.view.handEndMode).toBe("fold");
		expect(game.view.manualStartRequired).toBe(true);
		expect(game.handResultSummary?.heading).toBe("Chris wins by fold");
		expect(game.handResultSummary?.lines).toEqual([
			"Hand ends by fold. Chris wins 100.",
		]);
	});

	test("emits deal sound events from backend deal transitions", () => {
		const game = new PhoenixPokerGame("player-test-1", async () => {});
		const emitted: string[] = [];
		game.onSoundEvent = (event) => {
			if (
				event.type === "hand_start" ||
				event.type === "street_flop" ||
				event.type === "street_turn" ||
				event.type === "street_river"
			) {
				emitted.push(event.type);
			}
		};

		game.sync(
			buildTable({
				last_event: "hand_3_started",
				hand_number: 3,
				hand_state: {
					...buildTable().hand_state,
					hand_number: 3,
					stage: "preflop",
					community_cards: [],
				},
			}),
		);
		game.sync(
			buildTable({
				last_event: "flop_dealt",
				hand_state: {
					...buildTable().hand_state,
					stage: "flop",
					community_cards: ["2h", "7d", "Tc"],
				},
			}),
		);
		game.sync(
			buildTable({
				last_event: "turn_dealt",
				hand_state: {
					...buildTable().hand_state,
					stage: "turn",
					community_cards: ["2h", "7d", "Tc", "Jc"],
				},
			}),
		);
		game.sync(
			buildTable({
				last_event: "river_dealt",
				hand_state: {
					...buildTable().hand_state,
					stage: "river",
					community_cards: ["2h", "7d", "Tc", "Jc", "As"],
				},
			}),
		);

		expect(emitted).toEqual([
			"hand_start",
			"street_flop",
			"street_turn",
			"street_river",
		]);
	});
});
