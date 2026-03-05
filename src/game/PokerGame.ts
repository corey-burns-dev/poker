import { PokerEngine } from '@pokertools/engine';
import { evaluateBoard, rankBoard, rankDescription } from '@pokertools/evaluator';
import type { Action, GameState, Player, Winner } from '@pokertools/types';
import seedrandom from 'seedrandom';

export type GameStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type BettingStructure = 'NO_LIMIT' | 'POT_LIMIT' | 'FIXED_LIMIT';

type HeroOutcome = 'win' | 'loss' | 'split' | 'folded' | 'info';

interface ShowdownEvaluation {
  seat: number;
  name: string;
  cards: readonly string[];
  rank: string | null;
  score: number | null;
}

export interface HandResultSummary {
  heading: string;
  lines: string[];
  heroOutcome: HeroOutcome;
}

export interface GameConfig {
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  bettingStructure: BettingStructure;
  minBet: number;
  allowStraddle: boolean;
  timeBankSeconds: number;
  turnTimeSeconds: number;
  aiThinkDelayMs: number;
  seed?: string;
}

export class PokerGame {
  engine: PokerEngine;
  config: GameConfig;

  // Callbacks for UI updates
  onStateChange: () => void = () => {};
  onMessage: (msg: string) => void = () => {};
  onTimerUpdate: (timeLeft: number) => void = () => {};
  onActionLogUpdate: (entries: readonly string[]) => void = () => {};
  onHandResultUpdate: (result: HandResultSummary | null) => void = () => {};

  private currentTimer: NodeJS.Timeout | null = null;
  private currentTimerInterval: NodeJS.Timeout | null = null;
  private timerEndTime = 0;
  private aiDelayTimer: NodeJS.Timeout | null = null;
  private thinkingSeatIndex: number | null = null;
  private actionLog: string[] = [];
  private handResult: HandResultSummary | null = null;

  constructor(config?: Partial<GameConfig>) {
    const clampedMaxPlayers = Math.max(2, Math.min(8, config?.maxPlayers ?? 8));

    this.config = {
      maxPlayers: 8,
      smallBlind: 10,
      bigBlind: 20,
      bettingStructure: 'NO_LIMIT',
      minBet: 20,
      allowStraddle: false,
      timeBankSeconds: 30,
      turnTimeSeconds: 15,
      aiThinkDelayMs: 1200,
      ...config
    };
    this.config.maxPlayers = clampedMaxPlayers;

    const rng = seedrandom(this.config.seed || Math.random().toString());

    this.engine = new PokerEngine({
      maxPlayers: this.config.maxPlayers,
      smallBlind: this.config.smallBlind,
      bigBlind: this.config.bigBlind,
      randomProvider: () => rng.quick()
    });

    // Setup Players
    const seatCount = this.config.maxPlayers;
    const names = [
      'You',
      'Alice',
      'Bob',
      'Charlie',
      'Diana',
      'Ethan',
      'Fiona',
      'Gabe'
    ];

    for (let seat = 0; seat < seatCount; seat += 1) {
      this.engine.sit(seat, `p${seat + 1}`, names[seat] || `Player ${seat + 1}`, 5000);
    }

    this.engine.on((rawAction, oldState, newState) => {
      const action = rawAction as Action;
      const actionLine = this.describeAction(action, oldState as GameState, newState as GameState);
      if (actionLine) {
        this.appendActionLog(actionLine);
      }
      if (action.type === 'DEAL') {
        this.describeForcedBets(newState as GameState).forEach((line) => this.appendActionLog(line));
      }

      if (oldState.street !== newState.street && newState.street !== 'PREFLOP') {
        const streetMessage = this.describeStreetTransition(oldState as GameState, newState as GameState);
        this.appendActionLog(streetMessage);
        this.onMessage(streetMessage);
      }

      if (newState.winners && !oldState.winners) {
        this.clearTimer();
        this.clearAIDelay();
        this.setThinkingSeat(null);

        const result = this.buildHandResult(newState as GameState);
        this.setHandResult(result);
        result.lines.forEach((line) => this.appendActionLog(line));
        this.appendActionLog('Hand complete. Review the hand log, then press Next Hand.');
        this.onMessage(`${result.heading} Press Next Hand when you are ready.`);
        this.onStateChange();
        return;
      }

      if (action.type === 'DEAL' && this.config.allowStraddle) {
        this.onMessage('Waiting for optional straddle...');
      }

      this.onStateChange();

      if (newState.actionTo === null) {
        this.clearTimer();
      } else if (newState.actionTo !== oldState.actionTo) {
        this.startTimer(newState.actionTo);
      }
    });
  }

  get state() {
    return this.engine.state;
  }

  get view() {
    return this.engine.view('p1');
  }

  get stage(): string {
    return this.engine.state.street ? this.engine.state.street.toLowerCase() : 'waiting';
  }

  get actionLogEntries(): readonly string[] {
    return this.actionLog;
  }

  get handResultSummary(): HandResultSummary | null {
    return this.handResult;
  }

  get thinkingSeat(): number | null {
    return this.thinkingSeatIndex;
  }

  // Timer Management
  private startTimer(seatIndex: number) {
    this.clearTimer();
    const timeMs = this.config.turnTimeSeconds * 1000;
    this.timerEndTime = Date.now() + timeMs;

    this.currentTimerInterval = setInterval(() => {
      const left = Math.max(0, this.timerEndTime - Date.now());
      this.onTimerUpdate(left);
    }, 100);

    this.currentTimer = setTimeout(() => {
      this.handleTimeout(seatIndex);
    }, timeMs);
  }

  private clearTimer() {
    if (this.currentTimer) clearTimeout(this.currentTimer);
    if (this.currentTimerInterval) clearInterval(this.currentTimerInterval);
    this.currentTimer = null;
    this.currentTimerInterval = null;
    this.onTimerUpdate(0);
  }

  private clearAIDelay() {
    if (this.aiDelayTimer) {
      clearTimeout(this.aiDelayTimer);
      this.aiDelayTimer = null;
    }
  }

  private appendActionLog(message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;

    this.actionLog.push(trimmed);
    if (this.actionLog.length > 400) {
      this.actionLog.splice(0, this.actionLog.length - 400);
    }
    this.onActionLogUpdate(this.actionLog);
  }

  private setHandResult(result: HandResultSummary | null) {
    this.handResult = result;
    this.onHandResultUpdate(result);
  }

  private setThinkingSeat(seat: number | null) {
    if (this.thinkingSeatIndex === seat) return;
    this.thinkingSeatIndex = seat;
    this.onStateChange();
  }

  private formatCards(cards: readonly string[] | null | undefined): string {
    if (!cards || cards.length === 0) return 'unknown cards';
    return cards.join(' ');
  }

  private getPlayerNameFromId(state: GameState, playerId?: string): string {
    if (!playerId) return 'Unknown player';
    const p = state.players.find((candidate) => candidate?.id === playerId);
    return p?.name || 'Unknown player';
  }

  private getPlayerByWinner(state: GameState, winner: Winner): Player | null {
    const p = state.players[winner.seat];
    return p || null;
  }

  private getCurrentBet(state: GameState): number {
    let maxBet = 0;
    state.currentBets.forEach((bet) => {
      if (bet > maxBet) maxBet = bet;
    });
    return maxBet;
  }

  private getPlayerBetThisStreet(state: GameState, seat: number): number {
    return state.currentBets.get(seat) ?? 0;
  }

  private getAmountToCall(state: GameState, seat: number): number {
    const currentBet = this.getCurrentBet(state);
    const playerBet = this.getPlayerBetThisStreet(state, seat);
    return Math.max(0, currentBet - playerBet);
  }

  private getMinimumRaiseTarget(state: GameState): number {
    const currentBet = this.getCurrentBet(state);
    if (currentBet === 0) return Math.max(1, state.bigBlind);
    return currentBet + Math.max(1, state.lastRaiseAmount);
  }

  private evaluateRank(player: Player | null | undefined, board: readonly string[]): string | null {
    if (!player?.hand || board.length + player.hand.length < 5) return null;

    try {
      const rankValue = rankBoard([...player.hand, ...board].join(' '));
      return rankDescription(rankValue);
    } catch {
      return null;
    }
  }

  private evaluateScore(player: Player | null | undefined, board: readonly string[]): number | null {
    if (!player?.hand || board.length + player.hand.length < 5) return null;

    try {
      return evaluateBoard([...player.hand, ...board].join(' '));
    } catch {
      return null;
    }
  }

  private describeForcedBets(state: GameState): string[] {
    const entries = Array.from(state.currentBets.entries())
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => a[0] - b[0]);

    return entries.map(([seat, amount]) => {
      const playerName = state.players[seat]?.name || `Seat ${seat + 1}`;
      const betKind = amount === state.smallBlind ? 'small blind' : amount === state.bigBlind ? 'big blind' : 'forced bet';
      return `${playerName} posted ${betKind} (${amount}).`;
    });
  }

  private getShowdownEvaluations(state: GameState): ShowdownEvaluation[] {
    const evaluations: ShowdownEvaluation[] = [];

    for (const player of state.players) {
      if (!player?.hand || player.status === 'FOLDED') continue;

      evaluations.push({
        seat: player.seat,
        name: player.name,
        cards: player.hand,
        rank: this.evaluateRank(player, state.board),
        score: this.evaluateScore(player, state.board)
      });
    }

    return evaluations.sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return a.score - b.score;
    });
  }

  private describeStreetTransition(oldState: GameState, newState: GameState): string {
    const dealtCards = newState.board.slice(oldState.board.length);
    const cardsText = dealtCards.length ? ` (${dealtCards.join(' ')})` : '';

    if (newState.street === 'FLOP') return `Flop${cardsText}.`;
    if (newState.street === 'TURN') return `Turn${cardsText}.`;
    if (newState.street === 'RIVER') return `River${cardsText}.`;
    if (newState.street === 'SHOWDOWN') return 'Showdown.';
    return `Dealing ${newState.street}.`;
  }

  private describeAction(action: Action, oldState: GameState, newState: GameState): string | null {
    const playerId = 'playerId' in action ? action.playerId : undefined;
    const actorName = this.getPlayerNameFromId(newState, playerId);

    if (action.type === 'DEAL') {
      return `Hand #${newState.handNumber} started.`;
    }
    if (action.type === 'FOLD') {
      return `${actorName} folded.`;
    }
    if (action.type === 'CHECK') {
      return `${actorName} checked.`;
    }
    if (action.type === 'CALL') {
      const oldPlayer = oldState.players.find((p) => p?.id === playerId);
      const newPlayer = newState.players.find((p) => p?.id === playerId);
      const amount = Math.max(
        0,
        (newPlayer?.totalInvestedThisHand || 0) - (oldPlayer?.totalInvestedThisHand || 0)
      );
      return amount > 0 ? `${actorName} called ${amount}.` : `${actorName} called.`;
    }
    if (action.type === 'BET') {
      return `${actorName} bet ${action.amount}.`;
    }
    if (action.type === 'RAISE') {
      return `${actorName} raised to ${action.amount}.`;
    }
    if (action.type === 'SHOW') {
      return `${actorName} showed cards.`;
    }
    if (action.type === 'MUCK') {
      return `${actorName} mucked cards.`;
    }
    if (action.type === 'TIMEOUT') {
      return `${actorName} timed out.`;
    }
    if (action.type === 'UNCALLED_BET_RETURNED') {
      return `${actorName} received ${action.amount} back (uncalled bet).`;
    }
    if (action.type === 'ADD_CHIPS') {
      return `${actorName} added ${action.amount} chips.`;
    }
    return null;
  }

  private buildHandResult(state: GameState): HandResultSummary {
    const winners = state.winners || [];
    const winnerNames = winners
      .map((winner) => state.players[winner.seat]?.name || `Seat ${winner.seat + 1}`)
      .join(', ');
    const winnerSeatSet = new Set(winners.map((winner) => winner.seat));
    const showdownEvaluations = this.getShowdownEvaluations(state);

    const heading =
      winners.length <= 1
        ? `${winnerNames || 'Winner'} wins the pot.`
        : `Split pot between ${winnerNames}.`;

    const lines: string[] = [];
    for (const winner of winners) {
      const winnerPlayer = this.getPlayerByWinner(state, winner);
      const winnerName = winnerPlayer?.name || `Seat ${winner.seat + 1}`;
      const winnerRank = winner.handRank || this.evaluateRank(winnerPlayer, state.board);
      const winnerCards = winner.hand || winnerPlayer?.hand || null;
      const rankText = winnerRank ? ` with ${winnerRank}` : '';
      const cardsText = winnerCards ? ` (${this.formatCards(winnerCards)})` : '';
      lines.push(`${winnerName} won ${winner.amount}${rankText}${cardsText}.`);
    }

    if (showdownEvaluations.length > 0) {
      lines.push('Showdown cards:');
      showdownEvaluations.forEach((entry) => {
        const rankText = entry.rank || 'Unranked hand';
        lines.push(`${entry.name}: ${rankText} (${this.formatCards(entry.cards)}).`);
      });

      const topWinner = showdownEvaluations.find((entry) => winnerSeatSet.has(entry.seat));
      if (topWinner) {
        showdownEvaluations
          .filter((entry) => !winnerSeatSet.has(entry.seat))
          .forEach((loser) => {
            const winnerRank = topWinner.rank || 'winning hand';
            const loserRank = loser.rank || 'losing hand';
            lines.push(
              `${topWinner.name}'s ${winnerRank} (${this.formatCards(topWinner.cards)}) beat ${loser.name}'s ${loserRank} (${this.formatCards(loser.cards)}).`
            );
          });
      }
    }

    const hero = state.players[0];
    const heroWon = winners.some((winner) => winner.seat === 0);

    if (heroWon && winners.length > 1) {
      lines.push('You split the pot.');
      return { heading, lines, heroOutcome: 'split' };
    }
    if (heroWon) {
      lines.push('You won this hand.');
      return { heading, lines, heroOutcome: 'win' };
    }
    if (hero?.status === 'FOLDED') {
      lines.push('You folded before showdown and lost this hand.');
      return { heading, lines, heroOutcome: 'folded' };
    }

    const heroRank = this.evaluateRank(hero, state.board);
    const heroCards = hero?.hand ? this.formatCards(hero.hand) : null;
    const topWinner = winners[0];
    const topWinnerPlayer = topWinner ? this.getPlayerByWinner(state, topWinner) : null;
    const topWinnerName = topWinnerPlayer?.name || (topWinner ? `Seat ${topWinner.seat + 1}` : 'winner');
    const topWinnerRank = topWinner?.handRank || this.evaluateRank(topWinnerPlayer, state.board);
    const topWinnerCards = topWinner?.hand || topWinnerPlayer?.hand || null;

    if (heroRank && topWinnerRank) {
      const heroCardsText = heroCards ? ` (${heroCards})` : '';
      const winnerCardsText = topWinnerCards ? ` (${this.formatCards(topWinnerCards)})` : '';
      lines.push(`You lost with ${heroRank}${heroCardsText} against ${topWinnerName}'s ${topWinnerRank}${winnerCardsText}.`);
    } else {
      lines.push('You lost this hand.');
    }

    return { heading, lines, heroOutcome: 'loss' };
  }

  private handleTimeout(seatIndex: number) {
    const p = this.engine.state.players[seatIndex];
    if (!p) return;

    this.onMessage(`${p.name} ran out of time!`);
    this.appendActionLog(`${p.name} timed out and is auto-acting.`);
    this.setThinkingSeat(null);
    this.clearAIDelay();

    try {
      // Attempt to check, otherwise fold (if facing bet)
      this.engine.act({ type: 'CHECK' as any, playerId: p.id });
    } catch {
      this.engine.act({ type: 'FOLD' as any, playerId: p.id });
    }
    this.triggerAILogic();
  }

  startRound() {
    this.clearTimer();
    this.clearAIDelay();
    this.setThinkingSeat(null);
    this.setHandResult(null);

    // ensure active players if they are sitting out (not usually an issue in standard game loop unless busted)
    for (let i = 0; i < this.config.maxPlayers; i += 1) {
      const p = this.engine.state.players[i];
      if (p && p.stack === 0) {
        // Give them a top up for the demo
        this.engine.act({ type: 'ADD_CHIPS' as any, playerId: p.id, amount: 5000 } as any);
      }
    }

    this.engine.deal();
    this.onMessage('New round started.');
    this.onStateChange();
    this.triggerAILogic();
  }

  // Wrapper for complex bet structures
  validateBetOrRaise(playerId: string, targetAmount: number, isRaise: boolean): boolean {
    const s = this.engine.state;
    const p = s.players.find((pl) => pl?.id === playerId);
    if (!p) return false;

    const currentBet = this.getCurrentBet(s);
    const playerBet = this.getPlayerBetThisStreet(s, p.seat);
    const toCall = this.getAmountToCall(s, p.seat);
    const maxTarget = playerBet + p.stack;

    if (targetAmount > maxTarget) {
      this.onMessage(`You can only bet up to your stack (${maxTarget}).`);
      return false;
    }

    if (isRaise && currentBet > 0 && this.config.bettingStructure !== 'FIXED_LIMIT') {
      const minimumRaiseTarget = this.getMinimumRaiseTarget(s);
      const isAllIn = targetAmount === maxTarget;

      if (!isAllIn && targetAmount <= currentBet) {
        this.onMessage(`Raise must be above the current bet (${currentBet}).`);
        return false;
      }

      if (!isAllIn && targetAmount < minimumRaiseTarget) {
        this.onMessage(`Minimum raise is to ${minimumRaiseTarget}.`);
        return false;
      }
    }

    if (this.config.bettingStructure === 'POT_LIMIT') {
      const sidePotsTotal = s.pots.reduce((acc, pot) => acc + pot.amount, 0);
      let activeBetsTotal = 0;
      s.currentBets.forEach((amount) => {
        activeBetsTotal += amount;
      });
      const currentPotSize = sidePotsTotal + activeBetsTotal;
      if (isRaise && currentBet > 0) {
        const potSizeAfterCall = currentPotSize + toCall;
        const maxRaiseTarget = currentBet + potSizeAfterCall;

        if (targetAmount > maxRaiseTarget) {
          this.onMessage(`Pot-limit exceeded. Max raise target is ${maxRaiseTarget}.`);
          return false;
        }
      }
    } else if (this.config.bettingStructure === 'FIXED_LIMIT') {
      const fixedBet = s.street === 'PREFLOP' || s.street === 'FLOP' ? this.config.smallBlind : this.config.bigBlind;
      const expectedTarget = currentBet > 0 ? currentBet + fixedBet : fixedBet;
      const isShortAllIn = maxTarget < expectedTarget && targetAmount === maxTarget;

      if (targetAmount !== expectedTarget && !isShortAllIn) {
        this.onMessage(`Fixed-limit sizes require bets/raises of exactly ${fixedBet}`);
        return false;
      }
    }

    return true;
  }

  handlePlayerAction(action: 'fold' | 'call' | 'raise' | 'bet' | 'check' | 'straddle', amount?: number) {
    if (this.engine.state.actionTo !== 0) return; // Not your turn

    const p1 = this.engine.state.players[0];
    if (!p1) return;

    this.clearAIDelay();
    this.setThinkingSeat(null);

    try {
      if (action === 'fold') {
        this.engine.act({ type: 'FOLD' as any, playerId: 'p1' });
        this.onMessage('You folded.');
      } else if (action === 'check') {
        this.engine.act({ type: 'CHECK' as any, playerId: 'p1' });
        this.onMessage('You checked.');
      } else if (action === 'call') {
        this.engine.act({ type: 'CALL' as any, playerId: 'p1' });
        this.onMessage('You called.');
      } else if (action === 'raise') {
        const currentBet = this.getCurrentBet(this.engine.state);
        if (currentBet === 0) {
          this.handlePlayerAction('bet', amount);
          return;
        }

        const playerBet = this.getPlayerBetThisStreet(this.engine.state, p1.seat);
        const minimumRaiseTarget = this.getMinimumRaiseTarget(this.engine.state);
        const maxTarget = playerBet + p1.stack;
        const requestedTarget = amount !== undefined ? amount : minimumRaiseTarget;
        const raiseTarget = Math.max(currentBet + 1, Math.min(requestedTarget, maxTarget));

        if (this.validateBetOrRaise('p1', raiseTarget, true)) {
          this.engine.act({ type: 'RAISE' as any, playerId: 'p1', amount: raiseTarget });
          this.onMessage(`You raised to ${raiseTarget}.`);
        } else {
          return; // Invalid bet logic, don't advance
        }
      } else if (action === 'bet') {
        const currentBet = this.getCurrentBet(this.engine.state);
        if (currentBet > 0) {
          this.handlePlayerAction('raise', amount);
          return;
        }

        const playerBet = this.getPlayerBetThisStreet(this.engine.state, p1.seat);
        const maxTarget = playerBet + p1.stack;
        const minimumOpenBet = Math.min(maxTarget, Math.max(1, this.engine.state.bigBlind));
        const requestedTarget = amount !== undefined ? amount : minimumOpenBet;
        const betAmount = Math.max(minimumOpenBet, Math.min(requestedTarget, maxTarget));
        this.engine.act({ type: 'BET' as any, playerId: 'p1', amount: betAmount });
        this.onMessage(`You bet ${betAmount}.`);
      } else if (action === 'straddle') {
        if (!this.config.allowStraddle || this.engine.state.street !== 'PREFLOP') {
          this.onMessage('Straddles not allowed right now.');
          return;
        }
        const straddleAmt = this.config.bigBlind * 2;
        this.engine.act({ type: 'RAISE' as any, playerId: 'p1', amount: straddleAmt });
        this.onMessage(`You straddled for ${straddleAmt}.`);
      }

      this.triggerAILogic();
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : '';
      console.warn('Invalid action:', errorMessage);

      // Fallback if checked but facing bet
      if (action === 'check' && errorMessage.includes('ILLEGAL_ACTION')) {
        this.handlePlayerAction('call');
      } else if (action === 'call' && errorMessage.includes('ILLEGAL_ACTION')) {
        this.handlePlayerAction('check');
      }
    }
  }

  triggerAILogic() {
    const s = this.engine.state;
    if (s.street === 'SHOWDOWN' || s.winners !== null) {
      this.clearAIDelay();
      this.setThinkingSeat(null);
      return;
    }

    const actionTo = s.actionTo;
    if (actionTo === null || actionTo === 0) {
      this.clearAIDelay();
      this.setThinkingSeat(null);
      return;
    }

    if (this.aiDelayTimer) return;

    const thinkingPlayer = s.players[actionTo];
    if (!thinkingPlayer) {
      this.setThinkingSeat(null);
      return;
    }

    if (thinkingPlayer.status !== 'ACTIVE' || thinkingPlayer.stack <= 0) {
      try {
        this.engine.act({ type: 'TIMEOUT' as any, playerId: thinkingPlayer.id });
      } catch {
        this.onMessage(`Skipping ${thinkingPlayer.name}; they cannot act.`);
      }
      this.setThinkingSeat(null);
      this.triggerAILogic();
      return;
    }

    this.setThinkingSeat(actionTo);
    this.appendActionLog(`${thinkingPlayer.name} is thinking...`);
    this.onMessage(`${thinkingPlayer.name} is thinking...`);

    this.aiDelayTimer = setTimeout(() => {
      this.aiDelayTimer = null;

      const currentS = this.engine.state;
      if (currentS.actionTo !== actionTo) {
        this.setThinkingSeat(null);
        this.triggerAILogic();
        return;
      }

      const aiPlayer = currentS.players[actionTo];
      if (!aiPlayer) {
        this.setThinkingSeat(null);
        return;
      }

      if (aiPlayer.status !== 'ACTIVE' || aiPlayer.stack <= 0) {
        try {
          this.engine.act({ type: 'TIMEOUT' as any, playerId: aiPlayer.id });
        } catch {
          this.onMessage(`Skipping ${aiPlayer.name}; they cannot act.`);
        } finally {
          this.setThinkingSeat(null);
          this.triggerAILogic();
        }
        return;
      }

      const currentBet = this.getCurrentBet(currentS);
      const playerBet = this.getPlayerBetThisStreet(currentS, aiPlayer.seat);
      const toCall = Math.max(0, currentBet - playerBet);

      // Smartness via evaluation (very basic heuristic)
      const holeCards = aiPlayer.hand || [];
      const board = currentS.board || [];

      let handVal = 0;
      try {
        const boardStr = [...holeCards, ...board].join(' ');
        handVal = rankBoard(boardStr);
      } catch {
        handVal = Math.random() * 8; // Fallback to a random rank (0-8)
      }

      const rand = Math.random();

      try {
        if (toCall === 0) {
          // Check or Bet
          if (rand > 0.7 && handVal >= 2) {
            const betAmt =
              this.config.bettingStructure === 'FIXED_LIMIT'
                ? (s.street === 'PREFLOP' || s.street === 'FLOP' ? this.config.smallBlind : this.config.bigBlind)
                : currentS.bigBlind;

            this.engine.act({ type: 'BET' as any, playerId: aiPlayer.id, amount: betAmt });
            this.onMessage(`${aiPlayer.name} bets ${betAmt}.`);
          } else {
            this.engine.act({ type: 'CHECK' as any, playerId: aiPlayer.id });
            this.onMessage(`${aiPlayer.name} checks.`);
          }
        } else if (rand > 0.8 && handVal >= 3) {
          // Facing a bet: Fold, Call, Raise
          const raiseTo =
            this.config.bettingStructure === 'FIXED_LIMIT'
              ? currentBet + (currentS.street === 'PREFLOP' || currentS.street === 'FLOP' ? this.config.smallBlind : this.config.bigBlind)
              : Math.min(playerBet + aiPlayer.stack, this.getMinimumRaiseTarget(currentS));

          if (this.validateBetOrRaise(aiPlayer.id, raiseTo, true)) {
            this.engine.act({ type: 'RAISE' as any, playerId: aiPlayer.id, amount: raiseTo });
            this.onMessage(`${aiPlayer.name} raises!`);
          } else {
            // Fallback call
            this.engine.act({ type: 'CALL' as any, playerId: aiPlayer.id });
            this.onMessage(`${aiPlayer.name} calls.`);
          }
        } else if (handVal >= 1 || rand > 0.5) {
          this.engine.act({ type: 'CALL' as any, playerId: aiPlayer.id });
          this.onMessage(`${aiPlayer.name} calls.`);
        } else {
          this.engine.act({ type: 'FOLD' as any, playerId: aiPlayer.id });
          this.onMessage(`${aiPlayer.name} folds.`);
        }
      } catch {
        // Fallback fold
        this.engine.act({ type: 'FOLD' as any, playerId: aiPlayer.id });
      } finally {
        this.setThinkingSeat(null);
        this.triggerAILogic(); // Trigger next
      }
    }, this.config.aiThinkDelayMs);
  }
}
