# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :poker_backend, :scopes,
  user: [
    default: true,
    module: PokerBackend.Accounts.Scope,
    assign_key: :current_scope,
    access_path: [:user, :id],
    schema_key: :user_id,
    schema_type: :id,
    schema_table: :users,
    test_data_fixture: PokerBackend.AccountsFixtures,
    test_setup_helper: :register_and_log_in_user
  ]

config :poker_backend,
  ecto_repos: [PokerBackend.Repo],
  generators: [timestamp_type: :utc_datetime]

config :poker_backend, PokerBackend.Mailer, adapter: Swoosh.Adapters.Local

config :swoosh, :api_client, false

# Configure the endpoint
config :poker_backend, PokerBackendWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [html: PokerBackendWeb.ErrorHTML, json: PokerBackendWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: PokerBackend.PubSub,
  live_view: [signing_salt: "hu7LL5ZA"]

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

config :poker_backend, PokerBackendWeb.Plugs.TableActionRateLimit,
  limit: 120,
  window_seconds: 10

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
