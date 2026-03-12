defmodule PokerBackendWeb.Router do
  use PokerBackendWeb, :router

  import PokerBackendWeb.UserAuth

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {PokerBackendWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :fetch_current_scope_for_user
  end

  pipeline :api do
    plug :accepts, ["json"]
    plug PokerBackendWeb.Plugs.CORS
  end

  pipeline :api_session do
    plug :accepts, ["json"]
    plug :fetch_session
    plug PokerBackendWeb.Plugs.CORS
    plug :fetch_current_scope_for_user
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

  scope "/api", PokerBackendWeb do
    pipe_through :api_session

    post "/users/register", UserRegistrationJSONController, :create
    post "/users/log-in", UserSessionJSONController, :create
    delete "/users/log-out", UserSessionJSONController, :delete
    get "/users/me", UserSessionJSONController, :show
  end

  ## Authentication routes

  scope "/", PokerBackendWeb do
    pipe_through [:browser, :redirect_if_user_is_authenticated]

    get "/users/register", UserRegistrationController, :new
    post "/users/register", UserRegistrationController, :create
  end

  scope "/", PokerBackendWeb do
    pipe_through [:browser, :require_authenticated_user]

    get "/users/settings", UserSettingsController, :edit
    put "/users/settings", UserSettingsController, :update
    get "/users/settings/confirm-email/:token", UserSettingsController, :confirm_email
  end

  scope "/", PokerBackendWeb do
    pipe_through [:browser]

    get "/users/log-in", UserSessionController, :new
    get "/users/log-in/:token", UserSessionController, :confirm
    post "/users/log-in", UserSessionController, :create
    delete "/users/log-out", UserSessionController, :delete
  end
end
