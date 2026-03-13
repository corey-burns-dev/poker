import type { ClientPlayer, PokerGameClient } from "../game/PokerGameClient";

const BOT_AVATAR_THEMES = [
  {
    backgroundFrom: "#1e3554",
    backgroundTo: "#122238",
    accent: "#f6c85f",
    skin: "#f2c6a2",
    hair: "#2f1e1b",
    shirt: "#d95d5d",
    accessory: "visor",
  },
  {
    backgroundFrom: "#1c3e3a",
    backgroundTo: "#0e2522",
    accent: "#79d2a6",
    skin: "#e9b78d",
    hair: "#101820",
    shirt: "#2aa876",
    accessory: "glasses",
  },
  {
    backgroundFrom: "#432d56",
    backgroundTo: "#241331",
    accent: "#f29fd6",
    skin: "#f4c8b2",
    hair: "#2d1f3d",
    shirt: "#8f5bd6",
    accessory: "cap",
  },
  {
    backgroundFrom: "#4a3521",
    backgroundTo: "#20150c",
    accent: "#ffb86b",
    skin: "#efbb93",
    hair: "#2d2115",
    shirt: "#f28534",
    accessory: "earring",
  },
  {
    backgroundFrom: "#2d3f1d",
    backgroundTo: "#16210d",
    accent: "#c8e26a",
    skin: "#efc29c",
    hair: "#1f2919",
    shirt: "#7bb661",
    accessory: "headphones",
  },
  {
    backgroundFrom: "#213d52",
    backgroundTo: "#0d1c28",
    accent: "#82d8ff",
    skin: "#f1c7ab",
    hair: "#17202a",
    shirt: "#4aa3d1",
    accessory: "beard",
  },
  {
    backgroundFrom: "#4c2433",
    backgroundTo: "#220f19",
    accent: "#ff92b0",
    skin: "#f0bd97",
    hair: "#25121d",
    shirt: "#d94f7c",
    accessory: "visor",
  },
  {
    backgroundFrom: "#29314a",
    backgroundTo: "#111726",
    accent: "#97b7ff",
    skin: "#ecc39f",
    hair: "#141925",
    shirt: "#5d7ce2",
    accessory: "glasses",
  },
] as const;

export class Renderer {
  private game: PokerGameClient;
  private collectingPotHandNumber: number | null = null;
  private collectedPotHandNumber: number | null = null;
  private potCollectionLayer: HTMLDivElement | null = null;
  private potCollectionTimer: number | null = null;

  constructor(game: PokerGameClient) {
    this.game = game;
  }

  private renderCard(cardStr?: string | null, variant: "board" | "hole" = "hole"): string {
    const sizeClass = variant === "board" ? "board-card" : "hole-card";

    if (cardStr === "__back__") {
      return `<div class="playing-card ${sizeClass} is-card-back">
				<div class="card-back-pattern"></div>
			</div>`;
    }

    if (!cardStr) {
      return '<div class="card-slot hole-slot is-ghost-slot"></div>';
    }

    const rank = cardStr.charAt(0);
    const suitChar = cardStr.charAt(1);

    let suitSymbol = "♠";
    let color = "black";

    switch (suitChar.toLowerCase()) {
      case "h":
        suitSymbol = "♥";
        color = "red";
        break;
      case "d":
        suitSymbol = "♦";
        color = "red";
        break;
      case "c":
        suitSymbol = "♣";
        color = "black";
        break;
      case "s":
        suitSymbol = "♠";
        color = "black";
        break;
      default:
        break;
    }

    const displayRank = rank === "T" ? "10" : rank;

    return `
      <div class="playing-card ${sizeClass} ${color}">
        <div class="value">${displayRank}</div>
        <div class="center-suit">${suitSymbol}</div>
        <div class="suit" style="text-align: right">${suitSymbol}</div>
      </div>
    `;
  }

  private avatarText(name: string, isYou: boolean): string {
    if (isYou) return "You";
    const cleaned = name.trim();
    if (!cleaned) return "?";
    return cleaned.charAt(0).toUpperCase();
  }

  private formatAmount(amount: number): string {
    return amount.toLocaleString("en-US");
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private updateReviewSidebar() {
    const logListEl = document.getElementById("action-log-list") as HTMLOListElement | null;
    if (logListEl) {
      const lines = this.game.actionLogEntries;
      const nearBottom = logListEl.scrollHeight - logListEl.scrollTop - logListEl.clientHeight < 24;
      logListEl.innerHTML = lines.map((line) => `<li>${this.escapeHtml(line)}</li>`).join("");
      if (nearBottom) {
        logListEl.scrollTop = logListEl.scrollHeight;
      }
    }

    const resultTitleEl = document.getElementById("hand-result-title");
    const resultLinesEl = document.getElementById("hand-result-lines");
    const result = this.game.handResultSummary;
    if (resultTitleEl) {
      resultTitleEl.textContent = result ? result.heading : "Hand in progress";
      resultTitleEl.className = `action-sidebar-summary hand-result-title${result ? ` is-${result.heroOutcome}` : ""}`;
    }
    if (resultLinesEl) {
      resultLinesEl.innerHTML = result
        ? result.lines.map((line) => `<li>${this.escapeHtml(line)}</li>`).join("")
        : "<li>Exact hand details will appear here when a hand ends.</li>";
    }
  }

  private static readonly CHIP_DENOMINATIONS = [
    { value: 500, cls: "chip-purple" },
    { value: 100, cls: "chip-black" },
    { value: 25, cls: "chip-green" },
    { value: 5, cls: "chip-red" },
    { value: 1, cls: "chip-white" },
  ] as const;

  private buildChips(amount: number): string[] {
    const chips: string[] = [];
    let rem = amount;

    outer: for (const { value, cls } of Renderer.CHIP_DENOMINATIONS) {
      for (let i = 0; i < 4 && rem >= value; i++) {
        chips.push(`<div class="chip ${cls}"></div>`);
        rem -= value;
        if (chips.length >= 5) break outer;
      }
    }

    if (chips.length === 0) chips.push('<div class="chip chip-white"></div>');
    return chips;
  }

  private renderChipStack(amount: number): string {
    const chips = this.buildChips(amount);
    return `<div class="bet-label">${this.formatAmount(amount)}</div><div class="chip-stack">${chips.join("")}</div>`;
  }

  private renderChipsOnly(amount: number): string {
    const chips = this.buildChips(amount);
    return `<div class="chip-stack">${chips.join("")}</div>`;
  }

  private clearPotCollectionLayer() {
    if (this.potCollectionTimer != null) {
      window.clearTimeout(this.potCollectionTimer);
      this.potCollectionTimer = null;
    }

    document.querySelectorAll<HTMLElement>(".seat-bet.is-collecting-source").forEach((el) => {
      el.classList.remove("is-collecting-source");
    });

    this.potCollectionLayer?.remove();
    this.potCollectionLayer = null;
  }

  private syncPotCollectionState(handNumber: number | null) {
    if (
      handNumber == null ||
      (this.collectingPotHandNumber != null && this.collectingPotHandNumber !== handNumber)
    ) {
      this.collectingPotHandNumber = null;
      this.clearPotCollectionLayer();
    }

    if (
      handNumber == null ||
      (this.collectedPotHandNumber != null && this.collectedPotHandNumber !== handNumber)
    ) {
      this.collectedPotHandNumber = null;
    }
  }

  private maybeAnimatePotToWinner() {
    const state = this.game.view;
    const handNumber = state.handNumber;
    const winners = state.winners;
    if (
      handNumber == null ||
      winners == null ||
      winners.length === 0 ||
      this.collectingPotHandNumber === handNumber ||
      this.collectedPotHandNumber === handNumber
    ) {
      return;
    }

    const winnerSeat = winners[0]?.seat;
    if (winnerSeat == null) {
      this.collectedPotHandNumber = handNumber;
      window.setTimeout(() => this.update(), 0);
      return;
    }

    const winnerAvatar = document.getElementById(`p${winnerSeat + 1}-avatar`);
    if (!(winnerAvatar instanceof HTMLElement)) {
      return;
    }

    const sourceBets = Array.from(
      document.querySelectorAll<HTMLElement>(".seat-bet.visible"),
    ).filter((betEl) => betEl.childElementCount > 0);

    if (sourceBets.length === 0) {
      this.collectedPotHandNumber = handNumber;
      window.setTimeout(() => this.update(), 0);
      return;
    }

    this.collectingPotHandNumber = handNumber;
    this.clearPotCollectionLayer();

    const targetRect = winnerAvatar.getBoundingClientRect();
    const targetX = targetRect.left + targetRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2;
    const layer = document.createElement("div");
    layer.className = "pot-collection-layer";
    document.body.appendChild(layer);
    this.potCollectionLayer = layer;

    const duration = 880;
    const stagger = 70;

    for (const [index, sourceBet] of sourceBets.entries()) {
      const sourceRect = sourceBet.getBoundingClientRect();
      const sourceX = sourceRect.left + sourceRect.width / 2;
      const sourceY = sourceRect.top + sourceRect.height / 2;
      const clone = document.createElement("div");
      clone.className = "pot-collecting-clone";
      clone.innerHTML = sourceBet.innerHTML;
      clone.style.left = `${sourceRect.left}px`;
      clone.style.top = `${sourceRect.top}px`;
      clone.style.width = `${sourceRect.width}px`;
      clone.style.height = `${sourceRect.height}px`;
      layer.appendChild(clone);
      sourceBet.classList.add("is-collecting-source");
      clone.animate(
        [
          {
            transform: "translate3d(0, 0, 0) scale(1)",
            opacity: "1",
          },
          {
            transform: `translate3d(${targetX - sourceX}px, ${targetY - sourceY}px, 0) scale(0.36)`,
            opacity: "0.1",
          },
        ],
        {
          duration,
          delay: index * stagger,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          fill: "forwards",
        },
      );
    }

    this.potCollectionTimer = window.setTimeout(
      () => {
        this.clearPotCollectionLayer();
        this.collectingPotHandNumber = null;
        this.collectedPotHandNumber = handNumber;
        this.update();
      },
      duration + sourceBets.length * stagger + 140,
    );
  }

  private renderAccessory(
    type: (typeof BOT_AVATAR_THEMES)[number]["accessory"],
    accent: string,
    hair: string,
  ): string {
    switch (type) {
      case "visor":
        return `
					<path d="M24 30c7-6 25-6 32 0v7H24z" fill="${accent}" opacity="0.96" />
					<path d="M24 37c4 3 24 3 32 0v6H24z" fill="${hair}" opacity="0.68" />
				`;
      case "glasses":
        return `
					<rect x="23" y="42" width="12" height="8" rx="3" fill="none" stroke="${accent}" stroke-width="2.5" />
					<rect x="45" y="42" width="12" height="8" rx="3" fill="none" stroke="${accent}" stroke-width="2.5" />
					<path d="M35 46h10" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" />
				`;
      case "cap":
        return `
					<path d="M24 35c3-12 29-12 32 0v7H24z" fill="${accent}" />
					<path d="M27 42c8-3 18-3 26 0" stroke="${hair}" stroke-width="3" stroke-linecap="round" />
				`;
      case "earring":
        return '<circle cx="56" cy="58" r="2.2" fill="#ffd7a8" stroke="#fef3d4" stroke-width="1.3" />';
      case "headphones":
        return `
					<path d="M27 40a13 13 0 0 1 26 0" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" />
					<rect x="21" y="42" width="7" height="16" rx="3.5" fill="${accent}" />
					<rect x="54" y="42" width="7" height="16" rx="3.5" fill="${accent}" />
				`;
      case "beard":
        return '<path d="M31 61c2 8 8 12 13 12s11-4 13-12c-2 1-5 2-8 2H39c-3 0-6-1-8-2Z" fill="#3b261d" opacity="0.85" />';
      default:
        return "";
    }
  }

  private botAvatarDataUri(seatIndex: number): string {
    const theme = BOT_AVATAR_THEMES[seatIndex % BOT_AVATAR_THEMES.length];
    const svg = `
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" role="img" aria-hidden="true">
				<defs>
					<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
						<stop offset="0%" stop-color="${theme.backgroundFrom}" />
						<stop offset="100%" stop-color="${theme.backgroundTo}" />
					</linearGradient>
				</defs>
				<rect width="80" height="80" rx="40" fill="url(#bg)" />
				<circle cx="62" cy="16" r="9" fill="${theme.accent}" opacity="0.22" />
				<path d="M18 79c1-14 11-24 22-24h1c11 0 21 10 22 24" fill="${theme.shirt}" />
				<circle cx="40" cy="41" r="15.5" fill="${theme.skin}" />
				<path d="M24 40c1-10 8-17 16-17 9 0 16 7 16 17-2-4-6-7-10-8-6-2-14-1-22 8Z" fill="${theme.hair}" />
				<circle cx="34" cy="44" r="1.8" fill="#17202a" />
				<circle cx="46" cy="44" r="1.8" fill="#17202a" />
				<path d="M35 52c3 2 7 2 10 0" fill="none" stroke="#9d5f4a" stroke-width="2.2" stroke-linecap="round" />
				${this.renderAccessory(theme.accessory, theme.accent, theme.hair)}
			</svg>
		`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }

  private renderAvatar(player: ClientPlayer, seatIndex: number): string {
    if (player.isBot) {
      return `<img class="player-avatar-image" src="${this.botAvatarDataUri(seatIndex)}" alt="${this.escapeHtml(player.name)} avatar" />`;
    }

    return `<span class="player-avatar-label">${this.escapeHtml(this.avatarText(player.name, player.isCurrentUser))}</span>`;
  }

  private updatePlayerArea(
    seatIndex: number,
    player: ClientPlayer | null,
    showAllCards: boolean,
    winnerSeats: Set<number>,
    handEndMode: "fold" | "showdown" | null,
    hideBetStack: boolean,
  ) {
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
      area.classList.add("is-empty");
      area.classList.remove("is-active", "is-folded", "is-busted", "is-winner");
      avatarEl.dataset.badge = "";
      avatarEl.innerHTML = `<span class="player-avatar-label">${seatIndex + 1}</span>`;
      nameEl.textContent = `Seat ${seatIndex + 1}`;
      chipsEl.textContent = "Open seat";
      cardsEl.innerHTML = "";
      cardsEl.classList.remove("is-folded");
      cardsEl.classList.remove("is-winner");
      statusEl.textContent = "";
      betEl.classList.remove("visible");
      betEl.textContent = "";
      return;
    }

    area.classList.remove("is-empty");

    const isYou = player.isCurrentUser;
    const isActive = this.game.state.actionTo === player.seat;
    const isFolded = player.status === "FOLDED";
    const isBusted = player.status === "BUSTED";
    const isSittingOut = player.status === "SITTING_OUT";
    const isReady = player.status === "READY";
    const isWinner = winnerSeats.has(player.seat);
    const wasInHand = player.contributedThisHand > 0 || player.hand.some((card) => card != null);
    const isFoldWinLoser = handEndMode === "fold" && !isWinner && wasInHand;
    const displayFolded = isFolded || isFoldWinLoser;
    const isOut = displayFolded || isBusted || isSittingOut;

    area.classList.toggle("is-active", isActive);
    area.classList.toggle("is-folded", displayFolded);
    area.classList.toggle("is-busted", isBusted);
    area.classList.toggle("is-winner", isWinner);
    cardsEl.classList.toggle("is-folded", displayFolded);
    cardsEl.classList.toggle("is-winner", isWinner);

    let badge = "";
    if (this.game.state.buttonSeat === player.seat) badge = "D";
    else if (this.game.state.smallBlindSeat === player.seat) badge = "SB";
    else if (this.game.state.bigBlindSeat === player.seat) badge = "BB";

    avatarEl.dataset.badge = badge;
    avatarEl.innerHTML = this.renderAvatar(player, seatIndex);
    nameEl.textContent =
      this.game.state.buttonSeat === player.seat ? `${player.name} • Dealer` : player.name;
    chipsEl.textContent = this.formatAmount(player.stack);

    if (isWinner) {
      statusEl.textContent = handEndMode === "fold" ? "Won by fold" : "Winner";
    } else if (isOut) {
      statusEl.textContent = displayFolded
        ? "Folded"
        : isSittingOut
          ? player.willPlayNextHand
            ? "Next hand"
            : "Sitting out"
          : "Out";
    } else if (this.game.thinkingSeat === player.seat && !isYou) {
      statusEl.textContent = "Thinking...";
    } else if (player.status === "ALL_IN") {
      statusEl.textContent = "All-in";
    } else if (isReady) {
      statusEl.textContent = "Ready";
    } else {
      statusEl.textContent = "";
    }

    let cardsToRender: Array<string | null> = [null, null];

    if (player.hand && player.hand.length > 0) {
      if (isYou || showAllCards) {
        cardsToRender = player.hand.filter((card) => card !== "__back__") as Array<string | null>;
      } else {
        cardsToRender = [];
      }
    }

    if ((displayFolded || isBusted || isSittingOut || isReady) && !showAllCards) {
      cardsToRender = [];
    }

    if (cardsToRender.length === 0) {
      cardsEl.innerHTML = "";
    } else {
      cardsEl.innerHTML = cardsToRender.map((card) => this.renderCard(card, "hole")).join("");
    }

    const betAmount = player.contributedThisHand || 0;
    if (!hideBetStack && betAmount > 0) {
      betEl.classList.add("visible");
      betEl.innerHTML = this.renderChipStack(betAmount);
    } else {
      betEl.classList.remove("visible");
      betEl.innerHTML = "";
    }
  }

  update() {
    const s = this.game.view;
    this.syncPotCollectionState(s.handNumber);
    const players = s.players;
    const showAllCards = s.handEndMode === "showdown";
    const winnerSeats = new Set((s.winners ?? []).map((winner) => winner.seat));
    const hideCollectedBets =
      s.winners !== null &&
      (this.collectingPotHandNumber === s.handNumber ||
        this.collectedPotHandNumber === s.handNumber);

    for (let seat = 0; seat < this.game.config.maxPlayers; seat += 1) {
      this.updatePlayerArea(
        seat,
        players[seat] || null,
        showAllCards,
        winnerSeats,
        s.handEndMode,
        hideCollectedBets,
      );
    }

    const totalPot =
      s.pots.reduce((sum, pot) => sum + pot.amount, 0) +
      Array.from(s.currentBets.values()).reduce((sum, bet) => sum + bet, 0);

    const potEl = document.getElementById("total-pot");
    if (potEl) potEl.textContent = `🪙 ${totalPot}`;

    const potChipsEl = document.getElementById("pot-chips");
    if (potChipsEl) potChipsEl.innerHTML = this.renderChipsOnly(totalPot);

    const blindsEl = document.getElementById("blind-level");
    if (blindsEl) blindsEl.textContent = `${s.smallBlind} / ${s.bigBlind}`;

    const commContainer = document.getElementById("community-cards");
    if (commContainer) {
      commContainer.innerHTML = s.board.map((card) => this.renderCard(card, "board")).join("");
      const emptySlots = 5 - s.board.length;
      for (let i = 0; i < emptySlots; i += 1) {
        commContainer.innerHTML += '<div class="card-slot board-slot"></div>';
      }
    }

    this.updateReviewSidebar();

    const controlsEl = document.querySelector(".controls-container") as HTMLElement | null;
    const actionStateEl = document.getElementById("action-state");
    const slider = document.getElementById("bet-slider") as HTMLInputElement | null;
    const sliderDisplay = document.getElementById("bet-amount-display");
    const callBtn = document.getElementById("btn-call") as HTMLButtonElement | null;
    const raiseBtn = document.getElementById("btn-raise") as HTMLButtonElement | null;
    const foldBtn = document.getElementById("btn-fold") as HTMLButtonElement | null;

    if (
      !controlsEl ||
      !slider ||
      !sliderDisplay ||
      !callBtn ||
      !raiseBtn ||
      !foldBtn ||
      !actionStateEl
    ) {
      return;
    }

    const heroSeatIndex = this.game.heroSeatIndex;
    const heroPlayer = heroSeatIndex != null ? players[heroSeatIndex] : null;
    const heroActive =
      heroSeatIndex != null &&
      s.actionTo === heroSeatIndex &&
      !showAllCards &&
      heroPlayer &&
      heroPlayer.status === "ACTIVE";

    if (heroActive) {
      const currentBet = Array.from(s.currentBets.values()).reduce(
        (max, bet) => Math.max(max, bet),
        0,
      );
      const heroBet = s.currentBets.get(heroPlayer.seat) ?? heroPlayer.betThisStreet;
      const callAmt = Math.max(0, currentBet - heroBet);
      const maxTarget = heroBet + heroPlayer.stack;
      const minRaiseTarget =
        currentBet > 0 ? currentBet + Math.max(1, s.lastRaiseAmount) : Math.max(1, s.bigBlind);
      const minTarget =
        callAmt > 0
          ? Math.min(maxTarget, minRaiseTarget)
          : Math.min(maxTarget, Math.max(1, s.bigBlind));
      const canRaise = currentBet > 0 ? maxTarget > currentBet : maxTarget > 0;

      slider.min = minTarget.toString();
      slider.max = maxTarget.toString();

      const value = Number.parseInt(slider.value, 10);
      if (Number.isNaN(value) || value < minTarget) slider.value = slider.min;
      if (Number.parseInt(slider.value, 10) > maxTarget) slider.value = slider.max;

      sliderDisplay.textContent = `🪙 ${slider.value}`;

      callBtn.textContent = callAmt > 0 ? `Call 🪙${callAmt}` : "Check";
      callBtn.dataset.action = callAmt > 0 ? "call" : "check";

      raiseBtn.textContent = callAmt > 0 ? "Raise" : "Bet";
      raiseBtn.dataset.action = callAmt > 0 ? "raise" : "bet";

      actionStateEl.textContent =
        callAmt > 0
          ? canRaise
            ? `Your turn: call ${callAmt}, raise, or fold.`
            : `Your turn: call ${callAmt} or fold.`
          : "Your turn: check or bet.";

      controlsEl.classList.remove("is-disabled");
      slider.disabled = !canRaise;
      callBtn.disabled = false;
      raiseBtn.disabled = !canRaise;
      foldBtn.disabled = false;
      return;
    }

    controlsEl.classList.add("is-disabled");
    slider.disabled = true;
    callBtn.disabled = true;
    raiseBtn.disabled = true;
    foldBtn.disabled = true;
    callBtn.textContent = "Check / Call";
    raiseBtn.textContent = "Bet / Raise";

    if (s.winners !== null) {
      actionStateEl.textContent = s.manualStartRequired
        ? "Hand complete. Start the next hand when ready."
        : "Hand complete. Next hand starts in 5 seconds.";
    } else if (s.street === "SHOWDOWN") {
      actionStateEl.textContent = "Showdown in progress...";
    } else if (!heroPlayer) {
      actionStateEl.textContent = "Join the game to take the open seat.";
    } else if (heroPlayer.status === "SITTING_OUT") {
      actionStateEl.textContent = heroPlayer.willPlayNextHand
        ? s.manualStartRequired
          ? "You will be dealt into the next hand when it starts."
          : "You will be dealt into the next hand after the 5 second pause."
        : "You are sitting out, but your seat is still yours.";
    } else if (heroPlayer.status === "READY") {
      actionStateEl.textContent = s.manualStartRequired
        ? "Waiting for the next hand. Press Start Next Hand when ready."
        : "Waiting for the next hand to begin after the 5 second pause.";
    } else if (heroPlayer.status === "FOLDED") {
      actionStateEl.textContent = "You folded this hand.";
    } else if (heroPlayer.status === "BUSTED") {
      actionStateEl.textContent = "You are out of chips.";
    } else {
      const actorSeat = s.actionTo;
      const actorName =
        actorSeat !== null && players[actorSeat] ? players[actorSeat]?.name : "Waiting";
      actionStateEl.textContent = `${actorName} is acting...`;
    }

    this.maybeAnimatePotToWinner();
  }

  showMessage(msg: string) {
    const msgEl = document.getElementById("game-message") as HTMLElement | null;
    if (!msgEl) return;

    msgEl.textContent = msg;
    msgEl.style.opacity = "1";

    setTimeout(() => {
      if (msgEl.textContent === msg) {
        msgEl.style.opacity = "0.55";
      }
    }, 3500);
  }
}
