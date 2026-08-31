defmodule CascadeWeb.MissionRouterTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Messages, Schema}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.Scheduler
  alias Cascade.Missions.Schema, as: MissionSchema
  alias Cascade.Runs.Schema, as: RunSchema

  setup do
    suffix = System.unique_integer([:positive])
    user_id = suffix + 800_000
    username = "mission_http_#{suffix}"

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [user_id, username, "x", username]
    )

    vault = ContentStore.create_vault(user_id, %{name: "Mission HTTP #{suffix}"})

    channel =
      ContentStore.create_note(vault.id, user_id, %{
        title: "Mission HTTP room",
        content: "cascade://chat-channel"
      })

    Schema.ensure!()
    RunSchema.ensure!()
    MissionSchema.ensure!()

    {:ok, coordinator_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol-http-#{suffix}",
        model: "gpt-5.6-sol"
      })

    {:ok, coordinator} =
      Agents.add_to_channel(user_id, vault.id, channel.id, coordinator_identity.id, %{
        orchestrator: true
      })

    {:ok, worker_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Terra",
        mention: "terra-http-#{suffix}",
        model: "gpt-5.6-terra"
      })

    {:ok, worker} = Agents.add_to_channel(user_id, vault.id, channel.id, worker_identity.id)
    user = %{id: user_id, username: username, auth_version: 0}

    {:ok, root} =
      Messages.create(user, vault.id, channel.id, %{
        id: "mission-http-root-#{suffix}",
        body: "Exercise every mission route.",
        createdAt: "2026-08-10T13:00:00.000Z"
      })

    %{
      user: user,
      vault: vault,
      channel: channel,
      root: root,
      coordinator: coordinator,
      worker: worker,
      token: Token.sign_user(user)
    }
  end

  test "route catalog exposes the complete Node contract" do
    assert CascadeWeb.MissionRoutes.catalog() == [
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/agent-dispatches/pending"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/history"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/tasks"},
             {"PATCH", "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/finish"}
           ]
  end

  test "create, list, get, delegate, pending dispatch, update, history, and finish preserve response shapes",
       ctx do
    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}"

    created =
      request(ctx, :post, base <> "/missions", %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "HTTP mission",
        objective: "Port the complete contract."
      })

    assert created.status == 201
    %{"mission" => mission} = json(created)
    assert mission["status"] == "active"
    assert mission["tasks"] == []

    listed = request(ctx, :get, base <> "/missions")
    assert listed.status == 200
    assert [listed_mission] = json(listed)["missions"]
    assert listed_mission["id"] == mission["id"]

    fetched = request(ctx, :get, base <> "/missions/current?coordinator=#{ctx.coordinator.id}")
    assert fetched.status == 200
    assert json(fetched)["mission"]["id"] == mission["id"]

    delegated =
      request(ctx, :post, base <> "/missions/#{mission["id"]}/tasks", %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Implement HTTP parity",
        assignee: ctx.worker.id,
        prompt: "Implement and report evidence.",
        reasoningEffort: "high"
      })

    assert delegated.status == 201
    delegated_body = json(delegated)
    assert delegated_body["scheduled"] == true
    assert delegated_body["message"]["missionTaskId"] == delegated_body["task"]["id"]

    pending = request(ctx, :get, base <> "/agent-dispatches/pending")
    assert pending.status == 200
    assert [dispatch] = json(pending)["dispatches"]
    assert dispatch["messageId"] == delegated_body["message"]["id"]
    assert dispatch["reasoningEffort"] == "high"

    assert Scheduler.reannounce_pending(events: fn event -> send(self(), {:event, event}) end) ==
             1

    assert_receive {:event, %{event: "vault:chatMessageUpdated", dispatches: [replayed]}}
    assert replayed.id == dispatch["id"]

    completed =
      request(
        ctx,
        :patch,
        base <> "/missions/tasks/#{delegated_body["task"]["id"]}",
        %{status: "completed", summary: "Evidence recorded."}
      )

    assert completed.status == 200
    assert json(completed)["mission"]["status"] == "reviewing"

    history = request(ctx, :get, base <> "/missions/#{mission["id"]}/history")
    assert history.status == 200
    kinds = Enum.map(json(history)["events"], & &1["kind"])

    assert kinds ==
             ~w(mission_created task_added task_dispatched task_status_changed mission_status_changed)

    finished =
      request(ctx, :post, base <> "/missions/#{mission["id"]}/finish", %{
        coordinatorRegistrationId: ctx.coordinator.id,
        status: "completed",
        summary: "Integrated and verified."
      })

    assert finished.status == 200
    assert json(finished)["mission"]["status"] == "completed"
    assert json(finished)["mission"]["summary"] == "Integrated and verified."
  end

  test "authentication, channel privacy, and mutation errors fail closed", ctx do
    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}"

    unauthorized =
      conn(:get, base <> "/missions")
      |> CascadeWeb.MissionRouter.call(CascadeWeb.MissionRouter.init([]))

    assert unauthorized.status == 401
    assert json(unauthorized) == %{"error" => "Invalid or expired token"}

    missing_channel =
      request(ctx, :get, "/api/vaults/#{ctx.vault.id}/channels/missing/missions")

    assert missing_channel.status == 404
    assert json(missing_channel) == %{"error" => "Chat channel not found"}

    invalid =
      request(ctx, :post, base <> "/missions", %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: ""
      })

    assert invalid.status == 400
    assert json(invalid) == %{"error" => "Mission title is required"}
  end

  defp request(ctx, method, path, body \\ nil) do
    payload = if is_nil(body), do: nil, else: Jason.encode!(body)

    conn(method, path, payload)
    |> put_req_header("authorization", "Bearer #{ctx.token}")
    |> maybe_json(body)
    |> CascadeWeb.MissionRouter.call(CascadeWeb.MissionRouter.init([]))
  end

  defp maybe_json(conn, nil), do: conn
  defp maybe_json(conn, _body), do: put_req_header(conn, "content-type", "application/json")
  defp json(conn), do: Jason.decode!(conn.resp_body)
end
