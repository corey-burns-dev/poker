defmodule PokerBackendWeb.TableController do
  use PokerBackendWeb, :controller

  def show(conn, %{"table_id" => table_id}) do
    {:ok, _pid} = PokerBackend.Table.ensure_started(table_id)
    json(conn, PokerBackend.Table.state(table_id))
  end

  def update_action(conn, %{"table_id" => table_id, "action" => action} = params) do
    {:ok, _pid} = PokerBackend.Table.ensure_started(table_id)
    {:ok, state} = PokerBackend.Table.action(table_id, action, params)
    json(conn, state)
  end
end
