import { PokerEngine } from '@pokertools/engine';
import { rankBoard } from '@pokertools/evaluator';

export type GameStage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export class PokerGame {
  engine: PokerEngine;

  // Callbacks for UI updates
  onStateChange: () => void = () => {};
  onMessage: (msg: string) => void = () => {};
  
  private delayActions = false;

  constructor() {
    this.engine = new PokerEngine({ smallBlind: 10, bigBlind: 20 });
    
    // Setup Players
    this.engine.sit(0, 'p1', 'You', 5000);
    this.engine.sit(1, 'p2', 'Alice', 5000);
    this.engine.sit(2, 'p3', 'Bob', 5000);
    this.engine.sit(3, 'p4', 'Charlie', 5000);

    this.engine.on((action, oldState, newState) => {
      // Announce stage changes
      if (oldState.street !== newState.street && newState.street !== 'PREFLOP') {
        this.onMessage(`Dealing ${newState.street}...`);
      }
      
      // Handle Winners
      if (newState.winners && !oldState.winners) {
        if (newState.winners.length === 1) {
          const winner = newState.players[newState.winners[0].seat];
          this.onMessage(`${winner?.name} wins ${newState.winners[0].amount}!`);
        } else {
          this.onMessage(`Split pot!`);
        }
        
        // Auto-restart delay
        setTimeout(() => this.startRound(), 4000);
      }
      
      this.onStateChange();
    });
  }

  get state() {
    return this.engine.state;
  }

  get view() {
    return this.engine.view('p1');
  }

  get stage(): string {
    return this.engine.state.street.toLowerCase();
  }

  startRound() {
    this.delayActions = false;
    // ensure active players if they are sitting out (not usually an issue in standard game loop unless busted)
    for (let i = 0; i < 4; i++) {
        const p = this.engine.state.players[i];
        if (p && p.stack === 0) {
            // Give them a top up for the demo
            this.engine.act({ type: 'ADD_CHIPS' as any, playerId: p.id, amount: 5000 } as any);
        }
    }
    this.engine.deal();
    this.onMessage("New round started.");
    this.onStateChange();
    this.triggerAILogic();
  }

  handlePlayerAction(action: 'fold' | 'call' | 'raise' | 'check', amount?: number) {
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
        const raiseAmount = amount !== undefined ? amount : (p1.betThisStreet + minR);
        this.engine.act({ type: 'RAISE' as any, playerId: 'p1', amount: raiseAmount });
        this.onMessage(`You raised to ${raiseAmount}.`);
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
                    this.engine.act({ type: 'BET' as any, playerId: aiPlayer.id, amount: currentS.bigBlind });
                    this.onMessage(`${aiPlayer.name} bets ${currentS.bigBlind}.`);
                } else {
                    this.engine.act({ type: 'CHECK' as any, playerId: aiPlayer.id });
                    this.onMessage(`${aiPlayer.name} checks.`);
                }
            } else {
                // Facing a bet: Fold, Call, Raise
                if (rand > 0.8 && handVal >= 3) { // Three of a kind or better
                    this.engine.act({ type: 'RAISE' as any, playerId: aiPlayer.id, amount: aiPlayer.betThisStreet + toCall + currentS.minRaise });
                    this.onMessage(`${aiPlayer.name} raises!`);
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
