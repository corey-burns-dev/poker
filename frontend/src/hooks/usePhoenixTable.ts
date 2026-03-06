import { useCallback, useEffect, useState } from "react";
import type { BackendHealth, BackendTable } from "../types/backend";

type PhoenixMessage = [string | null, string | null, string, string, unknown];
type TableActionPayload = {
	amount?: number;
	seat?: number;
	show_cards?: boolean;
};

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";
const WEBSOCKET_BASE =
	import.meta.env.VITE_BACKEND_WS_URL || "ws://localhost:4000/socket";
const PLAYER_ID_STORAGE_KEY = "poker.player_id";

function loadPlayerIdentity() {
	if (typeof window === "undefined") {
		return { playerId: "server-render", playerName: "Player" };
	}

	let playerId = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);
	if (!playerId) {
		playerId = `player-${crypto.randomUUID()}`;
		window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, playerId);
	}

	return {
		playerId,
		playerName: `Player ${playerId.slice(-4).toUpperCase()}`,
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
	const { playerId, playerName } = loadPlayerIdentity();
	const [backendHealth, setBackendHealth] = useState<BackendHealth | null>(
		null,
	);
	const [backendTable, setBackendTable] = useState<BackendTable | null>(null);
	const [backendState, setBackendState] = useState("Connecting backend...");

	const sendAction = useCallback(
		async (action: string, payload?: TableActionPayload) => {
			const actionUrl = new URL(`${BACKEND_URL}/api/tables/${tableId}/actions`);
			actionUrl.searchParams.set("action", action);

			const response = await fetch(actionUrl.toString(), {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					action,
					amount: payload?.amount,
					seat: payload?.seat,
					player_id: playerId,
					player_name: playerName,
				}),
			});

			if (!response.ok) {
				throw new Error(`Backend action failed: ${action}`);
			}

			const table = (await response.json()) as BackendTable;
			setBackendTable(table);
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
		let connectTimer: ReturnType<typeof setTimeout> | null = null;

		const loadBackendState = async () => {
			try {
				const [healthResponse, tableResponse] = await Promise.all([
					fetch(`${BACKEND_URL}/api/health`),
					fetch(`${BACKEND_URL}/api/tables/${tableId}`),
				]);

				if (!healthResponse.ok || !tableResponse.ok) {
					throw new Error("Backend HTTP request failed");
				}

				const [health, table] = (await Promise.all([
					healthResponse.json(),
					tableResponse.json(),
				])) as [BackendHealth, BackendTable];

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

		connectTimer = window.setTimeout(() => {
			if (disposed) return;

			const websocketUrl = `${WEBSOCKET_BASE}/websocket?vsn=2.0.0`;
			socket = new WebSocket(websocketUrl);

			socket.addEventListener("open", () => {
				if (disposed) {
					socket?.close();
					return;
				}
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
				const [, , topic, event, payload] = JSON.parse(
					rawMessage.data as string,
				) as PhoenixMessage;

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
						send(`table:${tableId}`, "ping", { source: "frontend" });
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
		}, 0);

		return () => {
			disposed = true;
			if (connectTimer) {
				clearTimeout(connectTimer);
			}
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
			}
			if (socket?.readyState === WebSocket.OPEN) {
				socket.close();
			}
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
