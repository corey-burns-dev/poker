defmodule PokerBackendWeb.TableController do
  use PokerBackendWeb, :controller

  @max_table_id_length 64
  @table_id_pattern ~r/^[a-zA-Z0-9_\-]+$/

  plug PokerBackendWeb.Plugs.TableActionRateLimit when action in [:update_action]

  def show(conn, %{"table_id" => table_id}) do
    if valid_table_id?(table_id) do
      {:ok, _pid} = PokerBackend.Table.ensure_started(table_id)
      json(conn, PokerBackend.Table.state(table_id))
    else
      conn |> put_status(400) |> json(%{error: "invalid_table_id"})
    end
  end

  def update_action(conn, %{"table_id" => table_id, "action" => action} = params) do
    if valid_table_id?(table_id) do
      {:ok, _pid} = PokerBackend.Table.ensure_started(table_id)

      case PokerBackend.Table.action(table_id, action, params) do
        {:ok, state} -> json(conn, state)
        {:error, reason} -> conn |> put_status(422) |> json(%{error: reason})
      end
    else
      conn |> put_status(400) |> json(%{error: "invalid_table_id"})
    end
  end

  defp valid_table_id?(table_id) do
    byte_size(table_id) > 0 and
      byte_size(table_id) <= @max_table_id_length and
      Regex.match?(@table_id_pattern, table_id)
  end
end
