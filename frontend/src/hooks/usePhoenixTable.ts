import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { requestJson } from "../lib/api";
import type { BackendHealth, BackendTable } from "../types/backend";

type PhoenixMessage = [string | null, string | null, string, string, unknown];
type TableActionPayload = {
  amount?: number;
  seat?: number;
  show_cards?: boolean;
};

const getBackendUrl = () => {
  const envUrl = import.meta.env.VITE_BACKEND_URL;
  if (typeof window === "undefined") return envUrl || "";
  if (envUrl && (!envUrl.includes("localhost:4000") || window.location.hostname === "localhost")) {
    return envUrl;
  }
  return window.location.origin;
};

const BACKEND_URL = getBackendUrl();

const getWebSocketBase = () => {
  const envWs = import.meta.env.VITE_BACKEND_WS_URL;
  if (typeof window === "undefined") return envWs || "ws://localhost:4000/socket";
  
  if (envWs && (!envWs.includes("localhost:4000") || window.location.hostname === "localhost")) {
    return envWs;
  }
  
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/socket`;
};

const WEBSOCKET_BASE = getWebSocketBase();

const PLAYER_ID_STORAGE_KEY = "poker.player_id";
const PROFILE_STORAGE_KEY = "poker.profile";

function getBaseUrl() {
  if (typeof window === "undefined") return "http://localhost:4000";
  return window.location.origin;
}

function loadPlayerIdentity() {
  if (typeof window === "undefined") {
    return { playerId: "server-render", playerName: "Player" };
  }

  let playerId = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);
  if (!playerId) {
    playerId = `player-${crypto.randomUUID()}`;
    window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, playerId);
  }

  let playerName = `Player ${playerId.slice(-4).toUpperCase()}`;
  const profileRaw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
  if (profileRaw) {
    try {
      const parsed = JSON.parse(profileRaw) as { displayName?: string };
      if (parsed.displayName?.trim()) {
        playerName = parsed.displayName.trim();
      }
    } catch {
      // Ignore malformed profile payload and keep generated player name.
    }
  }

  return {
    playerId,
    playerName,
  };
}

type UsePhoenixTableResult = {
  playerId: string;
  playerName: string;
  backendHealth: BackendHealth | null;
  backendTable: BackendTable | null;
  backendState: string;
  sendAction: (action: string, payload?: TableActionPayload) => Promise<void>;
};

export function usePhoenixTable(tableId = "default"): UsePhoenixTableResult {
  const { user } = useAuth();
  const { playerId: guestPlayerId, playerName: guestPlayerName } = loadPlayerIdentity();

  const playerId = user ? String(user.id) : guestPlayerId;
  const playerName = user ? user.username : guestPlayerName;

  const [backendHealth, setBackendHealth] = useState<BackendHealth | null>(null);
  const [backendTable, setBackendTable] = useState<BackendTable | null>(null);
  const [backendState, setBackendState] = useState("Connecting backend...");

  const sendAction = useCallback(
    async (action: string, payload?: TableActionPayload) => {
      const baseUrl = BACKEND_URL || getBaseUrl();
      const actionUrl = new URL(`${baseUrl}/api/tables/${tableId}/actions`);
      actionUrl.searchParams.set("action", action);

      await requestJson<BackendTable>(
        actionUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            action,
            amount: payload?.amount,
            seat: payload?.seat,
            show_cards: payload?.show_cards,
            player_id: playerId,
            player_name: playerName,
          }),
        },
        `Backend action failed: ${action}`,
      );

      setBackendState("Phoenix action synced");
    },
    [playerId, playerName, tableId],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    let disposed = false;
    let messageRef = 1;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_DELAY = 30_000;

    const loadBackendState = async () => {
      try {
        const [health, table] = await Promise.all([
          requestJson<BackendHealth>(
            `${BACKEND_URL}/api/health`,
            { credentials: "include" },
            "Backend health unavailable",
          ),
          requestJson<BackendTable>(
            `${BACKEND_URL}/api/tables/${tableId}`,
            {
              credentials: "include",
            },
            "Backend table unavailable",
          ),
        ]);

        if (disposed) return;
        setBackendHealth(health);
        setBackendTable(table);
        setBackendState("Phoenix API connected");
      } catch (_error) {
        if (!disposed) {
          setBackendState("Backend API unavailable");
        }
      }
    };

    void loadBackendState();

    const send = (topic: string, event: string, payload: unknown) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const ref = String(messageRef);
      messageRef += 1;
      const message: PhoenixMessage = [ref, ref, topic, event, payload];
      socket.send(JSON.stringify(message));
    };

    const cleanup = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        socket = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
      reconnectAttempts += 1;
      setBackendState(`Reconnecting in ${Math.round(delay / 1000)}s...`);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) connect();
      }, delay);
    };

    const connect = () => {
      cleanup();
      if (disposed) return;

      const websocketUrl = `${WEBSOCKET_BASE}/websocket?vsn=2.0.0`;
      socket = new WebSocket(websocketUrl);

      socket.addEventListener("open", () => {
        if (disposed) {
          socket?.close();
          return;
        }
        reconnectAttempts = 0;
        send(`table:${tableId}`, "phx_join", {
          player_id: playerId,
          player_name: playerName,
        });
        heartbeatTimer = setInterval(() => {
          send("phoenix", "heartbeat", {});
        }, 30_000);
      });

      socket.addEventListener("message", (rawMessage) => {
        if (disposed) return;
        const [, , topic, event, payload] = JSON.parse(rawMessage.data as string) as PhoenixMessage;

        if (topic === `table:${tableId}` && event === "phx_reply") {
          const replyPayload = payload as {
            response?: { state?: BackendTable };
            status?: string;
          };
          if (replyPayload.status === "ok") {
            if (replyPayload.response?.state) {
              setBackendTable(replyPayload.response.state);
            }
            setBackendState("Phoenix channel connected");
          } else {
            setBackendState("Phoenix channel join failed");
          }
        }

        if (topic === `table:${tableId}` && event === "table_event") {
          const tablePayload = payload as {
            state?: BackendTable;
            type: string;
          };
          if (tablePayload.state) {
            setBackendTable(tablePayload.state);
          }
          if (tablePayload.type === "pong") {
            setBackendState("Phoenix channel connected");
          }
        }
      });

      socket.addEventListener("error", () => {
        if (!disposed) {
          setBackendState("Phoenix socket disconnected");
        }
      });

      socket.addEventListener("close", () => {
        if (!disposed) {
          scheduleReconnect();
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      cleanup();
    };
  }, [playerId, playerName, tableId]);

  return {
    playerId,
    playerName,
    backendHealth,
    backendTable,
    backendState,
    sendAction,
  };
}
