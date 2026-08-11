defmodule Cascade.Realtime.AuthBatcher do
  @moduledoc """
  Coalesces concurrent realtime user lookups into current-row SQLite reads.

  Every caller still validates the current username and auth version. Only the
  database round trips are batched, which keeps reconnect bursts from filling
  the checkout queue without weakening session revocation.
  """

  use GenServer

  alias Cascade.Auth.Accounts

  @default_batch_window_ms 10

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def fetch_by_id(user_id, timeout \\ 5_000)

  def fetch_by_id(user_id, timeout) when is_integer(user_id) do
    GenServer.call(__MODULE__, {:fetch, user_id}, timeout)
  catch
    :exit, _ -> :error
  end

  def fetch_by_id(_user_id, _timeout), do: :error

  @impl true
  def init(opts) do
    {:ok,
     %{
       batch_window_ms: Keyword.get(opts, :batch_window_ms, @default_batch_window_ms),
       pending: %{},
       timer: nil
     }}
  end

  @impl true
  def handle_call({:fetch, user_id}, from, state) do
    pending = Map.update(state.pending, user_id, [from], &[from | &1])
    timer = state.timer || Process.send_after(self(), :flush, state.batch_window_ms)
    {:noreply, %{state | pending: pending, timer: timer}}
  end

  @impl true
  def handle_info(:flush, state) do
    pending = state.pending

    users =
      pending
      |> Map.keys()
      |> Accounts.fetch_by_ids()

    Enum.each(pending, fn {user_id, callers} ->
      reply =
        case users[user_id] do
          nil -> :error
          user -> {:ok, user}
        end

      Enum.each(callers, &GenServer.reply(&1, reply))
    end)

    {:noreply, %{state | pending: %{}, timer: nil}}
  rescue
    _error ->
      Enum.each(state.pending, fn {_user_id, callers} ->
        Enum.each(callers, &GenServer.reply(&1, :error))
      end)

      {:noreply, %{state | pending: %{}, timer: nil}}
  end
end
