defmodule Cascade.Realtime.IntegrationDomain do
  @behaviour Cascade.Realtime.Domain

  @impl true
  def authorize_namespace(namespace, identity, metadata),
    do: {:ok, %{namespace: namespace, identity: identity, metadata: metadata}}

  @impl true
  def handle_event("/vault", "joinVault", [vault_id], _identity, _context),
    do: {:ok, [{:join, "vault:#{vault_id}"}]}

  def handle_event("/vault", "joinChatChannel", [channel_id], _identity, _context),
    do: {:ok, [{:join, "chat:#{channel_id}"}]}

  def handle_event("/vault", "probe:ack", args, _identity, _context),
    do: {:ok, [{:ack, %{success: true, args: args}}]}

  def handle_event("/runners", "runner:register", [metadata], _identity, _context),
    do: {:ok, [{:register_runner, metadata}, {:emit, "runner:registered", [%{success: true}]}]}

  def handle_event(_namespace, _event, _args, _identity, _context), do: {:ok, []}

  @impl true
  def namespace_disconnected(_namespace, _identity, _context, _reason), do: :ok
end

defmodule Cascade.Realtime.IntegrationRouter do
  use Plug.Router

  plug :match
  plug :dispatch

  match "/socket.io/*_path" do
    CascadeWeb.SocketIOPlug.call(
      conn,
      CascadeWeb.SocketIOPlug.init(domain: Cascade.Realtime.IntegrationDomain)
    )
  end

  match _ do
    Plug.Conn.send_resp(conn, 404, "not found")
  end
end

defmodule Cascade.Realtime.SocketIOIntegrationTest do
  use ExUnit.Case, async: false

  alias Cascade.Auth.{Password, Token}
  alias Cascade.DB.Repo
  alias Cascade.Realtime.{Hub, Session}
  alias Ecto.Adapters.SQL

  @probe Path.expand("../../../../loadtest_elixir/protocol-probe.mjs", __DIR__)
  @client_probe Path.expand("../../support/socket_io_client_probe.mjs", __DIR__)
  @upgrade_concurrency_probe Path.expand(
                               "../../support/socket_io_upgrade_concurrency_probe.mjs",
                               __DIR__
                             )

  setup_all do
    case Process.whereis(Cascade.Realtime.Supervisor) do
      nil -> start_supervised!({Cascade.Realtime.Supervisor, []})
      _pid -> :ok
    end

    port = available_port()

    start_supervised!(
      {Bandit,
       plug: Cascade.Realtime.IntegrationRouter,
       scheme: :http,
       ip: {127, 0, 0, 1},
       port: port,
       thousand_island_options: [num_acceptors: 4, num_connections: 500]}
    )

    {:ok, target: "http://127.0.0.1:#{port}"}
  end

  setup do
    {:ok, hash} = Password.hash("realtime-integration-password")

    SQL.query!(
      Repo,
      """
      INSERT INTO users (username,password_hash,display_name,avatar_url,auth_version)
      VALUES (?,?,?,?,0)
      ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,
        display_name=excluded.display_name,avatar_url=excluded.avatar_url,auth_version=0
      """,
      ["integration-sol", hash, "Integration Sol", ""]
    )

    [[id, auth_version]] =
      SQL.query!(Repo, "SELECT id, auth_version FROM users WHERE username = ?", [
        "integration-sol"
      ]).rows

    token = Token.sign_user(%{id: id, username: "integration-sol", auth_version: auth_version})

    on_exit(fn ->
      Hub.disconnect_user(id, ["/vault", "/runs", "/runners"])
      SQL.query!(Repo, "DELETE FROM users WHERE id = ?", [id])
    end)

    {:ok, token: token, user_id: id}
  end

  @tag timeout: 60_000
  test "raw Engine.IO polling and polling-to-WebSocket upgrade match the Node wire contract", %{
    target: target,
    token: token
  } do
    {output, status} =
      System.cmd(
        "node",
        [
          @probe,
          "--target",
          target,
          "--token",
          token,
          "--cookie",
          "cascade_session=#{token}",
          "--vault-id",
          "integration-vault",
          "--channel-id",
          "integration-channel"
        ],
        stderr_to_stdout: true
      )

    assert status == 0, output
    result = Jason.decode!(output)
    assert result["eio3Rejection"] == %{"status" => 400, "code" => 5}
    assert result["polling"]["namespaces"] == ["/vault", "/runs", "/runners"]
    assert result["upgrade"]["transport"] == "polling-to-websocket"
    assert result["cookieAuth"]["accepted"]
  end

  for mode <- ["upgrade", "polling", "websocket"] do
    @tag timeout: 30_000
    test "socket.io-client 4.8.1 interoperates over #{mode} and handles server ACKs", %{
      target: target,
      token: token,
      user_id: user_id
    } do
      mode = unquote(mode)
      port = open_node_port([target, token, mode])
      ready = receive_json(port, 25_000)
      assert ready["ready"]
      assert ready["response"]["success"]

      expected_transport = if mode == "polling", do: "polling", else: "websocket"
      assert ready["transport"] == expected_transport
      assert {:ok, %{sid: sid}} = eventually_runner(user_id)

      ack_task =
        Task.async(fn ->
          Session.emit_with_ack(sid, "/runners", "run:cancel", [%{runId: 42}], 5_000)
        end)

      assert {:ok, [%{"source" => "node-client", "success" => true}]} =
               Task.await(ack_task, 6_000)

      Session.emit(sid, "/runners", "probe:finish", [])

      done = receive_json(port, 5_000)
      assert done["done"]
      assert_receive {^port, {:exit_status, 0}}, 5_000
    end
  end

  @tag timeout: 30_000
  test "100 concurrent multiplexed clients complete polling-to-websocket upgrade", %{
    target: target,
    token: token
  } do
    {output, status} =
      System.cmd(
        "node",
        [@upgrade_concurrency_probe, target, token, "100"],
        stderr_to_stdout: true
      )

    assert status == 0, output

    assert %{"attempts" => 100, "connected" => 100, "upgraded" => 100} =
             Jason.decode!(output)
  end

  defp open_node_port(args) do
    Port.open(
      {:spawn_executable, System.find_executable("node")},
      [:binary, :exit_status, :stderr_to_stdout, args: [@client_probe | args], line: 65_536]
    )
  end

  defp receive_json(port, timeout) do
    receive do
      {^port, {:data, {:eol, line}}} -> decode_node_line(line)
      {^port, {:data, {:noeol, line}}} -> decode_node_line(line)
      {^port, {:exit_status, status}} -> flunk("Node probe exited early with #{status}")
    after
      timeout -> flunk("Node probe did not respond within #{timeout}ms")
    end
  end

  defp decode_node_line(line) do
    case Jason.decode(line) do
      {:ok, value} -> value
      {:error, _reason} -> flunk("Node probe emitted non-JSON output: #{line}")
    end
  end

  defp eventually_runner(user_id, attempts \\ 100)
  defp eventually_runner(_user_id, 0), do: :error

  defp eventually_runner(user_id, attempts) do
    case Hub.runner(user_id) do
      {:ok, runner} ->
        {:ok, runner}

      :error ->
        Process.sleep(20)
        eventually_runner(user_id, attempts - 1)
    end
  end

  defp available_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(socket)
    :ok = :gen_tcp.close(socket)
    port
  end
end
