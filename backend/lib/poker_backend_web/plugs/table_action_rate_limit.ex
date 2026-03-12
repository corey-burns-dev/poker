defmodule PokerBackendWeb.Plugs.TableActionRateLimit do
  @behaviour Plug

  import Plug.Conn

  @table __MODULE__.Store
  @default_limit 120
  @default_window_seconds 10

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    ensure_table!()

    config = Application.get_env(:poker_backend, __MODULE__, [])
    enabled = Keyword.get(config, :enabled, true)
    limit = Keyword.get(config, :limit, @default_limit)
    window_seconds = Keyword.get(config, :window_seconds, @default_window_seconds)

    if not enabled or limit <= 0 or window_seconds <= 0 do
      conn
    else
      current_second = System.system_time(:second)
      current_bucket = div(current_second, window_seconds)
      key = {current_bucket, client_ip(conn)}
      count = :ets.update_counter(@table, key, {2, 1}, {key, 0})

      cleanup_stale_buckets(current_bucket - 1)

      if count > limit do
        retry_after_seconds = max(window_seconds - rem(current_second, window_seconds), 1)

        conn
        |> put_resp_content_type("application/json")
        |> put_resp_header("retry-after", Integer.to_string(retry_after_seconds))
        |> send_resp(
          429,
          Jason.encode!(%{
            error: "rate_limited",
            retry_after_seconds: retry_after_seconds
          })
        )
        |> halt()
      else
        conn
      end
    end
  end

  defp client_ip(%Plug.Conn{remote_ip: nil}), do: "unknown"
  defp client_ip(%Plug.Conn{remote_ip: remote_ip}), do: remote_ip |> :inet.ntoa() |> to_string()

  defp ensure_table! do
    case :ets.whereis(@table) do
      :undefined ->
        try do
          :ets.new(@table, [
            :named_table,
            :public,
            :set,
            read_concurrency: true,
            write_concurrency: true
          ])
        rescue
          ArgumentError -> :ok
        end

      _tid ->
        :ok
    end
  end

  defp cleanup_stale_buckets(oldest_bucket_to_keep) do
    :ets.select_delete(@table, [
      {{{:"$1", :_}, :_}, [{:<, :"$1", oldest_bucket_to_keep}], [true]}
    ])
  end
end
