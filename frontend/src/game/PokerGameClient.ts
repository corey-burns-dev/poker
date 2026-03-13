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
  | { type: "show" }
  | { type: "muck" }
  | { type: "timeout" }
  | { type: "uncalled_bet_returned" }
  | { type: "add_chips" }
  | { type: "pot_awarded"; winners: number; heroOutcome?: string };

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
  contributedThisHand: number;
  hand: Array<string | null>;
};

export type ClientState = {
  players: Array<ClientPlayer | null>;
  actionTo: number | null;
  street: "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";
  handNumber: number | null;
  pots: Array<{ amount: number }>;
  currentBets: Map<number, number>;
  smallBlind: number;
  bigBlind: number;
  lastRaiseAmount: number;
  board: string[];
  winners: Array<{ seat: number; amount: number }> | null;
  buttonSeat: number;
  smallBlindSeat: number | null;
  bigBlindSeat: number | null;
  handEndMode: "fold" | "showdown" | null;
  manualStartRequired: boolean;
};

export class PokerGameClient {
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
  private readonly sendActionFn: (action: string, payload?: TableActionPayload) => Promise<void>;

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

    const previousLastEvent = previous?.last_event;
    const nextLastEvent = table.last_event;
    const dealSoundFromEvent =
      previousLastEvent !== nextLastEvent ? this.mapDealSoundEvent(nextLastEvent) : null;
    if (dealSoundFromEvent != null) {
      this.onSoundEvent(dealSoundFromEvent);
      if (dealSoundFromEvent.type === "hand_start") {
        this.onMessage(`Hand ${table.hand_state.hand_number} started.`);
      }
    } else {
      const previousStage = previous?.hand_state.stage;
      if (previousStage !== table.hand_state.stage) {
        if (table.hand_state.stage === "flop") this.onSoundEvent({ type: "street_flop" });
        if (table.hand_state.stage === "turn") this.onSoundEvent({ type: "street_turn" });
        if (table.hand_state.stage === "river") this.onSoundEvent({ type: "street_river" });
      }
      if (previous?.hand_state.hand_number !== table.hand_state.hand_number) {
        this.onSoundEvent({ type: "hand_start" });
        this.onMessage(`Hand ${table.hand_state.hand_number} started.`);
      }
    }

    if (
      previous?.hand_state.stage !== table.hand_state.stage &&
      table.hand_state.stage === "showdown"
    ) {
      this.onSoundEvent({ type: "street_showdown" });
    }

    const previousActor = previous?.hand_state.acting_seat;
    if (previousActor !== table.hand_state.acting_seat && table.hand_state.acting_seat) {
      this.onSoundEvent({
        type: "turn_start",
        seat: table.hand_state.acting_seat - 1,
      });
    }

    if (previous) {
      let emittedActionSound = false;
      const prevLogLen = previous.hand_state.action_log?.length ?? 0;
      const nextLogLen = table.hand_state.action_log?.length ?? 0;
      const prevLogSeq = previous.hand_state.action_log_seq ?? prevLogLen;
      const nextLogSeq = table.hand_state.action_log_seq ?? nextLogLen;
      const logDelta = Math.max(nextLogSeq - prevLogSeq, 0);
      const logGap = logDelta > nextLogLen;

      if (logDelta > 0 && !logGap) {
        const newLogs = table.hand_state.action_log.slice(nextLogLen - logDelta);
        for (const log of newLogs) {
          const soundEvent = this.mapActionSoundEvent(log);
          if (soundEvent) {
            this.onSoundEvent(soundEvent);
            emittedActionSound = true;
          }
        }
      }

      if (!emittedActionSound && previousLastEvent !== nextLastEvent) {
        const soundEvent = this.mapActionSoundEvent(nextLastEvent);
        if (soundEvent) {
          this.onSoundEvent(soundEvent);
        }
      }

      if (
        previous.hand_state.status !== table.hand_state.status &&
        table.hand_state.status === "complete"
      ) {
        const outcome = table.hand_state.hand_result?.hero_outcome;
        const winners = table.hand_state.winner_seats?.length ?? 0;
        this.onSoundEvent({
          type: "pot_awarded",
          winners,
          heroOutcome: outcome,
        });
        const completionMessage = this.handCompletionMessage();
        if (completionMessage) this.onMessage(completionMessage);
      }
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
    return (
      this.table?.hand_state.action_log.map((line) => this.replaceSeatLabels(line)) ?? [
        "Connecting to table...",
      ]
    );
  }

  get handResultSummary(): HandResultSummary | null {
    const result = this.table?.hand_state.hand_result;
    if (!result) return null;
    const lines = result.lines.map((line) => this.replaceSeatLabels(line));
    const isFoldWin = lines.some((line) => line.startsWith("Hand ends by fold."));
    const heading = this.replaceSeatLabels(result.heading);
    return {
      heading:
        isFoldWin && !heading.toLowerCase().includes("by fold") ? `${heading} by fold` : heading,
      lines,
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
    const seat = this.table?.players.find((player) => player.player_id === this.playerId)?.seat;
    return seat ? seat - 1 : null;
  }

  async startRound() {
    await this.sendActionFn("next_hand");
  }

  async handlePlayerAction(action: "fold" | "check" | "call" | "bet" | "raise", amount?: number) {
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
        const backendPlayer = players.find((candidate) => candidate.seat === index + 1);
        if (!backendPlayer) {
          return null;
        }

        const betThisStreet = backendPlayer.bet_this_street ?? 0;
        const contributedThisHand = backendPlayer.contributed_this_hand ?? 0;
        currentBets.set(index, betThisStreet);

        const holeCards = (backendPlayer.hole_cards ?? [null, null]).map((card) => {
          if (card == null) return null;
          if (index === heroSeatIndex || backendPlayer.is_bot || backendPlayer.show_cards) {
            return card;
          }
          return "__back__";
        });

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
          contributedThisHand,
          hand: holeCards,
        };
      },
    );

    const committedBets = Array.from(currentBets.values()).reduce((sum, bet) => sum + bet, 0);
    const potBase = Math.max((table?.hand_state.pot ?? 0) - committedBets, 0);
    const stage = this.mapStage(table?.hand_state.stage ?? "preflop");
    const handEndMode = this.handEndMode(table);
    const winners =
      table?.hand_state.winner_seats?.map((seat: number) => ({
        seat: seat - 1,
        amount: table.hand_state.winner_amounts?.[String(seat)] ?? table.hand_state.pot,
      })) ?? null;

    return {
      players: mappedPlayers,
      actionTo: table?.hand_state.acting_seat != null ? table.hand_state.acting_seat - 1 : null,
      street: stage,
      handNumber: table?.hand_state.hand_number ?? null,
      pots: [{ amount: potBase }],
      currentBets,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      lastRaiseAmount: table?.hand_state.minimum_raise ?? this.config.bigBlind,
      board: table?.hand_state.community_cards ?? [],
      winners: table?.hand_state.status === "complete" ? winners : null,
      buttonSeat: (table?.hand_state.dealer_seat ?? 1) - 1,
      smallBlindSeat:
        table?.hand_state.small_blind_seat != null ? table.hand_state.small_blind_seat - 1 : null,
      bigBlindSeat:
        table?.hand_state.big_blind_seat != null ? table.hand_state.big_blind_seat - 1 : null,
      handEndMode,
      manualStartRequired: this.manualStartRequired(table),
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

  private mapDealSoundEvent(lastEvent: string): PokerSoundEvent | null {
    if (/^hand_\d+_started$/.test(lastEvent)) return { type: "hand_start" };
    if (lastEvent === "flop_dealt") return { type: "street_flop" };
    if (lastEvent === "turn_dealt") return { type: "street_turn" };
    if (lastEvent === "river_dealt") return { type: "street_river" };
    return null;
  }

  private mapActionSoundEvent(text: string): PokerSoundEvent | null {
    const seat = this.parseSeatIndex(text);
    if (/folds\./i.test(text) && seat != null) return { type: "fold", seat };
    if (/checks\./i.test(text) && seat != null) return { type: "check", seat };
    if (/calls \d+\./i.test(text) && seat != null) return { type: "call", seat };

    const betAmount = text.match(/bets (\d+)\./i)?.[1];
    if (betAmount && seat != null) {
      return {
        type: "bet",
        seat,
        amount: Number.parseInt(betAmount, 10),
      };
    }

    const raiseAmount = text.match(/raises to (\d+)\./i)?.[1];
    if (raiseAmount && seat != null) {
      return {
        type: "raise",
        seat,
        amount: Number.parseInt(raiseAmount, 10),
      };
    }

    if (/shown their cards\./i.test(text)) return { type: "show" };
    if (/hidden their cards\./i.test(text)) return { type: "muck" };
    return null;
  }

  private parseSeatIndex(text: string): number | null {
    const seatText = text.match(/Seat (\d+)/i)?.[1];
    if (!seatText) return null;
    const seat = Number.parseInt(seatText, 10);
    return Number.isNaN(seat) ? null : seat - 1;
  }

  private replaceSeatLabels(line: string): string {
    return line.replace(/\b[Ss]eat (\d+)\b/g, (match, seatText) => {
      const seatNumber = Number.parseInt(seatText, 10);
      if (Number.isNaN(seatNumber)) return match;
      const playerName = this.table?.players.find((player) => player.seat === seatNumber)?.name;
      return playerName ?? match;
    });
  }

  private handCompletionMessage(): string | null {
    const result = this.handResultSummary;
    const table = this.table;
    if (!result || !table) return null;

    const winnerNames = (table.hand_state.winner_seats ?? [])
      .map((seat) => table.players.find((player) => player.seat === seat)?.name ?? null)
      .filter((name): name is string => Boolean(name));

    const winnerShowLine = result.lines.find((line) =>
      winnerNames.some((name) => line.startsWith(`${name} shows `)),
    );
    if (winnerShowLine) {
      const parsed = winnerShowLine.match(/^(.+?) shows [^:]+:\s*(.+?)(?: and wins \d+)?\.?$/i);
      if (parsed) {
        return `${parsed[1]} wins with ${parsed[2]}.`;
      }
      return winnerShowLine;
    }

    if (result.heading.length > 0) {
      return /[.!?]$/.test(result.heading) ? result.heading : `${result.heading}.`;
    }

    return null;
  }

  private handEndMode(table: BackendTable | null): ClientState["handEndMode"] {
    if (table?.hand_state.status !== "complete") return null;
    if (table.hand_state.hand_result?.lines.some((line) => line.startsWith("Hand ends by fold."))) {
      return "fold";
    }
    return "showdown";
  }

  private manualStartRequired(table: BackendTable | null): boolean {
    if (!table) return false;
    return table.players.some(
      (player) => !player.is_bot && player.stack > 0 && player.will_play_next_hand,
    );
  }
}
