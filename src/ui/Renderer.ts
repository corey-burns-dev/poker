import type { PublicPlayer } from '@pokertools/types';
import { PokerGame } from '../game/PokerGame';

export class Renderer {
  private game: PokerGame;

  constructor(game: PokerGame) {
    this.game = game;
  }

  renderCard(cardStr?: string | null): string {
    if (!cardStr) {
      return `<div class="playing-card" style="background: linear-gradient(135deg, #1a2a6c, #b21f1f, #fdbb2d); border: 2px solid #fff;">
                <div class="center-suit" style="color:#fff; text-shadow:none;">?</div>
              </div>`;
    }
    
    const rank = cardStr.charAt(0);
    const suitChar = cardStr.charAt(1);
    
    let suitSymbol = '♠';
    let color = 'black';
    
    switch (suitChar.toLowerCase()) {
        case 'h': suitSymbol = '♥'; color = 'red'; break;
        case 'd': suitSymbol = '♦'; color = 'red'; break;
        case 'c': suitSymbol = '♣'; color = 'black'; break;
        case 's': suitSymbol = '♠'; color = 'black'; break;
    }
    
    const displayRank = rank === 'T' ? '10' : rank;

    return `
      <div class="playing-card ${color}">
        <div class="value">${displayRank}</div>
        <div class="center-suit">${suitSymbol}</div>
        <div class="suit" style="text-align: right">${suitSymbol}</div>
      </div>
    `;
  }

  updatePlayerArea(areaSelector: string, chipsId: string, cardsId: string, player: PublicPlayer | null, isShowdown: boolean, isYou: boolean) {
     const area = document.querySelector(areaSelector) as HTMLElement;
     if (!area) return;
     
     if (!player) {
        area.style.opacity = '0.3';
        return;
     }

     area.style.opacity = player.status === 'FOLDED' || player.status === 'BUSTED' ? '0.5' : '1';

     const infoEl = document.getElementById(chipsId)!;
     infoEl.innerHTML = `🪙 ${player.stack} <br> <span style="font-size: 0.8rem; color: #ccc">Bet: 🪙${player.betThisStreet}</span>`;
     
     const nameEl = area.querySelector('.player-name')!;
     
     // Highlight the active player
     const isActive = this.game.state.actionTo === player.seat;
     nameEl.innerHTML = player.name + (isActive ? ' <span style="color:var(--accent-hover)">●</span>' : '');
     if (isActive) {
        area.style.transform = 'scale(1.1)';
        area.style.zIndex = '5';
     } else {
        area.style.transform = 'scale(1)';
        area.style.zIndex = '1';
     }
     
     // Determine Dealer Button (Optional polish)
     if (this.game.state.buttonSeat === player.seat) {
        nameEl.innerHTML += ' 🅓';
     }

     const cardsContainer = document.getElementById(cardsId)!;
     
     let cardsToRender: (string | null)[] = [null, null];
     
     if (isYou && player.hand) {
         cardsToRender = player.hand as any;
     } else if (player.hand) {
         cardsToRender = player.hand as any;
     }
     
     if (!player.hand && player.status !== 'WAITING' && player.status !== 'FOLDED' && player.status !== 'BUSTED') {
         cardsToRender = [null, null];
     } else if (!player.hand) {
         cardsToRender = []; 
     }

     cardsContainer.innerHTML = cardsToRender.map(c => this.renderCard(c)).join('');
     
     if (cardsToRender.length === 0) {
        cardsContainer.innerHTML = `<div class="card-slot"></div><div class="card-slot"></div>`;
     }
  }

  update() {
    const s = this.game.view; 
    
    const p1 = s.players[0]; // You
    const p2 = s.players[1]; // Alice
    const p3 = s.players[2]; // Bob
    const p4 = s.players[3]; // Charlie
    
    const isShowdown = s.street === 'SHOWDOWN';

    this.updatePlayerArea('.player-area.bottom', 'p1-chips', 'p1-cards', p1, isShowdown, true);
    this.updatePlayerArea('.player-area.left', 'p2-chips', 'p2-cards', p2, isShowdown, false);
    this.updatePlayerArea('.player-area.top', 'p3-chips', 'p3-cards', p3, isShowdown, false);
    this.updatePlayerArea('.player-area.right', 'p4-chips', 'p4-cards', p4, isShowdown, false);

    // Global Stats
    const totalPot = s.pots.reduce((sum, p) => sum + p.amount, 0) + Array.from(s.currentBets.values()).reduce((a,b)=>a+b,0);
    document.getElementById('total-pot')!.textContent = `🪙 ${totalPot}`;

    const commContainer = document.getElementById('community-cards')!;
    commContainer.innerHTML = s.board.map(c => this.renderCard(c)).join('');
    
    const emptySlots = 5 - s.board.length;
    for(let i=0; i<emptySlots; i++) {
        commContainer.innerHTML += `<div class="card-slot"></div>`;
    }

    // Input Controls Update
    const btnContainer = document.querySelector('.controls-container') as HTMLElement;
    const slider = document.getElementById('bet-slider') as HTMLInputElement;

    if (s.actionTo === 0 && !isShowdown && p1 && p1.status === 'ACTIVE') {
      const callAmt = Math.max(0, s.lastRaiseAmount - p1.betThisStreet);
      
      document.getElementById('btn-call')!.textContent = callAmt > 0 ? `Call 🪙${callAmt}` : 'Check';
      
      const maxRaise = p1.stack;
      const minAddition = s.minRaise;
      const minTotalRaise = callAmt + minAddition;
      
      slider.min = Math.min(minTotalRaise, maxRaise).toString();
      slider.max = maxRaise.toString();
      
      // Keep slider value valid
      if (parseInt(slider.value) < parseInt(slider.min)) slider.value = slider.min;
      if (parseInt(slider.value) > parseInt(slider.max)) slider.value = slider.max;
      document.getElementById('bet-amount-display')!.textContent = `🪙 ${slider.value}`;

      btnContainer.style.opacity = '1';
      btnContainer.style.pointerEvents = 'auto';
    } else {
      btnContainer.style.opacity = '0.5';
      btnContainer.style.pointerEvents = 'none';
      document.getElementById('btn-call')!.textContent = `Check / Call`;
    }
  }

  showMessage(msg: string) {
    const msgEl = document.getElementById('game-message')!;
    msgEl.textContent = msg;
    msgEl.style.opacity = '1';
    
    setTimeout(() => {
       if(msgEl.textContent === msg) {
          msgEl.style.opacity = '0.5';
       }
    }, 4000);
  }
}
