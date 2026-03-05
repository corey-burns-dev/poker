import { PokerEngine } from '@pokertools/engine';
import { rankBoard } from '@pokertools/evaluator';
import seedrandom from 'seedrandom';

export type GameStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type BettingStructure = 'NO_LIMIT' | 'POT_LIMIT' | 'FIXED_LIMIT';

export interface GameConfig {
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  bettingStructure: BettingStructure;
  minBet: number;
  allowStraddle: boolean;
  timeBankSeconds: number;
  turnTimeSeconds: number;
  seed?: string;
}

export class PokerGame {
  engine: PokerEngine;
  config: GameConfig;

  // Callbacks for UI updates
  onStateChange: () => void = () => {};
  onMessage: (msg: string) => void = () => {};
  onTimerUpdate: (timeLeft: number) => void = () => {};
  
  private delayActions = false;
  private currentTimer: NodeJS.Timeout | null = null;
  private currentTimerInterval: NodeJS.Timeout | null = null;
  private timerEndTime: number = 0;

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

    this.engine.on((action, oldState, newState) => {
      // Announce stage changes
      if (oldState.street !== newState.street && newState.street !== 'PREFLOP') {
         this.onMessage(`Dealing ${newState.street}...`);
      }
      
      // Handle Winners
      if (newState.winners && !oldState.winners) {
        this.clearTimer();
        if (newState.winners.length === 1) {
          const winner = newState.players[newState.winners[0].seat];
          this.onMessage(`${winner?.name} wins ${newState.winners[0].amount}!`);
        } else {
          this.onMessage(`Split pot!`);
        }
        
        // Auto-restart delay
        setTimeout(() => this.startRound(), 4000);
        return; // Don't start timer on round end
      }

      // Handle Straddle
      if (newState.street === 'PREFLOP' && oldState.street === null && this.config.allowStraddle) {
          // If a new hand just dealt and straddle allowed, we could prompt UTG here
          // For simplicity in this engine, we'll let players straddle by manually betting 2xBB
          this.onMessage("Waiting for optional straddle...");
      }
      
      this.onStateChange();
      
      // Restart timer if it's someone's turn
      if (newState.actionTo !== null && newState.actionTo !== oldState.actionTo) {
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

  private handleTimeout(seatIndex: number) {
      const p = this.engine.state.players[seatIndex];
      if (!p) return;

      this.onMessage(`${p.name} ran out of time!`);
      try {
          // Attempt to check, otherwise fold (if facing bet)
          this.engine.act({ type: 'CHECK' as any, playerId: p.id });
      } catch (e) {
          this.engine.act({ type: 'FOLD' as any, playerId: p.id });
      }
      this.triggerAILogic();
  }

  startRound() {
    this.delayActions = false;
    this.clearTimer();
    // ensure active players if they are sitting out (not usually an issue in standard game loop unless busted)
    for (let i = 0; i < this.config.maxPlayers; i++) {
        const p = this.engine.state.players[i];
        if (p && p.stack === 0) {
            // Give them a top up for the demo
            this.engine.act({ type: 'ADD_CHIPS' as any, playerId: p.id, amount: 5000 } as any);
        }
    }
    this.engine.deal();
    this.onMessage("New round started.");
    this.onStateChange();
    this.startTimer(this.engine.state.actionTo!);
    this.triggerAILogic();
  }

  // Wrapper for complex bet structures
  validateBetOrRaise(playerId: string, targetAmount: number, isRaise: boolean): boolean {
       const s = this.engine.state;
       const p = s.players.find(pl => pl?.id === playerId);
       if (!p) return false;

       const toCall = s.lastRaiseAmount > 0 ? s.lastRaiseAmount - p.betThisStreet : 0;
       
       if (this.config.bettingStructure === 'POT_LIMIT') {
           const sidePotsTotal = s.pots.reduce((acc, p) => acc + p.amount, 0);
           let activeBetsTotal = 0;
           s.currentBets.forEach(amount => activeBetsTotal += amount);
           const currentPotSize = sidePotsTotal + activeBetsTotal;
           const potSizeAfterCall = currentPotSize + toCall;
           let maxRaise = s.lastRaiseAmount > 0 ? s.lastRaiseAmount + potSizeAfterCall : potSizeAfterCall;
           
           if (targetAmount > maxRaise + p.betThisStreet + toCall) {
               this.onMessage(`Pot-limit exceeded. Max raise is ${maxRaise}`);
               return false;
           }
       } else if (this.config.bettingStructure === 'FIXED_LIMIT') {
           const fixedBet = (s.street === 'PREFLOP' || s.street === 'FLOP') 
                ? this.config.smallBlind 
                : this.config.bigBlind;
           
           // A raise must be exactly the fixed amount jump
           const expectedTarget = s.lastRaiseAmount > 0 
               ? s.lastRaiseAmount + fixedBet + p.betThisStreet
               : fixedBet + p.betThisStreet;

           if (targetAmount !== expectedTarget) {
               this.onMessage(`Fixed-limit sizes require bets/raises of exactly ${fixedBet}`);
               return false;
           }
       }
       return true;
  }

  handlePlayerAction(action: 'fold' | 'call' | 'raise' | 'bet' | 'check' | 'straddle', amount?: number) {
    if (this.engine.state.actionTo !== 0) return; // Not your turn

    const p1 = this.engine.state.players[0]!;
    
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
        const minR = this.engine.state.minRaise;
        const defaultRaise = amount !== undefined ? amount : (p1.betThisStreet + minR);
        
        if (this.validateBetOrRaise('p1', defaultRaise, true)) {
           this.engine.act({ type: 'RAISE' as any, playerId: 'p1', amount: defaultRaise });
           this.onMessage(`You raised to ${defaultRaise}.`);
        } else {
           return; // Invalid bet logic, don't advance 
        }
      } else if (action === 'bet') {
        const minBet = this.engine.state.minRaise;
        const defaultBet = amount !== undefined ? amount : minBet;
        const betAmount = Math.max(minBet, Math.min(defaultBet, p1.stack + p1.betThisStreet));
        this.engine.act({ type: 'BET' as any, playerId: 'p1', amount: betAmount });
        this.onMessage(`You bet ${betAmount}.`);
      } else if (action === 'straddle') {
          if (!this.config.allowStraddle || this.engine.state.street !== 'PREFLOP') {
              this.onMessage("Straddles not allowed right now.");
              return;
          }
          const straddleAmt = this.config.bigBlind * 2;
          this.engine.act({ type: 'RAISE' as any, playerId: 'p1', amount: straddleAmt });
          this.onMessage(`You straddled for ${straddleAmt}.`);
      }
      
      this.triggerAILogic();
    } catch (e: any) {
        console.warn("Invalid action: ", e.message);
        // Fallback if checked but facing bet
        if (action === 'check' && e.message.includes('ILLEGAL_ACTION')) {
             this.handlePlayerAction('call');
        } else if (action === 'call' && e.message.includes('ILLEGAL_ACTION')) {
             this.handlePlayerAction('check');
        }
    }
  }

  triggerAILogic() {
    const s = this.engine.state;
    if (s.street === 'SHOWDOWN' || s.winners !== null) return;
    
    const actionTo = s.actionTo;
    if (actionTo === null || actionTo === 0) return; // Not AI's turn or hand over
    
    if (this.delayActions) return;
    this.delayActions = true;

    setTimeout(() => {
        const currentS = this.engine.state;
        if (currentS.actionTo !== actionTo) {
           this.delayActions = false;
           return;
        }

        const aiPlayer = currentS.players[actionTo]!;
        const toCall = currentS.lastRaiseAmount > 0 
           ? currentS.lastRaiseAmount - aiPlayer.betThisStreet
           : 0;

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
                if (rand > 0.7 && handVal >= 2) { // Minimum 2 pair to bet out of nowhere
                    const betAmt = this.config.bettingStructure === 'FIXED_LIMIT'
                       ? ((s.street === 'PREFLOP' || s.street === 'FLOP') ? this.config.smallBlind : this.config.bigBlind)
                       : currentS.bigBlind;

                    this.engine.act({ type: 'BET' as any, playerId: aiPlayer.id, amount: betAmt });
                    this.onMessage(`${aiPlayer.name} bets ${betAmt}.`);
                } else {
                    this.engine.act({ type: 'CHECK' as any, playerId: aiPlayer.id });
                    this.onMessage(`${aiPlayer.name} checks.`);
                }
            } else {
                // Facing a bet: Fold, Call, Raise
                if (rand > 0.8 && handVal >= 3) { // Three of a kind or better
                    const raiseTo = this.config.bettingStructure === 'FIXED_LIMIT'
                       ? ((s.street === 'PREFLOP' || s.street === 'FLOP') ? this.config.smallBlind : this.config.bigBlind) + currentS.lastRaiseAmount
                       : aiPlayer.betThisStreet + toCall + currentS.minRaise;
                    
                    if (this.validateBetOrRaise(aiPlayer.id, raiseTo, true)) {
                        this.engine.act({ type: 'RAISE' as any, playerId: aiPlayer.id, amount: raiseTo });
                        this.onMessage(`${aiPlayer.name} raises!`);
                    } else {
                        // Fallback call
                        this.engine.act({ type: 'CALL' as any, playerId: aiPlayer.id });
                        this.onMessage(`${aiPlayer.name} calls.`);
                    }
                } else if (handVal >= 1 || rand > 0.5) { // Any pair or bluff
                    this.engine.act({ type: 'CALL' as any, playerId: aiPlayer.id });
                    this.onMessage(`${aiPlayer.name} calls.`);
                } else { // Weak hand
                    this.engine.act({ type: 'FOLD' as any, playerId: aiPlayer.id });
                    this.onMessage(`${aiPlayer.name} folds.`);
                }
            }
        } catch (e: any) {
            // Fallback fold
            this.engine.act({ type: 'FOLD' as any, playerId: aiPlayer.id });
        }

        this.delayActions = false;
        this.triggerAILogic(); // Trigger next

    }, 1200);
  }
}
