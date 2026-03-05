'use client';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { PokerGame } from '../game/PokerGame';
import { Renderer } from '../ui/Renderer';

const MAX_SEATS = 8;
type SeatLayout = {
  seatX: number;
  seatY: number;
  betX: number;
  betY: number;
};

const DESKTOP_SEAT_LAYOUTS: SeatLayout[] = [
  { seatX: 50, seatY: 92, betX: 50, betY: 79 },
  { seatX: 23, seatY: 82, betX: 30, betY: 72 },
  { seatX: 10, seatY: 50, betX: 23, betY: 50 },
  { seatX: 23, seatY: 18, betX: 30, betY: 28 },
  { seatX: 50, seatY: 8, betX: 50, betY: 21 },
  { seatX: 77, seatY: 18, betX: 70, betY: 28 },
  { seatX: 90, seatY: 50, betX: 77, betY: 50 },
  { seatX: 77, seatY: 82, betX: 70, betY: 72 },
];

const TABLET_SEAT_LAYOUTS: SeatLayout[] = [
  { seatX: 50, seatY: 90, betX: 50, betY: 78 },
  { seatX: 22, seatY: 80, betX: 30, betY: 70 },
  { seatX: 11, seatY: 50, betX: 24, betY: 50 },
  { seatX: 22, seatY: 20, betX: 30, betY: 30 },
  { seatX: 50, seatY: 9, betX: 50, betY: 22 },
  { seatX: 78, seatY: 20, betX: 70, betY: 30 },
  { seatX: 89, seatY: 50, betX: 76, betY: 50 },
  { seatX: 78, seatY: 80, betX: 70, betY: 70 },
];

const MOBILE_PORTRAIT_SEAT_LAYOUTS: SeatLayout[] = [
  { seatX: 50, seatY: 88, betX: 50, betY: 76 },
  { seatX: 24, seatY: 77, betX: 31, betY: 68 },
  { seatX: 13, seatY: 50, betX: 24, betY: 50 },
  { seatX: 24, seatY: 23, betX: 31, betY: 32 },
  { seatX: 50, seatY: 12, betX: 50, betY: 24 },
  { seatX: 76, seatY: 23, betX: 69, betY: 32 },
  { seatX: 87, seatY: 50, betX: 76, betY: 50 },
  { seatX: 76, seatY: 77, betX: 69, betY: 68 },
];

const MOBILE_LANDSCAPE_SEAT_LAYOUTS: SeatLayout[] = [
  { seatX: 50, seatY: 84, betX: 50, betY: 71 },
  { seatX: 26, seatY: 73, betX: 32, betY: 64 },
  { seatX: 15, seatY: 50, betX: 25, betY: 50 },
  { seatX: 26, seatY: 29, betX: 32, betY: 37 },
  { seatX: 50, seatY: 21, betX: 50, betY: 33 },
  { seatX: 74, seatY: 29, betX: 68, betY: 37 },
  { seatX: 85, seatY: 50, betX: 75, betY: 50 },
  { seatX: 74, seatY: 73, betX: 68, betY: 64 },
];

function pickSeatLayout(width: number, height: number): SeatLayout[] {
  const shortLandscape = width > height && height <= 560;
  if (shortLandscape) return MOBILE_LANDSCAPE_SEAT_LAYOUTS;
  if (width <= 760) return MOBILE_PORTRAIT_SEAT_LAYOUTS;
  if (width <= 1100) return TABLET_SEAT_LAYOUTS;
  return DESKTOP_SEAT_LAYOUTS;
}

export default function Home() {
  const gameRef = useRef<PokerGame | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [seatLayouts, setSeatLayouts] = useState<SeatLayout[]>(DESKTOP_SEAT_LAYOUTS);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncLayouts = () => {
      setSeatLayouts(pickSeatLayout(window.innerWidth, window.innerHeight));
    };

    syncLayouts();
    window.addEventListener('resize', syncLayouts);

    return () => {
      window.removeEventListener('resize', syncLayouts);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && !gameRef.current) {
      const game = new PokerGame();
      const renderer = new Renderer(game);

      game.onStateChange = () => renderer.update();
      game.onMessage = (msg: string) => renderer.showMessage(msg);
      game.onActionLogUpdate = () => renderer.update();
      game.onHandResultUpdate = () => renderer.update();

      gameRef.current = game;
      rendererRef.current = renderer;

      const slider = document.getElementById('bet-slider') as HTMLInputElement | null;
      const display = document.getElementById('bet-amount-display');
      const callBtn = document.getElementById('btn-call');
      const raiseBtn = document.getElementById('btn-raise');
      const nextHandBtn = document.getElementById('btn-next-hand');
      if (!slider || !display || !callBtn || !raiseBtn || !nextHandBtn) return;

      const syncDisplay = () => {
        display.textContent = `🪙 ${slider.value}`;
      };

      const onSliderInput = () => syncDisplay();
      const onMin = () => {
        slider.value = slider.min;
        syncDisplay();
      };
      const onHalf = () => {
        const min = Number.parseInt(slider.min, 10) || 0;
        const max = Number.parseInt(slider.max, 10) || min;
        slider.value = Math.floor((min + max) / 2).toString();
        syncDisplay();
      };
      const onPot = () => {
        const potStr = document.getElementById('total-pot')?.textContent || '0';
        const potVal = Number.parseInt(potStr.replace(/[^\d]/g, ''), 10) || 0;
        const min = Number.parseInt(slider.min, 10) || 0;
        const max = Number.parseInt(slider.max, 10) || min;
        slider.value = Math.min(Math.max(potVal, min), max).toString();
        syncDisplay();
      };
      const onMax = () => {
        slider.value = slider.max;
        syncDisplay();
      };
      const onFold = () => game.handlePlayerAction('fold');
      const onCall = () => {
        const action = (callBtn.getAttribute('data-action') || 'call') as 'call' | 'check';
        game.handlePlayerAction(action);
      };
      const onRaise = () => {
        const action = (raiseBtn.getAttribute('data-action') || 'raise') as 'raise' | 'bet';
        const amount = Number.parseInt(slider.value, 10);
        game.handlePlayerAction(action, Number.isNaN(amount) ? undefined : amount);
      };
      const onNextHand = () => game.startRound();

      slider.addEventListener('input', onSliderInput);
      document.getElementById('btn-min')?.addEventListener('click', onMin);
      document.getElementById('btn-half')?.addEventListener('click', onHalf);
      document.getElementById('btn-pot')?.addEventListener('click', onPot);
      document.getElementById('btn-max')?.addEventListener('click', onMax);
      document.getElementById('btn-fold')?.addEventListener('click', onFold);
      callBtn.addEventListener('click', onCall);
      raiseBtn.addEventListener('click', onRaise);
      nextHandBtn.addEventListener('click', onNextHand);

      game.startRound();
      renderer.update();

      return () => {
        slider.removeEventListener('input', onSliderInput);
        document.getElementById('btn-min')?.removeEventListener('click', onMin);
        document.getElementById('btn-half')?.removeEventListener('click', onHalf);
        document.getElementById('btn-pot')?.removeEventListener('click', onPot);
        document.getElementById('btn-max')?.removeEventListener('click', onMax);
        document.getElementById('btn-fold')?.removeEventListener('click', onFold);
        callBtn.removeEventListener('click', onCall);
        raiseBtn.removeEventListener('click', onRaise);
        nextHandBtn.removeEventListener('click', onNextHand);
      };
    }
  }, []);

  return (
    <div id="app">
      <div className="game-info glass-panel">
        Pot: <span id="total-pot">🪙 0</span> | Blinds: <span id="blind-level">10 / 20</span>
      </div>

      <div id="game-message" className="game-message glass-panel">
        Welcome to Poker!
      </div>

      <div className="table-layout">
        <div className="table-stage anim-slide-up">
          <div className="poker-table">
            <div className="community-cards" id="community-cards">
              <div className="card-slot board-slot"></div>
              <div className="card-slot board-slot"></div>
              <div className="card-slot board-slot"></div>
              <div className="card-slot board-slot"></div>
              <div className="card-slot board-slot"></div>
            </div>
          </div>

          <div className="table-seats">
            {Array.from({ length: MAX_SEATS }, (_, seat) => {
              const layout = seatLayouts[seat] || DESKTOP_SEAT_LAYOUTS[seat];
              const style = {
                '--seat-x': `${layout.seatX}%`,
                '--seat-y': `${layout.seatY}%`,
                '--bet-x': `${layout.betX}%`,
                '--bet-y': `${layout.betY}%`,
              } as CSSProperties;
              const playerId = `p${seat + 1}`;

              return (
                <div className="seat-slot" key={seat}>
                  <div className="seat-anchor" style={style}>
                    <div className={`player-area${seat === 0 ? ' is-you' : ''}`} id={`seat-${seat}`}>
                      <div className="avatar-row">
                        <div className="player-avatar" id={`${playerId}-avatar`}>{seat === 0 ? 'Y' : seat + 1}</div>
                        {seat === 0 && (
                          <div className="player-cards compact" id={`${playerId}-cards`}>
                            <div className="card-slot hole-slot"></div>
                            <div className="card-slot hole-slot"></div>
                          </div>
                        )}
                      </div>
                      <div className="player-info glass-panel">
                        <div className="player-name" id={`${playerId}-name`}>Seat {seat + 1}</div>
                        <div className="player-chips" id={`${playerId}-chips`}>Waiting...</div>
                      </div>
                      {seat !== 0 && (
                        <div className="player-cards" id={`${playerId}-cards`}>
                          <div className="card-slot hole-slot"></div>
                          <div className="card-slot hole-slot"></div>
                        </div>
                      )}
                      <div className="player-status" id={`${playerId}-status`}></div>
                    </div>
                  </div>

                  <div className="seat-bet-anchor" style={style}>
                    <div className="seat-bet" id={`${playerId}-bet`}></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="action-sidebar glass-panel anim-slide-up" style={{ animationDelay: '0.12s' }}>
          <div className="action-sidebar-header">
            <h2>Hand Log</h2>
            <button className="btn tiny" id="btn-next-hand" disabled>
              Next Hand
            </button>
          </div>

          <section className="hand-result">
            <div className="hand-result-title" id="hand-result-title">Hand in progress</div>
            <ul className="hand-result-lines" id="hand-result-lines">
              <li>Every action will be listed here live.</li>
            </ul>
          </section>

          <section className="action-log">
            <ol id="action-log-list"></ol>
          </section>
        </aside>
      </div>

      <div className="controls-container glass-panel anim-slide-up" style={{ animationDelay: '0.2s' }}>
        <div className="action-state" id="action-state">
          Waiting for action...
        </div>

        <div className="bet-slider-container">
          <input type="range" id="bet-slider" min="0" max="1000" defaultValue="0" />
          <span id="bet-amount-display">🪙 0</span>
        </div>

        <div className="btn-group">
          <button className="btn tiny" id="btn-min">Min</button>
          <button className="btn tiny" id="btn-half">1/2</button>
          <button className="btn tiny" id="btn-pot">Pot</button>
          <button className="btn tiny" id="btn-max">Max</button>
        </div>

        <div className="main-actions">
          <button className="btn danger" id="btn-fold">Fold</button>
          <button className="btn" id="btn-call" data-action="check">Check</button>
          <button className="btn primary" id="btn-raise" data-action="bet">Bet</button>
        </div>
      </div>
    </div>
  );
}
