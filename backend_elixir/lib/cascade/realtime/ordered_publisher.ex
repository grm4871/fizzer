defmodule Cascade.Realtime.OrderedPublisher do
  @moduledoc """
  Single-sender boundary for ordered realtime events whose sequence is assigned
  by a serialized database mutation.

  Mutations and their synchronous fanout execute in this process. It is the
  sole sender into Session mailboxes, so mutation order is also delivery order
  even when requests originate in different Bandit or runner processes.
  """

  use GenServer

  alias Cascade.Chat.Events

  @mutation_key {__MODULE__, :mutation}

  def start_link(options \\ []) do
    case Keyword.get(options, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, :ok)
      name -> GenServer.start_link(__MODULE__, :ok, name: name)
    end
  end

  def mutate(fun, server \\ __MODULE__) when is_function(fun, 0) do
    if Process.get({@mutation_key, server}) do
      fun.()
    else
      case GenServer.call(server, {:mutate, fun}, :infinity) do
        {:ok, value} -> value
        {:raise, kind, reason, stacktrace} -> :erlang.raise(kind, reason, stacktrace)
      end
    end
  end

  def chat(events, intent, server \\ __MODULE__) when is_map(intent) do
    if Process.get({@mutation_key, server}),
      do: Events.emit(events, intent) || :ok,
      else: GenServer.call(server, {:chat, events, intent}, :infinity)
  end

  def run(event, server \\ __MODULE__) when is_map(event) do
    if Process.get({@mutation_key, server}),
      do: publish_run(event),
      else: GenServer.call(server, {:run, event}, :infinity)
  end

  @impl true
  def init(:ok), do: {:ok, nil}

  @impl true
  def handle_call({:mutate, fun}, _from, state) do
    keys = [{@mutation_key, __MODULE__}, {@mutation_key, self()}]
    Enum.each(keys, &Process.put(&1, true))

    result =
      try do
        {:ok, fun.()}
      catch
        kind, reason -> {:raise, kind, reason, __STACKTRACE__}
      after
        Enum.each(keys, &Process.delete/1)
      end

    {:reply, result, state}
  end

  def handle_call({:chat, events, intent}, _from, state) do
    {:reply, Events.emit(events, intent) || :ok, state}
  end

  def handle_call({:run, event}, _from, state) do
    {:reply, publish_run(event), state}
  end

  defp publish_run(event) do
    if Process.whereis(Cascade.Realtime.Hub) do
      Cascade.Realtime.broadcast("run:#{event.run_id}", "/runs", "event", [event])
    end

    :ok
  end
end
