defmodule Cascade.Realtime do
  @moduledoc "Public interface to the native Socket.IO compatibility edge."

  alias Cascade.Realtime.{Hub, Session}

  def start_session(opts \\ []) do
    max_sessions = Keyword.get(opts, :max_sessions, configured(:max_sessions, 20_000))
    sid = Keyword.get_lazy(opts, :sid, &new_sid/0)

    with :ok <- Hub.admit(sid, max_sessions) do
      child = {Session, Keyword.put(opts, :sid, sid)}

      case DynamicSupervisor.start_child(Cascade.Realtime.SessionSupervisor, child) do
        {:ok, pid} ->
          {:ok, sid, pid}

        {:error, {:already_started, pid}} ->
          {:ok, sid, pid}

        error ->
          Hub.release(sid)
          error
      end
    end
  end

  def lookup(sid) do
    case Registry.lookup(Cascade.Realtime.Registry, sid) do
      [{pid, _}] -> {:ok, pid}
      [] -> :error
    end
  end

  def emit(sid, namespace, event, args \\ []), do: Session.emit(sid, namespace, event, args)

  def emit_with_ack(sid, namespace, event, args, timeout \\ 15_000),
    do: Session.emit_with_ack(sid, namespace, event, args, timeout)

  def broadcast(room, namespace, event, args \\ [], except_sid \\ nil),
    do: Hub.broadcast(room, namespace, event, args, except_sid)

  defp new_sid, do: 18 |> :crypto.strong_rand_bytes() |> Base.url_encode64(padding: false)

  defp configured(key, default),
    do: Application.get_env(:cascade_elixir, __MODULE__, [])[key] || default
end
