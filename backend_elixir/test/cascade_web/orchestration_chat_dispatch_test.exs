defmodule CascadeWeb.OrchestrationChatDispatchTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.Dispatches
  alias Cascade.Realtime.{Hub, Session}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}
  alias Cascade.Runs.Store

  setup do
    suffix = System.unique_integer([:positive])
    owner = user!(900_000 + suffix, "dispatch_owner_#{suffix}")
    guest = user!(1_900_000 + suffix, "dispatch_guest_#{suffix}")
    owner_vault = ContentStore.create_vault(owner.id, %{name: "Owner #{suffix}"})
    guest_vault = ContentStore.create_vault(guest.id, %{name: "Guest #{suffix}"})

    owner_channel =
      ContentStore.create_note(owner_vault.id, owner.id, %{
        title: "Owner room",
        content: "cascade://chat-channel"
      })

    guest_channel =
      ContentStore.create_note(guest_vault.id, guest.id, %{
        title: "Guest projection",
        content: "cascade://chat-channel"
      })

    assert {:ok, _route} =
             Channel.link(
               owner_vault.id,
               owner_channel.id,
               guest_vault.id,
               guest_channel.id,
               guest.id
             )

    {:ok, identity} =
      Agents.upsert_identity(owner.id, owner_vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol-#{suffix}",
        model: "gpt-5.6-sol",
        cwd: "/owner/registration"
      })

    {:ok, registration} =
      Agents.add_to_channel(owner.id, owner_vault.id, owner_channel.id, identity.id, %{
        reasoningEffort: "high",
        priorityServiceTier: true,
        pingableByOthers: true,
        yolo: true,
        conversationId: "owner-conversation-#{suffix}"
      })

    assert {:ok, %{cwd: "/owner/channel"}} =
             Channel.update_settings(owner_channel.id, owner.id, %{cwd: "/owner/channel"})

    {:ok, source_message} =
      Messages.create(guest, guest_vault.id, guest_channel.id, %{
        id: "dispatch-source-#{suffix}",
        body: "@#{registration.mention} finish the owner-side work"
      })

    {:ok, dispatch} =
      Dispatches.create(guest.id, guest_channel.id, source_message, registration.id,
        reasoning_effort: "max"
      )

    sid = "chat-dispatch-runner-#{suffix}"

    {:ok, ^sid, session_pid} =
      Cascade.Realtime.start_session(sid: sid, domain: Cascade.Realtime.DomainAdapter)

    assert {:ok, _open_packet} = Session.poll(sid, 1_000)
    connect_runner!(sid, Token.sign_user(owner))
    assert {:ok, _connect_packet} = Session.poll(sid, 1_000)
    register_runner!(sid)
    assert {:ok, registered_packet} = Session.poll(sid, 1_000)
    assert registered_packet =~ "runner:registered"

    on_exit(fn ->
      Hub.unregister_runner(owner.id, sid)

      if Process.alive?(session_pid) do
        DynamicSupervisor.terminate_child(Cascade.Realtime.SessionSupervisor, session_pid)
      end

      SQL.exec("DELETE FROM vaults WHERE id IN (?,?)", [owner_vault.id, guest_vault.id])
      SQL.exec("DELETE FROM users WHERE id IN (?,?)", [owner.id, guest.id])
      File.rm_rf!(owner_vault.root_path)
      File.rm_rf!(guest_vault.root_path)
    end)

    %{
      owner: owner,
      guest: guest,
      owner_vault: owner_vault,
      guest_vault: guest_vault,
      owner_channel: owner_channel,
      guest_channel: guest_channel,
      registration: registration,
      dispatch: dispatch,
      sid: sid
    }
  end

  test "coordinator reviews are claimed without a chat page and repeated claims reuse the run",
       ctx do
    SQL.exec("UPDATE chat_agent_members SET orchestrator=1 WHERE id=?", [ctx.registration.id])

    {:ok, root} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        id: "review-root-#{ctx.registration.id}",
        body: "Finish the task"
      })

    {:ok, mission} =
      Cascade.Missions.Store.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: ctx.registration.id,
        title: "Review without UI"
      })

    {:ok, added} =
      Cascade.Missions.Store.add_task(ctx.owner.id, ctx.owner_channel.id, mission.mission.id, %{
        coordinatorRegistrationId: ctx.registration.id,
        assignee: ctx.registration.id,
        anonymous: true,
        title: "Worker"
      })

    {:ok, _} =
      Cascade.Missions.Store.update_task(ctx.owner.id, ctx.owner_channel.id, added.task.id, %{
        status: "failed",
        summary: "Needs review"
      })

    assert {:noreply, 60_000} =
             Cascade.Missions.DispatchReannouncer.handle_info(:reannounce, 60_000)

    [dispatch_id, run_id] =
      SQL.one("SELECT id,run_id FROM chat_agent_dispatches WHERE message_id LIKE ?", [
        "sys-mission-#{mission.mission.id}-%"
      ])

    assert is_integer(run_id)
    run = Store.get(run_id)

    assert {:ok, duplicate} =
             CascadeWeb.OrchestrationController.claim_mission_dispatch(
               ctx.owner.id,
               ctx.owner_channel.id,
               dispatch_id
             )

    assert duplicate.id == run.id
    assert Store.get(run.id).prompt =~ "Finish with --verification"

    assert SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [dispatch_id]) == [
             1
           ]

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=?", [
             mission.mission.id
           ]) == [1]
  end

  test "dispatch executes on the owner projection with authoritative settings and is idempotent",
       ctx do
    response_message_id = "agent-response-#{System.unique_integer([:positive])}"

    body = %{
      prompt: "Ship from the owner's machine",
      agent: "hermes",
      model: "attacker-model",
      cwd: "/guest/override",
      yolo: true,
      conversation_id: "shared-room-session",
      registrationId: "wrong-registration",
      chatDispatchId: ctx.dispatch.id,
      chat: %{
        channelId: ctx.guest_channel.id,
        messageId: response_message_id,
        triggeringMessageId: "client-spoofed-trigger"
      }
    }

    response = request(ctx, body)
    assert response.status == 200
    assert %{"reused" => false, "run" => run} = Jason.decode!(response.resp_body)
    assert run["vault_id"] == ctx.owner_vault.id
    assert run["agent"] == "codex"
    assert run["model"] == "gpt-5.6-sol"
    assert run["chat_dispatch_id"] == ctx.dispatch.id

    assert {:ok, packet} = Session.poll(ctx.sid, 1_000)
    assert packet =~ "run:delegate"
    assert packet =~ Jason.encode!(ctx.owner_channel.id)
    assert packet =~ Jason.encode!(ctx.dispatch.messageId)
    assert packet =~ Jason.encode!(ctx.registration.id)
    assert packet =~ Jason.encode!("/owner/channel")
    assert packet =~ Jason.encode!("gpt-5.6-sol")
    assert packet =~ Jason.encode!("max")
    assert packet =~ "\"priorityServiceTier\":true"
    assert packet =~ "\"yolo\":false"
    assert packet =~ "Shared room state"
    refute packet =~ "/guest/override"
    refute packet =~ "attacker-model"

    assert {:ok, message} = Messages.get(ctx.owner_channel.id, ctx.owner.id, response_message_id)
    assert message.author == "Sol"
    assert message.agentId == "codex"
    assert message.registrationId == ctx.registration.id
    assert message.runId == run["id"]
    assert message.status == "running"
    assert message.body == "Thinking..."

    assert Dispatches.get(ctx.guest.id, ctx.guest_channel.id, ctx.dispatch.id) ==
             {:ok, %{ctx.dispatch | runId: run["id"]}}

    repeated = request(ctx, body)
    assert repeated.status == 200
    assert %{"reused" => true, "run" => %{"id" => run_id}} = Jason.decode!(repeated.resp_body)
    assert run_id == run["id"]
    assert Store.find_by_chat_dispatch(ctx.dispatch.id).id == run["id"]

    assert [1] =
             SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [ctx.dispatch.id])

    assert {:ok, []} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [
                 %{
                   runId: run["id"],
                   type: "text",
                   payload: %{
                     chatVisible: true,
                     message: %{content: [%{type: "text", text: "Streamed answer"}]}
                   }
                 }
               ],
               %{id: ctx.owner.id},
               %{}
             )

    # A missing client-created reply shell must not eat the completed answer.
    SQL.exec("DELETE FROM chat_messages WHERE id=?", [response_message_id])

    assert {:ok, []} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [%{runId: run["id"], type: "harness", payload: %{data: "trace-output"}}],
               %{id: ctx.owner.id},
               %{}
             )

    assert {:ok, []} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [
                 %{
                   runId: run["id"],
                   type: "status",
                   payload: %{status: "completed", summary: "Production-ready answer"}
                 }
               ],
               %{id: ctx.owner.id},
               %{}
             )

    assert {:ok, completed_message} =
             Messages.get(
               ctx.owner_channel.id,
               ctx.owner.id,
               "agent-dispatch-#{ctx.dispatch.id}"
             )

    assert completed_message.body == "Production-ready answer"
    assert completed_message[:status] == nil
    assert completed_message.harnessLog == "trace-output"
    assert completed_message.blocks == [%{"text" => "Streamed answer", "type" => "text"}]
    assert Store.get(run["id"]).status == "completed"
  end

  test "a guest cannot invoke a non-pingable owner registration", ctx do
    SQL.exec("UPDATE chat_agent_members SET pingable_by_others=0 WHERE id=?", [
      ctx.registration.id
    ])

    response =
      request(ctx, %{
        prompt: "Do not run",
        chatDispatchId: ctx.dispatch.id,
        chat: %{channelId: ctx.guest_channel.id, messageId: "blocked-agent-message"}
      })

    assert response.status == 403

    assert Jason.decode!(response.resp_body) == %{
             "error" => "This agent isn't accepting pings from other users."
           }

    assert is_nil(Store.find_by_chat_dispatch(ctx.dispatch.id))
  end

  test "an existing client shell is linked without erasing its content", ctx do
    message_id = "existing-agent-shell-#{System.unique_integer([:positive])}"

    assert {:ok, _message} =
             Messages.create(
               ctx.owner,
               ctx.owner_vault.id,
               ctx.owner_channel.id,
               %{
                 id: message_id,
                 body: "Client-created shell",
                 status: "sending",
                 registrationId: ctx.registration.id
               },
               access: :agent
             )

    response =
      request(ctx, %{
        prompt: "Continue into the existing shell",
        conversation_id: "existing-shell-session",
        chatDispatchId: ctx.dispatch.id,
        chat: %{channelId: ctx.guest_channel.id, messageId: message_id}
      })

    assert response.status == 200
    run_id = Jason.decode!(response.resp_body)["run"]["id"]
    assert {:ok, message} = Messages.get(ctx.owner_channel.id, ctx.owner.id, message_id)
    assert message.body == "Client-created shell"
    assert message.status == "running"
    assert message.runId == run_id
  end

  test "a terminal coordinator wake is deleted and cannot launch", ctx do
    mission_id = Ecto.UUID.generate()
    wake_id = "sys-mission-#{mission_id}-stale"

    SQL.exec(
      """
      INSERT INTO chat_missions
        (id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,objective,status,created_by)
      VALUES (?,?,?,?,?,?,?,'completed',?)
      """,
      [
        mission_id,
        ctx.owner_vault.id,
        ctx.owner_channel.id,
        ctx.dispatch.messageId,
        ctx.registration.id,
        "Completed mission",
        "Already done",
        ctx.owner.id
      ]
    )

    assert {:ok, wake} =
             Messages.create(
               ctx.owner,
               ctx.owner_vault.id,
               ctx.owner_channel.id,
               %{
                 id: wake_id,
                 body: "Review a mission that already closed",
                 registrationId: ctx.registration.id
               },
               access: :agent
             )

    assert {:ok, wake_dispatch} =
             Dispatches.create(ctx.guest.id, ctx.guest_channel.id, wake, ctx.registration.id)

    response =
      request(ctx, %{
        prompt: "This stale wake must not run",
        chatDispatchId: wake_dispatch.id,
        chat: %{channelId: ctx.guest_channel.id, messageId: "stale-wake-response"}
      })

    assert response.status == 404
    assert Jason.decode!(response.resp_body) == %{"error" => "Chat dispatch not found"}

    assert Messages.get(ctx.owner_channel.id, ctx.owner.id, wake_id) ==
             {:error, "Message not found"}

    assert Dispatches.get(ctx.guest.id, ctx.guest_channel.id, wake_dispatch.id) ==
             {:error, "Chat dispatch not found"}
  end

  test "a ghost sticky lease is canceled before the next dispatch claims the registration", ctx do
    {:ok, prior_message} =
      Messages.create(ctx.guest, ctx.guest_vault.id, ctx.guest_channel.id, %{
        id: "prior-sticky-message-#{System.unique_integer([:positive])}",
        body: "@#{ctx.registration.mention} prior turn"
      })

    {:ok, prior_dispatch} =
      Dispatches.create(ctx.guest.id, ctx.guest_channel.id, prior_message, ctx.registration.id)

    assert {:ok, prior_run} =
             Store.start(ctx.owner_vault.id, nil, "prior prompt", "codex",
               conversation_id: "sticky-session",
               chat_dispatch_id: prior_dispatch.id
             )

    assert :ok = Dispatches.attach_run(prior_dispatch.id, prior_run.id)

    response =
      request(ctx, %{
        prompt: "replacement turn",
        conversation_id: "sticky-session",
        chatDispatchId: ctx.dispatch.id,
        chat: %{channelId: ctx.guest_channel.id, messageId: "replacement-shell"}
      })

    assert response.status == 200
    replacement_id = Jason.decode!(response.resp_body)["run"]["id"]
    assert replacement_id != prior_run.id
    assert Store.get(prior_run.id).status == "canceled"
    assert Store.get(prior_run.id).summary == "Run abandoned after desktop disconnect or restart."
    assert Store.find_open_for_chat_registration(ctx.registration.id).id == replacement_id
  end

  test "an offline runner transport leaves its sticky child open for reclaim", ctx do
    {:ok, prior_message} =
      Messages.create(ctx.guest, ctx.guest_vault.id, ctx.guest_channel.id, %{
        id: "offline-prior-message-#{System.unique_integer([:positive])}",
        body: "@#{ctx.registration.mention} long turn"
      })

    {:ok, prior_dispatch} =
      Dispatches.create(ctx.guest.id, ctx.guest_channel.id, prior_message, ctx.registration.id)

    assert {:ok, prior_run} =
             Store.start(ctx.owner_vault.id, nil, "still running locally", "codex",
               conversation_id: "offline-sticky-session",
               chat_dispatch_id: prior_dispatch.id
             )

    assert :ok = Dispatches.attach_run(prior_dispatch.id, prior_run.id)
    assert :ok = Store.record_delegated(prior_run.id, ctx.owner.id)
    assert :ok = Hub.unregister_runner(ctx.owner.id, ctx.sid)

    response =
      request(ctx, %{
        prompt: "queued continuation",
        conversation_id: "offline-sticky-session",
        chatDispatchId: ctx.dispatch.id,
        chat: %{channelId: ctx.guest_channel.id, messageId: "offline-replacement-shell"}
      })

    assert response.status == 503

    assert Jason.decode!(response.resp_body) == %{
             "error" =>
               "This agent's owner is offline — their desktop runner isn't connected, so the agent can't run right now."
           }

    assert Store.get(prior_run.id).status == "queued"
    assert Store.delegated_owner(prior_run.id) == ctx.owner.id
    assert is_nil(Store.find_by_chat_dispatch(ctx.dispatch.id))
  end

  defp request(ctx, body) do
    conn(:post, "/api/vaults/#{ctx.guest_vault.id}/runs", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer #{Token.sign_user(ctx.guest)}")
    |> CascadeWeb.OrchestrationRouter.call(CascadeWeb.OrchestrationRouter.init([]))
  end

  defp user!(id, username) do
    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [id, username, "x", username]
    )

    %{id: id, username: username, auth_version: 0}
  end

  defp connect_runner!(sid, token) do
    send_socket!(sid, %{type: :connect, namespace: "/runners", data: %{"token" => token}})
  end

  defp register_runner!(sid) do
    send_socket!(
      sid,
      SocketIO.event("/runners", "runner:register", [
        %{"activeRunIds" => [], "runnerInstanceId" => sid}
      ])
    )
  end

  defp send_socket!(sid, packet) do
    payload = EngineIO.encode_payload([%{type: :message, data: SocketIO.encode(packet)}])
    assert :ok = Session.receive_payload(sid, payload)
  end
end
