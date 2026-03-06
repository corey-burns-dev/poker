import type { ClientPlayer, PhoenixPokerGame } from "../game/PhoenixPokerGame";

export class Renderer {
	private game: PhoenixPokerGame;

	constructor(game: PhoenixPokerGame) {
		this.game = game;
	}

	private renderCard(
		cardStr?: string | null,
		variant: "board" | "hole" = "hole",
	): string {
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

	private escapeHtml(value: string): string {
		return value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;");
	}

	private updateReviewSidebar() {
		const logListEl = document.getElementById(
			"action-log-list",
		) as HTMLOListElement | null;
		if (logListEl) {
			const lines = this.game.actionLogEntries;
			const nearBottom =
				logListEl.scrollHeight - logListEl.scrollTop - logListEl.clientHeight <
				24;
			logListEl.innerHTML = lines
				.map((line) => `<li>${this.escapeHtml(line)}</li>`)
				.join("");
			if (nearBottom) {
				logListEl.scrollTop = logListEl.scrollHeight;
			}
		}

		const resultTitleEl = document.getElementById("hand-result-title");
		const resultLinesEl = document.getElementById("hand-result-lines");
		const result = this.game.handResultSummary;
		if (resultTitleEl) {
			resultTitleEl.textContent = result ? result.heading : "Hand in progress";
			resultTitleEl.className = `hand-result-title${result ? ` is-${result.heroOutcome}` : ""}`;
		}
		if (resultLinesEl) {
			resultLinesEl.innerHTML = result
				? result.lines
						.map((line) => `<li>${this.escapeHtml(line)}</li>`)
						.join("")
				: "<li>Every action will be listed here live.</li>";
		}
	}

	private updatePlayerArea(
		seatIndex: number,
		player: ClientPlayer | null,
		isShowdown: boolean,
	) {
		const playerId = `p${seatIndex + 1}`;
		const area = document.getElementById(
			`seat-${seatIndex}`,
		) as HTMLElement | null;
		const nameEl = document.getElementById(`${playerId}-name`);
		const chipsEl = document.getElementById(`${playerId}-chips`);
		const cardsEl = document.getElementById(`${playerId}-cards`);
		const avatarEl = document.getElementById(`${playerId}-avatar`);
		const statusEl = document.getElementById(`${playerId}-status`);
		const betEl = document.getElementById(
			`${playerId}-bet`,
		) as HTMLElement | null;

		if (
			!area ||
			!nameEl ||
			!chipsEl ||
			!cardsEl ||
			!avatarEl ||
			!statusEl ||
			!betEl
		)
			return;

		if (!player) {
			area.classList.add("is-empty");
			area.classList.remove("is-active", "is-folded", "is-busted");
			avatarEl.textContent = (seatIndex + 1).toString();
			nameEl.textContent = `Seat ${seatIndex + 1}`;
			chipsEl.textContent = "Open seat";
			cardsEl.innerHTML = "";
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
		const isOut = isFolded || isBusted || isSittingOut;

		area.classList.toggle("is-active", isActive);
		area.classList.toggle("is-folded", isFolded);
		area.classList.toggle("is-busted", isBusted);

		avatarEl.textContent = this.avatarText(player.name, isYou);

		const markers: string[] = [];
		if (this.game.state.buttonSeat === player.seat) markers.push("D");
		if (isActive) markers.push("Acting");
		if (player.status === "ALL_IN") markers.push("All-in");
		if (isReady && !isActive) markers.push("Ready");
		nameEl.textContent = markers.length
			? `${player.name} (${markers.join(" | ")})`
			: player.name;

		chipsEl.innerHTML = `🪙 ${player.stack}<br><span class="bet-line">Bet: 🪙${player.betThisStreet}</span>`;

		if (isOut) {
			statusEl.textContent = isFolded
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
			if (isYou || isShowdown) {
				cardsToRender = player.hand as Array<string | null>;
			} else {
				cardsToRender = player.hand.map(() => null);
			}
		}

		if (isFolded || isBusted || isSittingOut || isReady) {
			cardsToRender = [];
		}

		if (cardsToRender.length === 0) {
			cardsEl.innerHTML = "";
		} else {
			cardsEl.innerHTML = cardsToRender
				.map((card) => this.renderCard(card, "hole"))
				.join("");
		}

		const betAmount = player.betThisStreet || 0;
		if (betAmount > 0 && !isOut) {
			betEl.classList.add("visible");
			betEl.textContent = `🪙 ${betAmount}`;
		} else {
			betEl.classList.remove("visible");
			betEl.textContent = "";
		}
	}

	update() {
		const s = this.game.view;
		const players = s.players;
		const isShowdown = s.street === "SHOWDOWN";

		for (let seat = 0; seat < this.game.config.maxPlayers; seat += 1) {
			this.updatePlayerArea(seat, players[seat] || null, isShowdown);
		}

		const totalPot =
			s.pots.reduce((sum, pot) => sum + pot.amount, 0) +
			Array.from(s.currentBets.values()).reduce((sum, bet) => sum + bet, 0);

		const potEl = document.getElementById("total-pot");
		if (potEl) potEl.textContent = `🪙 ${totalPot}`;

		const blindsEl = document.getElementById("blind-level");
		if (blindsEl) blindsEl.textContent = `${s.smallBlind} / ${s.bigBlind}`;

		const commContainer = document.getElementById("community-cards");
		if (commContainer) {
			commContainer.innerHTML = s.board
				.map((card) => this.renderCard(card, "board"))
				.join("");
			const emptySlots = 5 - s.board.length;
			for (let i = 0; i < emptySlots; i += 1) {
				commContainer.innerHTML += '<div class="card-slot board-slot"></div>';
			}
		}

		this.updateReviewSidebar();

		const controlsEl = document.querySelector(
			".controls-container",
		) as HTMLElement | null;
		const actionStateEl = document.getElementById("action-state");
		const slider = document.getElementById(
			"bet-slider",
		) as HTMLInputElement | null;
		const sliderDisplay = document.getElementById("bet-amount-display");
		const callBtn = document.getElementById(
			"btn-call",
		) as HTMLButtonElement | null;
		const raiseBtn = document.getElementById(
			"btn-raise",
		) as HTMLButtonElement | null;
		const foldBtn = document.getElementById(
			"btn-fold",
		) as HTMLButtonElement | null;

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
			!isShowdown &&
			heroPlayer &&
			heroPlayer.status === "ACTIVE";

		if (heroActive) {
			const currentBet = Array.from(s.currentBets.values()).reduce(
				(max, bet) => Math.max(max, bet),
				0,
			);
			const heroBet =
				s.currentBets.get(heroPlayer.seat) ?? heroPlayer.betThisStreet;
			const callAmt = Math.max(0, currentBet - heroBet);
			const maxTarget = heroBet + heroPlayer.stack;
			const minRaiseTarget =
				currentBet > 0
					? currentBet + Math.max(1, s.lastRaiseAmount)
					: Math.max(1, s.bigBlind);
			const minTarget =
				callAmt > 0
					? Math.min(maxTarget, minRaiseTarget)
					: Math.min(maxTarget, Math.max(1, s.bigBlind));
			const canRaise = currentBet > 0 ? maxTarget > currentBet : maxTarget > 0;

			slider.min = minTarget.toString();
			slider.max = maxTarget.toString();

			const value = Number.parseInt(slider.value, 10);
			if (Number.isNaN(value) || value < minTarget) slider.value = slider.min;
			if (Number.parseInt(slider.value, 10) > maxTarget)
				slider.value = slider.max;

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
			actionStateEl.textContent =
				"Hand complete. Next hand starts in 5 seconds.";
		} else if (isShowdown) {
			actionStateEl.textContent = "Showdown in progress...";
		} else if (!heroPlayer) {
			actionStateEl.textContent = "Join the game to take the open seat.";
		} else if (heroPlayer.status === "SITTING_OUT") {
			actionStateEl.textContent = heroPlayer.willPlayNextHand
				? "You will be dealt into the next hand after the 5 second pause."
				: "You are sitting out, but your seat is still yours.";
		} else if (heroPlayer.status === "READY") {
			actionStateEl.textContent =
				"Waiting for the next hand to begin after the 5 second pause.";
		} else if (heroPlayer.status === "FOLDED") {
			actionStateEl.textContent = "You folded this hand.";
		} else if (heroPlayer.status === "BUSTED") {
			actionStateEl.textContent = "You are out of chips.";
		} else {
			const actorSeat = s.actionTo;
			const actorName =
				actorSeat !== null && players[actorSeat]
					? players[actorSeat]?.name
					: "Waiting";
			actionStateEl.textContent = `${actorName} is acting...`;
		}
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
