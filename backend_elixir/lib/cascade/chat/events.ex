defmodule Cascade.Chat.Events do
  @moduledoc "Callback boundary for chat persistence to publish realtime intents without coupling to transport."

  @callback emit(map()) :: term()
  @callback online_usernames([String.t()]) :: [String.t()]

  def emit(callback, intent) when is_function(callback, 1), do: callback.(intent)

  def emit(callback, intent) when is_atom(callback) and not is_nil(callback),
    do: callback.emit(intent)

  def emit(_, _), do: :ok

  def online(callback, participants) when is_function(callback, 1), do: callback.(participants)

  def online(callback, participants) when is_atom(callback) and not is_nil(callback),
    do: callback.online_usernames(participants)

  def online(_, _), do: []
end

defmodule Cascade.Chat.Events.Noop do
  @moduledoc false
  @behaviour Cascade.Chat.Events
  @impl true
  def emit(_intent), do: :ok
  @impl true
  def online_usernames(_participants), do: []
end
