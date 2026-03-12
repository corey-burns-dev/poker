defmodule PokerBackendWeb.UserSessionHTML do
  use PokerBackendWeb, :html

  embed_templates "user_session_html/*"

  defp local_mail_adapter? do
    Application.get_env(:poker_backend, PokerBackend.Mailer)[:adapter] == Swoosh.Adapters.Local
  end
end
