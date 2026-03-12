defmodule PokerBackend.Repo do
  use Ecto.Repo,
    otp_app: :poker_backend,
    adapter: Ecto.Adapters.Postgres
end
