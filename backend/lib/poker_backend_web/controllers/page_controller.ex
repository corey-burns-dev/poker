defmodule PokerBackendWeb.PageController do
  use PokerBackendWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
