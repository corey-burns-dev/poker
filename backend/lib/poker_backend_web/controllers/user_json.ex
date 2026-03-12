defmodule PokerBackendWeb.UserJSON do
  def data(user) do
    %{
      id: user.id,
      email: user.email,
      username: user.username,
      balance: user.balance
    }
  end

  def show(%{user: user}) do
    %{data: data(user)}
  end

  def error(%{changeset: changeset}) do
    # A helper that transforms changeset errors into a map of messages.
    # For example: %{email: ["can't be blank", "is invalid"]}
    errors = Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)

    %{errors: errors}
  end
end
