defmodule Cascade.ChatDispatchTest do
  @moduledoc "Focused coordinator dispatch, usage gating, and compact-target contracts."
  use ExUnit.Case, async: false
  import Cascade.ChatDomainTestSupport
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.Missions.Dispatches
  alias Cascade.Runs.RunnerLifecycle

  setup do
    Cascade.ChatDomainTestSupport.setup()
  end

  test "ordinary owner and linked-guest turns persist only their own coordinator dispatch" do
    {source_vault, source_channel} = chat_vault(1, "Source", "Shared room")
    {guest_vault, guest_channel} = chat_vault(2, "Guest", "Guest mirror")

    assert {:ok, _} =
             Channel.link(
               source_vault.id,
               source_channel.id,
               guest_vault.id,
               guest_channel.id,
               1
             )

    {:ok, sol_identity} =
      Agents.upsert_identity(1, source_vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol",
        model: "gpt-5.6-sol"
      })

    {:ok, sol} =
      Agents.add_to_channel(1, source_vault.id, source_channel.id, sol_identity.id, %{
        orchestrator: true,
        pingableByOthers: true
      })

    {:ok, guest_identity} =
      Agents.upsert_identity(2, guest_vault.id, %{
        agentId: "codex",
        displayName: "Guest Sol",
        mention: "guest_sol",
        model: "gpt-5.6-sol"
      })

    {:ok, guest_coordinator} =
      Agents.add_to_channel(2, guest_vault.id, guest_channel.id, guest_identity.id, %{
        orchestrator: true
      })

    owner_post =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages",
        Token.sign_user(%{id: 1, username: "alice", auth_version: 0}),
        %{
          id: "owner-root",
          channelId: source_channel.id,
          author: "spoofed",
          body: "Investigate and verify multiplayer orchestration.",
          createdAt: "2026-08-10T16:01:00.000Z"
        }
      )

    assert owner_post.status == 201
    assert [owner_dispatch] = Jason.decode!(owner_post.resp_body)["dispatches"]
    assert owner_dispatch["registration"]["id"] == sol.id

    guest_post =
      chat_request(
        :post,
        "/api/vaults/#{guest_vault.id}/channels/#{guest_channel.id}/messages",
        Token.sign_user(%{id: 2, username: "bob", auth_version: 0}),
        %{
          id: "guest-root",
          channelId: guest_channel.id,
          author: "spoofed",
          body: "Coordinate this shared-channel request.",
          createdAt: "2026-08-10T16:02:00.000Z"
        }
      )

    assert guest_post.status == 201
    assert [guest_dispatch] = Jason.decode!(guest_post.resp_body)["dispatches"]
    assert guest_dispatch["registration"]["id"] == guest_coordinator.id

    assert {:ok, owner_pending} = Dispatches.list_pending(1, source_channel.id)
    assert Enum.map(owner_pending, & &1.registration.id) == [sol.id]
    refute Enum.any?(owner_pending, &(&1.registration.id == guest_coordinator.id))

    assert {:ok, guest_pending} = Dispatches.list_pending(2, guest_channel.id)
    assert Enum.any?(guest_pending, &(&1.registration.id == guest_coordinator.id))

    assert SQL.all(
             "SELECT message_id,registration_id FROM chat_agent_dispatches WHERE message_id IN ('owner-root','guest-root') ORDER BY message_id",
             []
           ) == [["guest-root", guest_coordinator.id], ["owner-root", sol.id]]
  end

  test "exhausted Claude and Codex skip reply-to-all without blocking explicit mentions" do
    {vault, channel} = chat_vault(1, "Usage gate", "Usage gated room")
    user = %{id: 1, username: "alice"}

    add_reply_to_all = fn agent_id, display_name, mention ->
      {:ok, identity} =
        Agents.upsert_identity(1, vault.id, %{
          agentId: agent_id,
          displayName: display_name,
          mention: mention
        })

      {:ok, registration} =
        Agents.add_to_channel(1, vault.id, channel.id, identity.id, %{
          replyToEveryMessage: true
        })

      registration
    end

    claude = add_reply_to_all.("claude-code", "Claude", "claude")
    codex = add_reply_to_all.("codex", "Codex", "codex")

    RunnerLifecycle.report_plan_usage(1, %{
      "claude-code" => %{
        status: "ok",
        usedPercent: 100,
        extraUsageAvailable: false
      },
      "codex" => %{
        status: "ok",
        usedPercent: 100,
        extraUsageAvailable: false
      }
    })

    {:ok, ordinary} =
      Messages.create(user, vault.id, channel.id, %{
        id: "usage-gated-ordinary",
        body: "This should not wake exhausted reply-to-all agents.",
        createdAt: "2026-08-14T18:00:00.000Z"
      })

    assert {:ok, []} = Dispatches.create_for_message(user.id, channel.id, ordinary)

    {:ok, explicit} =
      Messages.create(user, vault.id, channel.id, %{
        id: "usage-gated-explicit",
        body: "@claude @codex answer explicitly",
        createdAt: "2026-08-14T18:01:00.000Z"
      })

    assert {:ok, dispatches} = Dispatches.create_for_message(user.id, channel.id, explicit)

    assert dispatches |> Enum.map(& &1.registration.id) |> Enum.sort() ==
             Enum.sort([claude.id, codex.id])

    RunnerLifecycle.report_plan_usage(1, %{
      "claude-code" => %{status: "ok", usedPercent: 0, extraUsageAvailable: true},
      "codex" => %{status: "ok", usedPercent: 0, extraUsageAvailable: true}
    })

    _ = RunnerLifecycle.plan_usage(1)
  end

  test "/compact targets the last Claude or the explicitly tagged Claude sessions" do
    {vault, channel} = chat_vault(1, "Compact", "Compact room")
    user = %{id: 1, username: "alice"}

    add_agent = fn agent_id, display_name, mention ->
      {:ok, identity} =
        Agents.upsert_identity(1, vault.id, %{
          agentId: agent_id,
          displayName: display_name,
          mention: mention
        })

      {:ok, registration} =
        Agents.add_to_channel(1, vault.id, channel.id, identity.id, %{pingableByOthers: true})

      registration
    end

    claude_one = add_agent.("claude-code", "Claude One", "claude-one")
    claude_two = add_agent.("claude-code", "Claude Two", "claude-two")
    codex = add_agent.("codex", "Codex", "codex")

    {:ok, _} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{
          id: "claude-last",
          body: "Finished the prior turn.",
          createdAt: "2026-08-14T18:00:00.000Z",
          registrationId: claude_one.id
        },
        access: :agent
      )

    {:ok, bare} =
      Messages.create(user, vault.id, channel.id, %{
        id: "compact-bare",
        body: "/compact",
        createdAt: "2026-08-14T18:01:00.000Z"
      })

    assert {:ok, [bare_dispatch]} = Dispatches.create_for_message(user.id, channel.id, bare)
    assert bare_dispatch.registration.id == claude_one.id

    {:ok, _} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{
          id: "codex-last",
          body: "I am the newest agent now.",
          createdAt: "2026-08-14T18:02:00.000Z",
          registrationId: codex.id
        },
        access: :agent
      )

    {:ok, wrong_provider} =
      Messages.create(user, vault.id, channel.id, %{
        id: "compact-after-codex",
        body: "/compact",
        createdAt: "2026-08-14T18:03:00.000Z"
      })

    assert {:ok, []} = Dispatches.create_for_message(user.id, channel.id, wrong_provider)

    {:ok, explicit} =
      Messages.create(user, vault.id, channel.id, %{
        id: "compact-explicit",
        body: "/compact @claude-one @claude-two @codex",
        createdAt: "2026-08-14T18:04:00.000Z"
      })

    assert {:ok, explicit_dispatches} =
             Dispatches.create_for_message(user.id, channel.id, explicit)

    assert explicit_dispatches |> Enum.map(& &1.registration.id) |> Enum.sort() ==
             Enum.sort([claude_one.id, claude_two.id])
  end
end
