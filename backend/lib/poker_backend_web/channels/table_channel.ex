defmodule PokerBackendWeb.TableChannel do
  use PokerBackendWeb, :channel

  @impl true
  def join("table:" <> table_id, params, socket) do
    {:ok, _pid} = PokerBackend.Table.ensure_started(table_id)
    Phoenix.PubSub.subscribe(PokerBackend.PubSub, PokerBackend.Table.topic(table_id))

    player_name = Map.get(params, "player_name", "guest")
    player_id = Map.get(params, "player_id", "guest")
    {:ok, _state} = PokerBackend.Table.join(table_id, player_id, player_name)

    socket =
      socket
      |> assign(:table_id, table_id)
      |> assign(:player_id, player_id)

    state = PokerBackend.Table.state(table_id)

    {:ok, %{type: "table_state", state: state}, socket}
  end

  @impl true
  def handle_in("ping", payload, socket) do
    {:ok, event} = PokerBackend.Table.ping(socket.assigns.table_id, payload)
    {:reply, {:ok, event}, socket}
  end

  @impl true
  def handle_in("action", %{"action" => action} = payload, socket) do
    {:ok, state} = PokerBackend.Table.action(socket.assigns.table_id, action, payload)
    {:reply, {:ok, %{state: state}}, socket}
  end

  def handle_in(_event, _payload, socket) do
    {:reply, {:error, %{error: "unsupported_event"}}, socket}
  end

  @impl true
  def handle_info({:table_event, payload}, socket) do
    push(socket, "table_event", payload)
    {:noreply, socket}
  end

  @impl true
  def terminate(_reason, socket) do
    _ = PokerBackend.Table.leave(socket.assigns.table_id, socket.assigns.player_id)
    :ok
  end
end
