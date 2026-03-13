import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { getBackendUrl, requestJson } from "../lib/api";
import type { BackendHealth, BackendTable } from "../types/backend";

type SocketMessage = [string | null, string | null, string, string, unknown];
type TableActionPayload = {
  amount?: number;
  seat?: number;
  show_cards?: boolean;
};

const getWebSocketBase = () => {
  const envWs = import.meta.env.VITE_BACKEND_WS_URL;
  if (typeof window === "undefined") return envWs || "ws://localhost:4000/socket";

  if (envWs && (!envWs.includes("localhost:4000") || window.location.hostname === "localhost")) {
    return envWs;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/socket`;
};

function getBaseUrl() {
  if (typeof window === "undefined") return "http://localhost:4000";
  return window.location.origin;
}

type UsePokerTableResult = {
  playerId: string;
  playerName: string;
  backendHealth: BackendHealth | null;
  backendTable: BackendTable | null;
  backendState: string;
  sendAction: (action: string, payload?: TableActionPayload) => Promise<void>;
  loadBackendState: () => Promise<void>;
};

export function usePokerTable(tableId = "default"): UsePokerTableResult {
  const { user } = useAuth();

  // Provide fallbacks during initial load or error states
  const playerId = user ? String(user.id) : "";
  const playerName = user ? user.username : "";

  const [backendHealth, setBackendHealth] = useState<BackendHealth | null>(null);
  const [backendTable, setBackendTable] = useState<BackendTable | null>(null);
  const [backendState, setBackendState] = useState("Connecting backend...");

  const loadBackendState = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [health, table] = await Promise.all([
          requestJson<BackendHealth>(
            `${getBackendUrl()}/api/health`,
            { credentials: "include", signal },
            "Backend health unavailable",
          ),
          requestJson<BackendTable>(
            `${getBackendUrl()}/api/tables/${tableId}`,
            {
              credentials: "include",
              signal,
            },
            "Backend table unavailable",
          ),
        ]);

        if (signal?.aborted) return;
        setBackendHealth(health);
        setBackendTable(table);
        setBackendState("Backend API connected");
      } catch (error) {
        if (!signal?.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
          setBackendState("Backend API unavailable");
        }
      }
    },
    [tableId],
  );

  const sendAction = useCallback(
    async (action: string, payload?: TableActionPayload) => {
      const baseUrl = getBackendUrl() || getBaseUrl();
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
            player_name: playerName,
          }),
        },
        `Backend action failed: ${action}`,
      );

      setBackendState("WebSocket action synced");
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
    const controller = new AbortController();

    void loadBackendState(controller.signal);

    const send = (topic: string, event: string, payload: unknown) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const ref = String(messageRef);
      messageRef += 1;
      const message: SocketMessage = [ref, ref, topic, event, payload];
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

      const websocketUrl = `${getWebSocketBase()}/websocket?vsn=2.0.0`;
      socket = new WebSocket(websocketUrl);

      socket.addEventListener("open", () => {
        if (disposed) {
          socket?.close();
          return;
        }
        reconnectAttempts = 0;
        send(`table:${tableId}`, "join", {
          player_id: playerId,
          player_name: playerName,
        });
        heartbeatTimer = setInterval(() => {
          send("system", "heartbeat", {});
        }, 30_000);
      });

      socket.addEventListener("message", (rawMessage) => {
        if (disposed) return;
        const [, , topic, event, payload] = JSON.parse(rawMessage.data as string) as SocketMessage;

        if (topic === `table:${tableId}` && event === "reply") {
          const replyPayload = payload as {
            response?: { state?: BackendTable };
            status?: string;
          };
          if (replyPayload.status === "ok") {
            if (replyPayload.response?.state) {
              setBackendTable(replyPayload.response.state);
            }
            setBackendState("WebSocket channel connected");
          } else {
            setBackendState("WebSocket channel join failed");
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
            setBackendState("WebSocket channel connected");
          }
        }
      });

      socket.addEventListener("error", () => {
        if (!disposed) {
          setBackendState("WebSocket disconnected");
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
      controller.abort();
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
    loadBackendState,
  };
}
