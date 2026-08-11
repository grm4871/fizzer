defmodule Cascade.Search.QMD.Worker do
  @moduledoc "OTP port owner for the pinned QMD model/index process."

  use GenServer

  @behaviour Cascade.Search.QMD.Adapter
  @name __MODULE__
  @default_timeout 30_000
  @default_max_queue 64

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: @name)
  end

  @impl true
  def search(options) do
    with {:ok, _pid} <- ensure_started() do
      timeout = env_int("CASCADE_QMD_TIMEOUT_MS", @default_timeout, 250, 300_000)

      try do
        GenServer.call(@name, {:search, options}, timeout + 1_000)
      catch
        :exit, {:timeout, _} -> {:error, :timeout}
        :exit, reason -> {:error, reason}
      end
    end
  end

  def clear do
    case Process.whereis(@name) do
      nil -> :ok
      _pid -> GenServer.call(@name, :clear)
    end
  end

  def stop do
    case Process.whereis(@name) do
      nil -> :ok
      pid -> GenServer.stop(pid, :normal, 5_000)
    end
  end

  def ensure_started do
    case Process.whereis(@name) do
      nil ->
        # Requests may lazily recover the worker while its supervisor is not
        # running. Do not link that shared named worker to the request process:
        # the next request must not lose it when the first caller exits.
        case GenServer.start(__MODULE__, [], name: @name) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          error -> error
        end

      pid ->
        {:ok, pid}
    end
  end

  @impl true
  def init(_options) do
    Process.flag(:trap_exit, true)
    {:ok, %{port: open_port(), sequence: 0}}
  end

  @impl true
  def handle_call(:clear, _from, state) do
    reply = request(state.port, %{id: state.sequence + 1, op: "clear"}, timeout())
    {:reply, normalize_reply(reply), %{state | sequence: state.sequence + 1}}
  end

  def handle_call({:search, options}, _from, state) do
    max_queue = env_int("CASCADE_QMD_MAX_QUEUE", @default_max_queue, 1, 1_024)
    {:message_queue_len, queued} = Process.info(self(), :message_queue_len)

    if queued > max_queue do
      {:reply, {:error, :backpressure}, state}
    else
      id = state.sequence + 1

      request = %{
        id: id,
        op: "search",
        indexKey: Keyword.fetch!(options, :index_key),
        root: Keyword.fetch!(options, :root),
        fingerprint: Keyword.fetch!(options, :fingerprint),
        query: Keyword.fetch!(options, :query),
        scope: Keyword.fetch!(options, :scope),
        limit: Keyword.fetch!(options, :limit)
      }

      reply = request(state.port, request, timeout())
      {:reply, normalize_reply(reply), %{state | sequence: id}}
    end
  end

  @impl true
  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    {:noreply, %{state | port: reopen_port(status)}}
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, %{port: port}) when is_port(port) do
    if Port.info(port), do: Port.close(port)
    :ok
  end

  def terminate(_reason, _state), do: :ok

  defp request(port, payload, timeout) do
    true = Port.command(port, Jason.encode!(payload))

    receive do
      {^port, {:data, data}} -> Jason.decode(data)
      {^port, {:exit_status, status}} -> {:error, {:worker_exit, status}}
    after
      timeout ->
        Port.close(port)
        {:error, :timeout}
    end
  rescue
    ArgumentError -> {:error, :worker_unavailable}
  end

  defp normalize_reply({:ok, %{"ok" => true, "lexical" => lexical, "vector" => vector}}),
    do: {:ok, %{lexical: lexical, vector: vector}}

  defp normalize_reply({:ok, %{"error" => error}}), do: {:error, error}
  defp normalize_reply({:error, reason}), do: {:error, reason}
  defp normalize_reply(other), do: {:error, {:invalid_worker_reply, other}}

  defp open_port do
    executable =
      System.find_executable("node") || raise "node executable is required for QMD model worker"

    script = :cascade_elixir |> :code.priv_dir() |> to_string() |> Path.join("qmd_worker.mjs")

    Port.open(
      {:spawn_executable, executable},
      [:binary, :exit_status, {:packet, 4}, args: [script], env: worker_env()]
    )
  end

  defp reopen_port(_status) do
    Process.send_after(self(), :noop, 25)
    open_port()
  rescue
    _ -> nil
  end

  defp worker_env do
    node_root = System.get_env("CASCADE_NODE_ROOT") || Path.expand("../../../../../", __DIR__)

    [
      {~c"CASCADE_QMD_SEMANTIC",
       String.to_charlist(System.get_env("CASCADE_QMD_SEMANTIC") || "true")},
      {~c"CASCADE_NODE_ROOT", String.to_charlist(node_root)}
    ]
  end

  defp timeout, do: env_int("CASCADE_QMD_TIMEOUT_MS", @default_timeout, 250, 300_000)

  defp env_int(name, default, low, high) do
    value =
      case Integer.parse(System.get_env(name) || "") do
        {number, _} -> number
        :error -> default
      end

    value |> max(low) |> min(high)
  end
end
