defmodule Cascade.Realtime.VerifiedTokenCache do
  @moduledoc """
  Bounded cache for immutable JWT verification results.

  A cached entry skips repeated HMAC work during reconnect storms, but realtime
  authentication still reads the current user row and compares username and
  auth version on every new Engine.IO session.
  """

  use GenServer

  alias Cascade.Auth.Token

  @table __MODULE__
  @cleanup_interval_ms 60_000
  @default_max_entries 50_000

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def verify(token) when is_binary(token) and token != "" do
    now = System.system_time(:second)

    case safe_lookup(digest(token)) do
      [{_digest, expires_at, claims}] when expires_at > now ->
        emit(:verified_token_cache_hit)
        {:ok, claims, expires_at}

      _ ->
        emit(:verified_token_cache_miss)

        case Token.verify_with_expiration(token) do
          {:ok, claims, expires_at} = result ->
            put(digest(token), claims, expires_at)
            result

          error ->
            error
        end
    end
  end

  def verify(_token), do: {:error, :invalid_or_expired}

  @impl true
  def init(opts) do
    :ets.new(@table, [
      :named_table,
      :protected,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    schedule_cleanup()
    {:ok, %{max_entries: Keyword.get(opts, :max_entries, @default_max_entries)}}
  end

  @impl true
  def handle_cast({:put, digest, claims, expires_at}, state) do
    now = System.system_time(:second)

    if expires_at > now do
      if :ets.info(@table, :size) >= state.max_entries, do: delete_expired(now)

      if :ets.info(@table, :size) < state.max_entries,
        do: :ets.insert(@table, {digest, expires_at, claims})
    end

    {:noreply, state}
  end

  @impl true
  def handle_info(:cleanup, state) do
    delete_expired(System.system_time(:second))
    schedule_cleanup()
    {:noreply, state}
  end

  defp put(digest, claims, expires_at) do
    if Process.whereis(__MODULE__),
      do: GenServer.cast(__MODULE__, {:put, digest, claims, expires_at})
  end

  defp safe_lookup(digest) do
    :ets.lookup(@table, digest)
  rescue
    ArgumentError -> []
  end

  defp delete_expired(now) do
    :ets.select_delete(@table, [{{:_, :"$1", :_}, [{:"=<", :"$1", now}], [true]}])
  end

  defp schedule_cleanup, do: Process.send_after(self(), :cleanup, @cleanup_interval_ms)
  defp digest(token), do: :crypto.hash(:sha256, token)

  defp emit(outcome) do
    :telemetry.execute([:cascade, :realtime, :auth], %{count: 1}, %{outcome: outcome})
  end
end
