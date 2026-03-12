defmodule PokerBackendWeb.UserRegistrationJSONController do
  use PokerBackendWeb, :controller

  alias PokerBackend.Accounts

  def create(conn, %{"user" => user_params}) do
    case Accounts.register_user(user_params) do
      {:ok, user} ->
        # For simplicity, we auto-login after registration in this JSON API
        # In a real app, you might want email confirmation.
        conn
        |> PokerBackendWeb.UserAuth.log_in_user_json(user)

      {:error, %Ecto.Changeset{} = changeset} ->
        conn
        |> put_status(:unprocessable_entity)
        |> render(PokerBackendWeb.UserJSON, :error, changeset: changeset)
    end
  end
end
