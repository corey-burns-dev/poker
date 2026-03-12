import Config

truthy? = fn
  nil, default -> default
  value, _default -> String.downcase(value) in ["1", "true", "yes", "on"]
end

integer_env = fn
  name, default ->
    case System.get_env(name) do
      nil ->
        default

      value ->
        case Integer.parse(value) do
          {parsed, ""} -> parsed
          _ -> default
        end
    end
end

config :poker_backend, PokerBackendWeb.Plugs.TableActionRateLimit,
  enabled: not truthy?.(System.get_env("TABLE_ACTION_RATE_LIMIT_DISABLED"), false),
  limit: integer_env.("TABLE_ACTION_RATE_LIMIT_LIMIT", 120),
  window_seconds: integer_env.("TABLE_ACTION_RATE_LIMIT_WINDOW_SECONDS", 10)

if config_env() != :test do
  config :poker_backend, PokerBackendWeb.Endpoint,
    server: true,
    http: [ip: {0, 0, 0, 0}, port: String.to_integer(System.get_env("PORT", "4000"))]
end

if config_env() == :prod do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "environment variable SECRET_KEY_BASE is missing. Run mix phx.gen.secret"

  host = System.get_env("PHX_HOST") || "example.com"

  config :poker_backend, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :poker_backend, PokerBackendWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [ip: {0, 0, 0, 0, 0, 0, 0, 0}],
    secret_key_base: secret_key_base
end
