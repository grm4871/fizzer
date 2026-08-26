defmodule Cascade.Realtime.OutboundIntegrationRouter do
  @moduledoc "Test HTTP router mounting the Socket.IO and chat surfaces for outbound contracts."
  use Plug.Router
  plug :match
  plug :dispatch
  match "/socket.io/*_path" do
    CascadeWeb.SocketIOPlug.call(conn, CascadeWeb.SocketIOPlug.init(domain: Cascade.Realtime.DomainAdapter))
  end
  match _ do
    CascadeWeb.ChatRouter.call(conn, CascadeWeb.ChatRouter.init(events: Cascade.Chat.Events.Noop))
  end
end

defmodule Cascade.Realtime.OutboundIntegrationSupport do
  @moduledoc "Shared isolated setup and probe helpers for realtime outbound event contract families."
  import ExUnit.Assertions
  import Plug.Conn
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.Channel
  alias Cascade.Content.Store
  alias Cascade.Realtime.{Hub, PresenceDispatcher}
  @probe Path.expand("realtime_event_probe.mjs", __DIR__)

  def setup_database do
    Enum.each(1..3, &Cascade.Realtime.Events.disconnect_user/1)
    assert eventually(fn -> Enum.all?(1..3, &(Hub.room_members("user:#{&1}", "/vault") == [])) end)
    Cascade.Accounts.Schema.ensure!()
    Cascade.Runs.Schema.ensure!()
    Cascade.Chat.Schema.ensure!()
    reset_database()
    Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
    root = Path.join(System.tmp_dir!(), "cascade-elixir-realtime-#{System.unique_integer([:positive])}")
    previous_root = System.get_env("CASCADE_VAULTS_BASE_DIR")
    previous_sink = Application.get_env(:cascade_elixir, :note_mutation_sink)
    System.put_env("CASCADE_VAULTS_BASE_DIR", root)
    SQL.exec("INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES (1,'alice','x','Alice','alice.png',0),(2,'bob','x','Bob','bob.png',0),(3,'eve','x','Eve','eve.png',0)")
    ExUnit.Callbacks.on_exit(fn ->
      if previous_sink, do: Application.put_env(:cascade_elixir, :note_mutation_sink, previous_sink), else: Application.delete_env(:cascade_elixir, :note_mutation_sink)
      reset_database(); File.rm_rf!(root)
      if previous_root, do: System.put_env("CASCADE_VAULTS_BASE_DIR", previous_root), else: System.delete_env("CASCADE_VAULTS_BASE_DIR")
    end)
    :ok
  end

  def linked_chat do
    source = Store.create_vault(1, %{name: "Source"})

    source_channel =
      Store.create_note(source.id, 1, %{title: "Room", content: "cascade://chat-channel"})

    local = Store.create_vault(2, %{name: "Local"})

    local_channel =
      Store.create_note(local.id, 2, %{title: "Mirror", content: "cascade://chat-channel"})

    assert {:ok, _route} =
             Channel.link(source.id, source_channel.id, local.id, local_channel.id, 1)

    {source, source_channel, local, local_channel}
  end

  def token(id, username), do: Token.sign_user(%{id: id, username: username, auth_version: 0})

  def http_json(method, url, authorization, body \\ nil) do
    headers = [
      {~c"authorization", String.to_charlist(authorization)},
      {~c"content-type", ~c"application/json"}
    ]

    request =
      if is_nil(body) do
        {String.to_charlist(url), headers}
      else
        {String.to_charlist(url), headers, ~c"application/json",
         body |> Jason.encode!() |> String.to_charlist()}
      end

    {:ok, {{_version, status, _reason}, _response_headers, response_body}} =
      :httpc.request(method, request, [], body_format: :binary)

    {status, Jason.decode!(response_body)}
  end

  def open_probe(target, token, label) do
    port =
      Port.open(
        {:spawn_executable, System.find_executable("node")},
        [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          args: [@probe, target, token, label],
          line: 65_536
        ]
      )

    assert %{"type" => "ready"} = receive_probe(port, 10_000)
    port
  end

  def close_on_exit(ports) do
    ExUnit.Callbacks.on_exit(fn ->
      Enum.each(ports, &close_probe/1)
    end)
  end

  def close_probe(port) do
    if Port.info(port) do
      Port.command(port, Jason.encode!(%{action: "close"}) <> "\n")
      await_probe_exit(port, System.monotonic_time(:millisecond) + 2_000)
    end
  end

  def await_probe_exit(port, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {^port, {:exit_status, _status}} -> :ok
      {^port, {:data, _line}} -> await_probe_exit(port, deadline)
    after
      remaining ->
        if Port.info(port), do: Port.close(port)
        :ok
    end
  end

  def join_vault(port, vault_id, user_id) do
    command(port, "vault", "joinVault", [vault_id])
    assert eventually(fn -> joined?("vault:#{vault_id}", user_id) end)
  end

  def join_chat(port, local_channel_id, source_channel_id, user_id) do
    command(port, "vault", "joinChatChannel", [local_channel_id])
    assert eventually(fn -> joined?("chat:#{source_channel_id}", user_id) end)
  end

  def command(port, namespace, event, args) do
    id = System.unique_integer([:positive])

    Port.command(
      port,
      Jason.encode!(%{
        action: "emit",
        namespace: namespace,
        event: event,
        args: args,
        id: id
      }) <> "\n"
    )

    assert %{"type" => "command", "id" => ^id} =
             receive_matching(port, &(&1["type"] == "command" and &1["id"] == id), 5_000)
  end

  def disconnect_namespace(port, namespace) do
    id = System.unique_integer([:positive])

    Port.command(
      port,
      Jason.encode!(%{action: "disconnect", namespace: namespace, id: id}) <> "\n"
    )

    assert %{"type" => "command", "id" => ^id} =
             receive_matching(port, &(&1["type"] == "command" and &1["id"] == id), 5_000)
  end

  def await_event(port, namespace, event) do
    receive_matching(
      port,
      &(&1["type"] == "event" and &1["namespace"] == namespace and &1["event"] == event),
      5_000
    )
  end

  def await_presence(port, online) do
    receive_matching(
      port,
      fn message ->
        message["type"] == "event" and message["event"] == "vault:chatPresence" and
          get_in(message, ["args", Access.at(0), "online"]) == online
      end,
      5_000
    )
  end

  def await_disconnect(port, namespace) do
    receive_matching(
      port,
      &(&1["type"] == "disconnect" and &1["namespace"] == namespace),
      5_000
    )
  end

  def receive_matching(port, predicate, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_receive_matching(port, predicate, deadline)
  end

  def do_receive_matching(port, predicate, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    case receive_probe(port, remaining) do
      %{} = message ->
        if predicate.(message), do: message, else: do_receive_matching(port, predicate, deadline)

      nil ->
        flunk("Socket.IO probe did not emit the expected event")
    end
  end

  def receive_probe(port, timeout) do
    receive do
      {^port, {:data, {:eol, line}}} -> decode_probe(line)
      {^port, {:data, {:noeol, line}}} -> decode_probe(line)
      {^port, {:exit_status, status}} -> flunk("Socket.IO probe exited early with #{status}")
    after
      timeout -> nil
    end
  end

  def decode_probe(line) do
    case Jason.decode(line) do
      {:ok, message} -> message
      {:error, _} -> flunk("Socket.IO probe emitted non-JSON output: #{line}")
    end
  end

  def flush_probe(port) do
    receive do
      {^port, {:data, _line}} -> flush_probe(port)
    after
      50 -> :ok
    end
  end

  def joined?(room, user_id, namespace \\ "/vault") do
    Hub.room_members(room, namespace)
    |> Enum.any?(&(Hub.user_id_for_session(&1, namespace) == user_id))
  end

  def presence_dispatcher_idle? do
    stats = PresenceDispatcher.stats()
    stats.active == 0 and stats.pending == 0 and stats.queued == 0
  end

  def eventually_joined?(room, user_id), do: eventually(fn -> joined?(room, user_id) end, 20)

  def eventually(fun, attempts \\ 100)
  def eventually(_fun, 0), do: false

  def eventually(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(20)
      eventually(fun, attempts - 1)
    end
  end

  def stringify(map), do: map |> Jason.encode!() |> Jason.decode!()

  def reset_database do
    for table <-
          ~w(run_events delegated_runs runs community_note_activity community_read_state direct_message_channels user_dm_vaults user_blocks vault_join_requests vault_bans community_reports chat_note_grants chat_channel_settings vault_agent_exclusions chat_agent_members chat_channel_links chat_messages work_item_dependencies work_item_runs work_item_reviews work_items vault_agents note_versions note_links note_tags tags notes folders vault_members vaults registration_invites_used users) do
      if SQL.table_exists?(table), do: SQL.exec("DELETE FROM #{table}")
    end

    File.rm_rf!(Store.vaults_base_dir())
  end

  def available_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(socket)
    :ok = :gen_tcp.close(socket)
    port
  end

  def collect_presence_queries(queries) do
    receive do
      {:initial_presence_query, query} -> collect_presence_queries([query | queries])
    after
      50 -> Enum.reverse(queries)
    end
  end
end
