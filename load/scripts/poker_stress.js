import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const options = {};

const MAX_SEATS = 8;
const BIG_BLIND = 20;
const BASE_URL = (__ENV.BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/socket/websocket?vsn=2.0.0`;
const TABLE_PREFIX = __ENV.TABLE_PREFIX || 'stress-table';
const RUN_SEED = __ENV.RUN_SEED || `${Date.now()}`;
const HUMANS_PER_TABLE = clamp(intEnv('HUMANS_PER_TABLE', 2), 1, MAX_SEATS);
const SESSION_SECONDS = intEnv('SESSION_SECONDS', 180);
const HEARTBEAT_MS = intEnv('HEARTBEAT_MS', 25000);
const JOIN_RETRY_MS = intEnv('JOIN_RETRY_MS', 4000);
const START_RETRY_MS = intEnv('START_RETRY_MS', 3000);
const START_DELAY_MS = intEnv('START_DELAY_MS', 750);
const SETUP_STAGGER_MS = intEnv('SETUP_STAGGER_MS', 1400);
const ACTION_DELAY_MIN_MS = intEnv('ACTION_DELAY_MIN_MS', 150);
const ACTION_DELAY_MAX_MS = intEnv('ACTION_DELAY_MAX_MS', 900);

const pokerTablesBootstrapped = new Counter('poker_tables_bootstrapped');
const pokerActionsSent = new Counter('poker_actions_sent');
const pokerHandsObserved = new Counter('poker_hands_observed');
const pokerSessionsConnected = new Rate('poker_sessions_connected');
const pokerActionErrors = new Rate('poker_action_errors');
const pokerJoinLatency = new Trend('poker_join_latency', true);

function intEnv(name, fallbackValue) {
  const raw = __ENV[name];
  if (!raw) return fallbackValue;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function playerPlan() {
  const zeroBasedVu = __VU - 1;
  const seatOffset = zeroBasedVu % HUMANS_PER_TABLE;
  const tableOrdinal = Math.floor(zeroBasedVu / HUMANS_PER_TABLE) + 1;
  const seat = seatOffset + 1;

  return {
    playerId: `stress-player-${RUN_SEED}-${__VU}`,
    playerName: `Stress ${String(__VU).padStart(4, '0')}`,
    tableId: `${TABLE_PREFIX}-${RUN_SEED}-${tableOrdinal}`,
    seat,
    seatOffset,
    isCaptain: seatOffset === 0,
  };
}

function actionUrl(tableId, action) {
  return `${BASE_URL}/api/tables/${encodeURIComponent(tableId)}/actions?action=${encodeURIComponent(action)}`;
}

function postTableAction(tableId, action, payload = {}) {
  const requestPayload = Object.assign({ action: action }, payload);
  const response = http.post(
    actionUrl(tableId, action),
    JSON.stringify(requestPayload),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { endpoint: 'table_action', action },
    }
  );

  const ok = check(response, {
    [`${action} bootstrap status is 200`]: (res) => res.status === 200,
  });

  pokerActionErrors.add(!ok);
  return response;
}

function bootstrapTable(plan) {
  if (!plan.isCaptain) {
    sleep(((plan.seatOffset + 1) * SETUP_STAGGER_MS) / 1000);
    return;
  }

  postTableAction(plan.tableId, 'clear_table');

  for (let seat = HUMANS_PER_TABLE + 1; seat <= MAX_SEATS; seat += 1) {
    postTableAction(plan.tableId, 'add_bot', { seat });
  }

  pokerTablesBootstrapped.add(1);
  sleep(SETUP_STAGGER_MS / 1000);
}

function findPlayer(state, playerId) {
  if (!state || !Array.isArray(state.players)) return null;
  return state.players.find((player) => String(player.player_id) === String(playerId)) || null;
}

function findPendingPlayer(state, playerId) {
  if (!state || !Array.isArray(state.pending_players)) return null;
  return state.pending_players.find((player) => String(player.player_id) === String(playerId)) || null;
}

function readyPlayerCount(state) {
  if (!state || !Array.isArray(state.players)) return 0;

  return state.players.filter((player) => player.stack > 0 && player.will_play_next_hand).length;
}

function activeBotCount(state) {
  if (!state || !Array.isArray(state.players)) return 0;

  return state.players.filter((player) => player.is_bot && player.stack > 0).length;
}

function isEmptySeat(player) {
  return player && player.is_bot && player.player_id === null && player.stack <= 0;
}

function currentDecisionKey(state, seat) {
  const handState = state && state.hand_state;
  if (!handState) return 'missing-hand-state';

  return [
    handState.hand_number,
    handState.stage,
    handState.acting_seat,
    handState.current_bet,
    handState.pot,
    seat,
  ].join(':');
}

function buildBetTarget(state, player) {
  const maxTarget = player.bet_this_street + player.stack;
  const desired = Math.max(BIG_BLIND, Math.round(Math.max(state.hand_state.pot, BIG_BLIND * 2) * 0.6));
  return clamp(desired, BIG_BLIND, maxTarget);
}

function buildRaiseTarget(state, player) {
  const currentBet = state.hand_state.current_bet;
  const minimumRaiseTarget = currentBet + state.hand_state.minimum_raise;
  const maxTarget = player.bet_this_street + player.stack;

  if (maxTarget <= currentBet) return null;
  if (maxTarget < minimumRaiseTarget) return maxTarget;

  const desired = currentBet + Math.round(Math.max(state.hand_state.pot + currentBet, BIG_BLIND * 2) * 0.7);
  return clamp(desired, minimumRaiseTarget, maxTarget);
}

function chooseAction(state, player) {
  const currentBet = state.hand_state.current_bet;
  const toCall = Math.max(currentBet - player.bet_this_street, 0);

  if (toCall === 0) {
    if (player.stack <= BIG_BLIND || Math.random() < 0.82) {
      return { action: 'check', payload: {} };
    }

    return {
      action: 'bet',
      payload: { amount: buildBetTarget(state, player) },
    };
  }

  if (player.stack <= toCall) {
    return { action: 'call', payload: {} };
  }

  const pressure = toCall / Math.max(player.stack, 1);

  if (pressure >= 0.5) {
    return Math.random() < 0.85 ? { action: 'fold', payload: {} } : { action: 'call', payload: {} };
  }

  if (pressure >= 0.25) {
    return Math.random() < 0.7 ? { action: 'call', payload: {} } : { action: 'fold', payload: {} };
  }

  if (pressure <= 0.08 && Math.random() < 0.14) {
    const raiseTarget = buildRaiseTarget(state, player);

    if (raiseTarget && raiseTarget > currentBet) {
      return {
        action: 'raise',
        payload: { amount: raiseTarget },
      };
    }
  }

  return Math.random() < 0.82 ? { action: 'call', payload: {} } : { action: 'fold', payload: {} };
}

export default function () {
  const plan = playerPlan();
  const tableTopic = `table:${plan.tableId}`;

  bootstrapTable(plan);

  const response = ws.connect(WS_URL, {}, function (socket) {
    let refCounter = 1;
    let joinedAtMs = Date.now();
    let latestState = null;
    let joinRecorded = false;
    let lastJoinAttemptMs = 0;
    let lastStartAttemptMs = 0;
    let lastDecision = null;
    let lastObservedHand = null;
    let scheduledStartKey = null;

    function send(topic, event, payload) {
      const ref = String(refCounter);
      refCounter += 1;
      socket.send(JSON.stringify([ref, ref, topic, event, payload]));
      return ref;
    }

    function sendAction(action, payload = {}) {
      pokerActionsSent.add(1, { action });
      return send(
        tableTopic,
        'action',
        Object.assign(
          {
            action: action,
            player_id: plan.playerId,
            player_name: plan.playerName,
          },
          payload
        )
      );
    }

    function noteState(state) {
      if (!state) return;

      latestState = state;

      const myPlayer = findPlayer(state, plan.playerId);
      if (myPlayer && !joinRecorded) {
        pokerJoinLatency.add(Date.now() - joinedAtMs);
        joinRecorded = true;
      }

      if (
        state.hand_state &&
        state.hand_state.status === 'in_progress' &&
        state.hand_state.hand_number !== lastObservedHand
      ) {
        pokerHandsObserved.add(1);
        lastObservedHand = state.hand_state.hand_number;
      }
    }

    function ensureJoin() {
      if (Date.now() - lastJoinAttemptMs < JOIN_RETRY_MS) return;
      if (findPlayer(latestState, plan.playerId) || findPendingPlayer(latestState, plan.playerId)) return;

      lastJoinAttemptMs = Date.now();
      sendAction('join_game', { seat: plan.seat });
    }

    function maybeFillBots() {
      if (
        !plan.isCaptain ||
        !latestState ||
        (latestState.hand_state && latestState.hand_state.status === 'in_progress')
      ) {
        return;
      }

      for (let seat = HUMANS_PER_TABLE + 1; seat <= MAX_SEATS; seat += 1) {
        const seatState = latestState.players.find((player) => player.seat === seat);
        if (isEmptySeat(seatState)) {
          sendAction('add_bot', { seat });
          return;
        }
      }
    }

    function maybeStartNextHand() {
      if (
        !plan.isCaptain ||
        !latestState ||
        (latestState.hand_state && latestState.hand_state.status === 'in_progress')
      ) {
        return;
      }
      if (readyPlayerCount(latestState) < 2) return;
      if (activeBotCount(latestState) < MAX_SEATS - HUMANS_PER_TABLE) return;
      if (Date.now() - lastStartAttemptMs < START_RETRY_MS) return;

      const startKey = `${latestState.hand_number}:${latestState.last_event}`;
      if (scheduledStartKey === startKey) return;

      scheduledStartKey = startKey;

      socket.setTimeout(() => {
        scheduledStartKey = null;

        if (
          !latestState ||
          (latestState.hand_state && latestState.hand_state.status === 'in_progress')
        ) {
          return;
        }
        if (readyPlayerCount(latestState) < 2) return;

        lastStartAttemptMs = Date.now();
        sendAction('next_hand');
      }, START_DELAY_MS);
    }

    function maybeAct() {
      if (
        !latestState ||
        !latestState.hand_state ||
        latestState.hand_state.status !== 'in_progress'
      ) {
        return;
      }

      const myPlayer = findPlayer(latestState, plan.playerId);
      if (!myPlayer || myPlayer.status !== 'ACTIVE') return;
      if (latestState.hand_state.acting_seat !== myPlayer.seat) return;

      const decisionKey = currentDecisionKey(latestState, myPlayer.seat);
      if (lastDecision === decisionKey) return;
      lastDecision = decisionKey;

      socket.setTimeout(() => {
        if (
          !latestState ||
          !latestState.hand_state ||
          latestState.hand_state.status !== 'in_progress'
        ) {
          return;
        }

        const currentPlayer = findPlayer(latestState, plan.playerId);
        if (!currentPlayer || currentPlayer.status !== 'ACTIVE') return;
        if (latestState.hand_state.acting_seat !== currentPlayer.seat) return;

        const decision = chooseAction(latestState, currentPlayer);
        sendAction(decision.action, decision.payload);
      }, randomBetween(ACTION_DELAY_MIN_MS, ACTION_DELAY_MAX_MS));
    }

    socket.on('open', function () {
      send(tableTopic, 'phx_join', {
        player_id: plan.playerId,
        player_name: plan.playerName,
      });
    });

    socket.on('message', function (rawMessage) {
      const [, , topic, event, payload] = JSON.parse(rawMessage);

      if (event === 'phx_reply') {
        const ok = payload && payload.status === 'ok';
        pokerActionErrors.add(!ok);

        if (topic === tableTopic && ok && payload.response && payload.response.state) {
          noteState(payload.response.state);
        }
      }

      if (topic === tableTopic && event === 'table_event' && payload && payload.state) {
        noteState(payload.state);
      }

      ensureJoin();
      maybeFillBots();
      maybeStartNextHand();
      maybeAct();
    });

    socket.on('error', function () {
      pokerActionErrors.add(1);
    });

    socket.setInterval(function () {
      send('phoenix', 'heartbeat', {});
      ensureJoin();
      maybeFillBots();
      maybeStartNextHand();
    }, HEARTBEAT_MS);

    socket.setTimeout(function () {
      socket.close();
    }, SESSION_SECONDS * 1000);
  });

  const connected = check(response, {
    'poker websocket upgraded': (res) => !!res && res.status === 101,
  });

  pokerSessionsConnected.add(connected);
}
