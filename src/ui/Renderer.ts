import type { PublicPlayer } from '@pokertools/types';
import { PokerGame } from '../game/PokerGame';

export class Renderer {
  private game: PokerGame;

  constructor(game: PokerGame) {
    this.game = game;
  }

  private renderCard(cardStr?: string | null, variant: 'board' | 'hole' = 'hole'): string {
    const sizeClass = variant === 'board' ? 'board-card' : 'hole-card';

    if (!cardStr) {
      return `<div class="playing-card ${sizeClass} is-hidden">
                <div class="center-suit">?</div>
              </div>`;
    }

    const rank = cardStr.charAt(0);
    const suitChar = cardStr.charAt(1);

    let suitSymbol = '♠';
    let color = 'black';

    switch (suitChar.toLowerCase()) {
      case 'h':
        suitSymbol = '♥';
        color = 'red';
        break;
      case 'd':
        suitSymbol = '♦';
        color = 'red';
        break;
      case 'c':
        suitSymbol = '♣';
        color = 'black';
        break;
      case 's':
        suitSymbol = '♠';
        color = 'black';
        break;
      default:
        break;
    }

    const displayRank = rank === 'T' ? '10' : rank;

    return `
      <div class="playing-card ${sizeClass} ${color}">
        <div class="value">${displayRank}</div>
        <div class="center-suit">${suitSymbol}</div>
        <div class="suit" style="text-align: right">${suitSymbol}</div>
      </div>
    `;
  }

  private avatarText(name: string, isYou: boolean): string {
    if (isYou) return 'You';
    const cleaned = name.trim();
    if (!cleaned) return '?';
    return cleaned.charAt(0).toUpperCase();
  }

  private updatePlayerArea(seatIndex: number, player: PublicPlayer | null, isShowdown: boolean) {
    const playerId = `p${seatIndex + 1}`;
    const area = document.getElementById(`seat-${seatIndex}`) as HTMLElement | null;
    const nameEl = document.getElementById(`${playerId}-name`);
    const chipsEl = document.getElementById(`${playerId}-chips`);
    const cardsEl = document.getElementById(`${playerId}-cards`);
    const avatarEl = document.getElementById(`${playerId}-avatar`);
    const statusEl = document.getElementById(`${playerId}-status`);
    const betEl = document.getElementById(`${playerId}-bet`) as HTMLElement | null;

    if (!area || !nameEl || !chipsEl || !cardsEl || !avatarEl || !statusEl || !betEl) return;

    if (!player) {
      area.classList.add('is-empty');
      area.classList.remove('is-active', 'is-folded', 'is-busted');
      avatarEl.textContent = (seatIndex + 1).toString();
      nameEl.textContent = `Seat ${seatIndex + 1}`;
      chipsEl.textContent = 'Open seat';
      cardsEl.innerHTML = '<div class="card-slot hole-slot"></div><div class="card-slot hole-slot"></div>';
      statusEl.textContent = '';
      betEl.classList.remove('visible');
      betEl.textContent = '';
      return;
    }

    area.classList.remove('is-empty');

    const isYou = seatIndex === 0;
    const isActive = this.game.state.actionTo === player.seat;
    const isFolded = player.status === 'FOLDED';
    const isBusted = player.status === 'BUSTED';
    const isOut = isFolded || isBusted;

    area.classList.toggle('is-active', isActive);
    area.classList.toggle('is-folded', isFolded);
    area.classList.toggle('is-busted', isBusted);

    avatarEl.textContent = this.avatarText(player.name, isYou);

    const markers: string[] = [];
    if (this.game.state.buttonSeat === player.seat) markers.push('D');
    if (isActive) markers.push('Acting');
    if (player.status === 'ALL_IN') markers.push('All-in');
    nameEl.textContent = markers.length ? `${player.name} (${markers.join(' | ')})` : player.name;

    chipsEl.innerHTML = `🪙 ${player.stack}<br><span class="bet-line">Bet: 🪙${player.betThisStreet}</span>`;

    if (isOut) {
      statusEl.textContent = isFolded ? 'Folded' : 'Out';
    } else if (player.status === 'ALL_IN') {
      statusEl.textContent = 'All-in';
    } else {
      statusEl.textContent = '';
    }

    let cardsToRender: Array<string | null> = [null, null];

    if (player.hand && player.hand.length > 0) {
      if (isYou || isShowdown) {
        cardsToRender = player.hand as Array<string | null>;
      } else {
        cardsToRender = player.hand.map(() => null);
      }
    }

    if (isOut) {
      cardsToRender = [];
    }

    if (cardsToRender.length === 0) {
      cardsEl.innerHTML = '<div class="card-slot hole-slot"></div><div class="card-slot hole-slot"></div>';
    } else {
      cardsEl.innerHTML = cardsToRender.map((card) => this.renderCard(card, 'hole')).join('');
    }

    const betAmount = player.betThisStreet || 0;
    if (betAmount > 0 && !isOut) {
      betEl.classList.add('visible');
      betEl.textContent = `🪙 ${betAmount}`;
    } else {
      betEl.classList.remove('visible');
      betEl.textContent = '';
    }
  }

  update() {
    const s = this.game.view;
    const players = s.players;
    const p1 = players[0];
    const isShowdown = s.street === 'SHOWDOWN';

    for (let seat = 0; seat < this.game.config.maxPlayers; seat += 1) {
      this.updatePlayerArea(seat, players[seat] || null, isShowdown);
    }

    const totalPot =
      s.pots.reduce((sum, pot) => sum + pot.amount, 0) +
      Array.from(s.currentBets.values()).reduce((sum, bet) => sum + bet, 0);

    const potEl = document.getElementById('total-pot');
    if (potEl) potEl.textContent = `🪙 ${totalPot}`;

    const blindsEl = document.getElementById('blind-level');
    if (blindsEl) blindsEl.textContent = `${s.smallBlind} / ${s.bigBlind}`;

    const commContainer = document.getElementById('community-cards');
    if (commContainer) {
      commContainer.innerHTML = s.board.map((card) => this.renderCard(card, 'board')).join('');
      const emptySlots = 5 - s.board.length;
      for (let i = 0; i < emptySlots; i += 1) {
        commContainer.innerHTML += '<div class="card-slot board-slot"></div>';
      }
    }

    const controlsEl = document.querySelector('.controls-container') as HTMLElement | null;
    const actionStateEl = document.getElementById('action-state');
    const slider = document.getElementById('bet-slider') as HTMLInputElement | null;
    const sliderDisplay = document.getElementById('bet-amount-display');
    const callBtn = document.getElementById('btn-call') as HTMLButtonElement | null;
    const raiseBtn = document.getElementById('btn-raise') as HTMLButtonElement | null;
    const foldBtn = document.getElementById('btn-fold') as HTMLButtonElement | null;

    if (!controlsEl || !slider || !sliderDisplay || !callBtn || !raiseBtn || !foldBtn || !actionStateEl) {
      return;
    }

    const heroActive = s.actionTo === 0 && !isShowdown && p1 && p1.status === 'ACTIVE';

    if (heroActive) {
      const callAmt = Math.max(0, s.lastRaiseAmount - p1.betThisStreet);
      const maxTarget = p1.betThisStreet + p1.stack;
      const minTarget = callAmt > 0
        ? Math.min(maxTarget, p1.betThisStreet + callAmt + s.minRaise)
        : Math.min(maxTarget, Math.max(1, s.minRaise));

      slider.min = minTarget.toString();
      slider.max = maxTarget.toString();

      const value = Number.parseInt(slider.value, 10);
      if (Number.isNaN(value) || value < minTarget) slider.value = slider.min;
      if (Number.parseInt(slider.value, 10) > maxTarget) slider.value = slider.max;

      sliderDisplay.textContent = `🪙 ${slider.value}`;

      callBtn.textContent = callAmt > 0 ? `Call 🪙${callAmt}` : 'Check';
      callBtn.dataset.action = callAmt > 0 ? 'call' : 'check';

      raiseBtn.textContent = callAmt > 0 ? 'Raise' : 'Bet';
      raiseBtn.dataset.action = callAmt > 0 ? 'raise' : 'bet';

      actionStateEl.textContent = callAmt > 0
        ? `Your turn: call ${callAmt}, raise, or fold.`
        : 'Your turn: check or bet.';

      controlsEl.classList.remove('is-disabled');
      slider.disabled = false;
      callBtn.disabled = false;
      raiseBtn.disabled = false;
      foldBtn.disabled = false;
      return;
    }

    controlsEl.classList.add('is-disabled');
    slider.disabled = true;
    callBtn.disabled = true;
    raiseBtn.disabled = true;
    foldBtn.disabled = true;
    callBtn.textContent = 'Check / Call';
    raiseBtn.textContent = 'Bet / Raise';

    if (isShowdown) {
      actionStateEl.textContent = 'Showdown in progress...';
    } else if (!p1 || p1.status === 'FOLDED') {
      actionStateEl.textContent = 'You folded this hand.';
    } else if (!p1 || p1.status === 'BUSTED') {
      actionStateEl.textContent = 'You are out of chips.';
    } else {
      const actorSeat = s.actionTo;
      const actorName = actorSeat !== null && players[actorSeat] ? players[actorSeat]!.name : 'Waiting';
      actionStateEl.textContent = `${actorName} is acting...`;
    }
  }

  showMessage(msg: string) {
    const msgEl = document.getElementById('game-message') as HTMLElement | null;
    if (!msgEl) return;

    msgEl.textContent = msg;
    msgEl.style.opacity = '1';

    setTimeout(() => {
      if (msgEl.textContent === msg) {
        msgEl.style.opacity = '0.55';
      }
    }, 3500);
  }
}
