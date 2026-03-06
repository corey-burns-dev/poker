defmodule PokerBackendWeb.Router do
  use PokerBackendWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {PokerBackendWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
    plug PokerBackendWeb.Plugs.CORS
  end

  scope "/", PokerBackendWeb do
    pipe_through :browser

    get "/", PageController, :home
  end

  scope "/api", PokerBackendWeb do
    pipe_through :api

    get "/health", HealthController, :show
    get "/tables/:table_id", TableController, :show
    post "/tables/:table_id/actions", TableController, :update_action
    options "/*path", HealthController, :show
  end
end
