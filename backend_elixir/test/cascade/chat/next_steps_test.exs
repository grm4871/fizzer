defmodule Cascade.Chat.NextStepsTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages, NextSteps, Schema}
  alias Cascade.Content.Store
  alias Cascade.Missions.{Authority, Dispatches}
  alias Cascade.Missions.Store, as: Missions

  setup do
    ctx = Cascade.TestHelpers.owner_vault("next-steps")
    user = %{id: ctx.user_id, username: ctx.username}

    channel =
      Store.create_note(ctx.vault_id, user.id, %{title: "Room", content: "cascade://chat-channel"})

    {:ok, identity} =
      Agents.upsert_identity(user.id, ctx.vault_id, %{agentId: "codex", mention: "astra"})

    {:ok, member} =
      Agents.add_to_channel(user.id, ctx.vault_id, channel.id, identity.id, %{orchestrator: true})

    {:ok, source} =
      Messages.create(user, ctx.vault_id, channel.id, %{
        body: "The updater failed again and interrupted my work."
      })

    Map.merge(ctx, %{
      user: user,
      channel: channel,
      identity: identity,
      member: member,
      source: source
    })
  end

  test "default off, owner-only, per-channel, survives schema repair and clears on demotion", c do
    refute c.member.nextStepSuggestions
    assert context(c) =~ "suggestions are off"
    enable(c)
    Schema.ensure!()
    {:ok, [saved]} = Agents.list_members(c.channel.id, c.user.id)
    assert saved.nextStepSuggestions

    other =
      Store.create_note(c.vault_id, c.user.id, %{
        title: "Other",
        content: "cascade://chat-channel"
      })

    {:ok, other_member} = Agents.add_to_channel(c.user.id, c.vault_id, other.id, c.identity.id)
    refute other_member.nextStepSuggestions
    stranger = Cascade.TestHelpers.owner_vault("next-stranger")

    assert {:error, _} =
             Agents.add_to_channel(stranger.user_id, c.vault_id, c.channel.id, c.identity.id, %{
               nextStepSuggestions: true
             })

    {:ok, updated} =
      Agents.add_to_channel(c.user.id, c.vault_id, c.channel.id, c.identity.id, %{model: "test"})

    assert updated.nextStepSuggestions

    {:ok, demoted} =
      Agents.add_to_channel(c.user.id, c.vault_id, c.channel.id, c.identity.id, %{
        orchestrator: false
      })

    refute demoted.nextStepSuggestions
  end

  test "upgrading existing registrations defaults off and preserves message cursors", c do
    SQL.exec("ALTER TABLE chat_agent_members DROP COLUMN next_step_suggestions")
    Schema.ensure!()
    {:ok, [member]} = Agents.list_members(c.channel.id, c.user.id)
    assert member.id == c.member.id
    refute member.nextStepSuggestions
    {:ok, source} = Messages.get(c.channel.id, c.user.id, c.source.id)
    assert source == c.source

    normalized =
      SQL.table_sql("chat_agent_members") |> String.replace(~r/\s+/, " ") |> String.trim()

    assert Base.encode16(:crypto.hash(:sha256, normalized), case: :lower) ==
             "cbad10329484a7a611ef7c9c5789bc88987431279e0fdd44d51817579d693676"
  end

  test "enabled opportunity has grounded evidence and bounded acceptance", c do
    enable(c)
    prompt = context(c)
    assert prompt =~ "fizzer-next:#{c.source.id}"
    assert prompt =~ "Do not suggest for weak evidence"

    assert prompt =~
             "Natural-language acceptance by the owner authorizes only the proposed bounded task"

    assert prompt =~ "using the acceptance message as authority"
    assert prompt =~ "silence, decline"
    assert prompt =~ "[no-reply]"
    assert NextSteps.context(c.channel.id, c.member.id, "missing") =~ "Do not offer a new"

    assert NextSteps.context(c.channel.id, c.member.id, c.source.id, true) =~
             "suggestions are off"

    refute proposal(c).body == ""
  end

  test "default off and disablement suppress a generated suggestion at publication", c do
    assert proposal(c).body == ""
    enable(c)
    assert context(c) =~ "You may offer"
    enable(c, false)
    assert proposal(c).body == ""
    assert context(c) =~ "overrides earlier suggestion settings"
  end

  test "terminal projection publishes once and disablement preserves prior feedback", c do
    enable(c)
    input = proposal_input(c)

    {:ok, shell} =
      Messages.create(
        c.user,
        c.vault_id,
        c.channel.id,
        %{input | body: "Thinking...", status: "running"},
        access: :agent
      )

    projection =
      Cascade.Runs.ChatProjection.build([
        %{
          type: "status",
          payload_json: Jason.encode!(%{status: "completed", summary: input.body})
        }
      ])

    assert projection.status == nil

    {:ok, saved} =
      Messages.update(
        c.user,
        c.vault_id,
        c.channel.id,
        shell.id,
        %{body: projection.body, status: projection.status},
        access: :agent
      )

    assert saved.body == input.body
    enable(c, false)

    {:ok, repeated} =
      Messages.update(
        c.user,
        c.vault_id,
        c.channel.id,
        shell.id,
        %{body: projection.body, status: projection.status},
        access: :agent
      )

    assert repeated.body == input.body
    assert proposal(c).body == ""
    {:ok, human} = Messages.create(c.user, c.vault_id, c.channel.id, %{body: "[no-reply]"})
    assert human.body == "[no-reply]"
  end

  test "streaming, workers and ungrounded references cannot publish suggestions", c do
    enable(c)
    draft = proposal_input(c)
    assert NextSteps.prepare(%{draft | status: "running"}, c.channel.id).body == ""
    assert NextSteps.prepare(Map.put(draft, :missionTaskId, "worker"), c.channel.id).body == ""

    assert NextSteps.prepare(
             %{draft | body: "<!-- fizzer-next:missing --> Invented problem?"},
             c.channel.id
           ).body == ""
  end

  test "persisted proposal suppresses repeats and retains decline reasons after a cold start",
       c do
    enable(c)
    first = proposal(c)
    assert first.body =~ "Should fixing it be next?"
    assert proposal(c).body == ""
    assert context(c) =~ "Do not offer a new"

    {:ok, decline} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "No, leave it; I need the editor stable for a demo."
      })

    age(first)
    prompt = NextSteps.context(c.channel.id, c.member.id, decline.id)
    assert prompt =~ "Do not offer a new"
    assert prompt =~ "Should fixing it be next?"
    assert prompt =~ "I need the editor stable for a demo"
    assert proposal(c).body == ""
    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [c.channel.id]) == [0]
  end

  test "acceptance uses the existing coordinator dispatch and owner authority record", c do
    enable(c)
    proposed = proposal(c)

    {:ok, accepted} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "Yes, fix it, but keep my editor open.",
        replyTo: %{messageId: proposed.id, author: "Astra", body: proposed.body}
      })

    assert {:ok, dispatches} = Dispatches.create_for_message(c.user.id, c.channel.id, accepted)
    assert Enum.any?(dispatches, &(&1.registration.id == c.member.id))
    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [c.channel.id]) == [0]

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: accepted.id,
        coordinatorRegistrationId: c.member.id,
        title: "Fix updater",
        objective: "Fix the recurring updater failure; keep the editor open."
      })

    authority = Authority.context(mission.mission.id)
    assert authority =~ "Yes, fix it, but keep my editor open."
    assert authority =~ accepted.id
    refute authority =~ "Should fixing it be next?"
  end

  test "later completed work permits fresh evidence but never repeats the same evidence", c do
    enable(c)
    first = proposal(c)
    age(first)

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: c.source.id,
        coordinatorRegistrationId: c.member.id,
        title: "Other work"
      })

    SQL.exec("UPDATE chat_missions SET status='completed' WHERE id=?", [mission.mission.id])

    {:ok, fresh} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "A new build error is now blocking the release."
      })

    assert NextSteps.context(c.channel.id, c.member.id, fresh.id) =~ "You may offer"
    assert proposal(c).body == ""
    assert proposal(%{c | source: fresh}).body != ""
  end

  defp age(message),
    do:
      SQL.exec(
        "UPDATE chat_messages SET created_at=datetime('now','-2 hours'),activity_at=datetime('now','-2 hours') WHERE id=?",
        [message.id]
      )

  defp enable(c, value \\ true) do
    {:ok, _} =
      Agents.add_to_channel(c.user.id, c.vault_id, c.channel.id, c.identity.id, %{
        nextStepSuggestions: value
      })
  end

  defp context(c), do: NextSteps.context(c.channel.id, c.member.id, c.source.id)

  defp proposal_input(c) do
    %{
      id: Ecto.UUID.generate(),
      body:
        "<!-- fizzer-next:#{c.source.id} -->\n\nThis keeps failing and interrupting you. Should fixing it be next?",
      status: "completed",
      registrationId: c.member.id,
      agentId: "codex",
      blocks: []
    }
  end

  defp proposal(c) do
    {:ok, message} =
      Messages.create(c.user, c.vault_id, c.channel.id, proposal_input(c), access: :agent)

    message
  end
end
