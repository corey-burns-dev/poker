'use client';

import { useEffect, useRef } from 'react';
import { PokerGame } from '../game/PokerGame';
import { Renderer } from '../ui/Renderer';

export default function Home() {
  const gameRef = useRef<PokerGame | null>(null);
  const rendererRef = useRef<Renderer | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && !gameRef.current) {
      const game = new PokerGame();
      const renderer = new Renderer(game);

      game.onStateChange = () => renderer.update();
      game.onMessage = (msg: string) => renderer.showMessage(msg);

      gameRef.current = game;
      rendererRef.current = renderer;

      // Event Listeners for controls
      const setupListeners = () => {
        const slider = document.getElementById('bet-slider') as HTMLInputElement;
        const display = document.getElementById('bet-amount-display')!;
        
        slider?.addEventListener('input', () => {
            display.textContent = `🪙 ${slider.value}`;
        });

        document.getElementById('btn-min')?.addEventListener('click', () => {
            slider.value = slider.min;
            display.textContent = `🪙 ${slider.value}`;
        });

        document.getElementById('btn-half')?.addEventListener('click', () => {
            const max = parseInt(slider.max);
            slider.value = Math.floor(max / 2).toString();
            display.textContent = `🪙 ${slider.value}`;
        });

        document.getElementById('btn-pot')?.addEventListener('click', () => {
            const potStr = document.getElementById('total-pot')?.textContent || "0";
            const potVal = parseInt(potStr.replace(/[^\d]/g, ''));
            const max = parseInt(slider.max);
            slider.value = Math.min(potVal, max).toString();
            display.textContent = `🪙 ${slider.value}`;
        });

        document.getElementById('btn-max')?.addEventListener('click', () => {
            slider.value = slider.max;
            display.textContent = `🪙 ${slider.value}`;
        });

        document.getElementById('btn-fold')?.addEventListener('click', () => {
          game.handlePlayerAction('fold');
        });

        document.getElementById('btn-call')?.addEventListener('click', () => {
          const text = document.getElementById('btn-call')!.textContent;
          if(text?.includes('Check')) {
              game.handlePlayerAction('check');
          } else {
              game.handlePlayerAction('call');
          }
        });

        document.getElementById('btn-raise')?.addEventListener('click', () => {
          game.handlePlayerAction('raise', parseInt(slider.value));
        });
      };

      setupListeners();
      game.startRound();
      renderer.update();
    }
  }, []);

  return (
    <div id="app">
      {/* Top Left Game Info */}
      <div className="game-info glass-panel">
         Pot: <span id="total-pot">🪙 0</span> | Round: <span id="blind-level">Small Blind 10 / Big Blind 20</span>
      </div>

      <div id="game-message" className="glass-panel" style={{ position: 'absolute', top: '120px', zIndex: 10, padding: '10px 24px', fontWeight: 600, fontSize: '1.2rem', transition: 'opacity 0.3s', opacity: 0, pointerEvents: 'none' }}>
        Welcome to Poker!
      </div>

      <div className="poker-table anim-slide-up">
        
        {/* Player 3 (Top) */}
        <div className="player-area top">
          <div className="player-info glass-panel">
            <div className="player-name">Bob</div>
            <div className="player-chips" id="p3-chips">🪙 5,000 <br /> <span style={{ fontSize: '0.8rem' }}>Bet: 0</span></div>
          </div>
          <div className="player-cards" id="p3-cards">
            <div className="card-slot"></div>
            <div className="card-slot"></div>
          </div>
        </div>

        {/* Player 2 (Left) */}
        <div className="player-area left side-player">
          <div className="player-info glass-panel">
            <div className="player-name">Alice</div>
            <div className="player-chips" id="p2-chips">🪙 5,000 <br /> <span style={{ fontSize: '0.8rem' }}>Bet: 0</span></div>
          </div>
          <div className="player-cards" id="p2-cards">
            <div className="card-slot"></div>
            <div className="card-slot"></div>
          </div>
        </div>

        {/* Player 4 (Right) */}
        <div className="player-area right side-player">
          <div className="player-info glass-panel">
            <div className="player-name">Charlie</div>
            <div className="player-chips" id="p4-chips">🪙 5,000 <br /> <span style={{ fontSize: '0.8rem' }}>Bet: 0</span></div>
          </div>
          <div className="player-cards" id="p4-cards">
            <div className="card-slot"></div>
            <div className="card-slot"></div>
          </div>
        </div>

        {/* Community Cards */}
        <div className="community-cards" id="community-cards">
          <div className="card-slot"></div>
          <div className="card-slot"></div>
          <div className="card-slot"></div>
          <div className="card-slot"></div>
          <div className="card-slot"></div>
        </div>

        {/* Player 1 (Bottom - You) */}
        <div className="player-area bottom">
          <div className="player-cards" id="p1-cards">
            <div className="card-slot"></div>
            <div className="card-slot"></div>
          </div>
          <div className="player-info glass-panel">
            <div className="player-name">You</div>
            <div className="player-chips" id="p1-chips">🪙 5,000 <br /> <span style={{ fontSize: '0.8rem' }}>Bet: 0</span></div>
          </div>
        </div>
      </div>

      {/* Extended Controls */}
      <div className="controls-container glass-panel anim-slide-up" style={{ animationDelay: '0.2s' }}>
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
            <button className="btn" id="btn-call">Check / Call</button>
            <button className="btn primary" id="btn-raise">Raise / Bet</button>
        </div>
      </div>
    </div>
  );
}
