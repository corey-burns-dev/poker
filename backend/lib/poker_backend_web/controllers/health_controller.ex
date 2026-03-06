defmodule PokerBackendWeb.HealthController do
  use PokerBackendWeb, :controller

  def show(conn, _params) do
    json(conn, %{
      status: "ok",
      service: "poker_backend",
      framework: "phoenix",
      websocket_path: "/socket/websocket"
    })
  end
end
