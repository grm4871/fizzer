defmodule Cascade.ChatMessagesTest do
  @moduledoc "Focused chat message, projection, HTTP, and ordered-mutation contracts."
  use ExUnit.Case, async: false
  import Plug.Conn
  import Plug.Test
  import Cascade.ChatDomainTestSupport
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Channel, Messages, RoomContext}
  alias Cascade.Content.Store

  setup do
    Cascade.ChatDomainTestSupport.setup()
  end

  test "linked projections keep chronological rows separate with truthful human and agent attribution" do
    {source, source_channel} = chat_vault(1, "Source", "Room")
    {local, local_channel} = chat_vault(2, "Bob", "Mirror")
    assert {:ok, _} = Channel.link(source.id, source_channel.id, local.id, local_channel.id, 1)

    alice = %{id: 1, username: "alice"}
    bob = %{id: 2, username: "bob"}
    at = "2026-08-10T12:00:00.000Z"

    assert {:ok, first} =
             Messages.create(alice, source.id, source_channel.id, %{
               id: "m-human",
               author: "spoof",
               body: "one",
               createdAt: at
             })

    assert first.author == "alice"

    assert {:ok, identity} =
             Agents.upsert_identity(1, source.id, %{
               agentId: "codex",
               displayName: "Sol",
               mention: "sol"
             })

    assert {:ok, registration} =
             Agents.add_to_channel(1, source.id, source_channel.id, identity.id)

    assert {:ok, second} =
             Messages.create(
               alice,
               source.id,
               source_channel.id,
               %{
                 id: "m-agent",
                 body: "two",
                 createdAt: at,
                 registrationId: registration.id,
                 author: "Terra"
               },
               access: :agent
             )

    assert second.author == "Sol"
    assert second.registrationId == registration.id

    assert {:ok, third} =
             Messages.create(bob, local.id, local_channel.id, %{
               id: "m-bob",
               body: "three",
               createdAt: at
             })

    assert third.channelId == local_channel.id

    assert {:ok, messages} = Messages.list(local_channel.id, 2)
    assert Enum.map(messages, & &1.id) == ~w(m-human m-agent m-bob)
    assert Enum.map(messages, & &1.author) == ["alice", "Sol", "bob"]
    assert Enum.all?(messages, &(&1.channelId == local_channel.id))
    assert Enum.sort(Enum.map(messages, & &1.seq)) == Enum.map(messages, & &1.seq)
  end

  test "vault unlink preserves the owner profile and memberships elsewhere until explicit profile deletion" do
    {first_vault, first_channel} = chat_vault(1, "One", "A")
    {test_vault, test_channel} = chat_vault(1, "Test", "B")

    assert {:ok, identity} =
             Agents.upsert_identity(1, first_vault.id, %{
               agentId: "codex",
               displayName: "Sol",
               mention: "sol"
             })

    assert {:ok, first_member} =
             Agents.add_to_channel(1, first_vault.id, first_channel.id, identity.id)

    assert {:ok, test_member} =
             Agents.add_to_channel(1, test_vault.id, test_channel.id, identity.id)

    assert {:ok, true} = Agents.unlink_from_vault(1, test_vault.id, identity.id)
    assert {:ok, still_present} = Agents.get(1, first_vault.id, identity.id)
    assert first_channel.id in still_present.channelIds
    refute test_channel.id in still_present.channelIds

    assert SQL.one("SELECT id FROM chat_agent_members WHERE id=?", [first_member.id]) == [
             first_member.id
           ]

    assert SQL.one("SELECT id FROM chat_agent_members WHERE id=?", [test_member.id]) == nil
    assert SQL.one("SELECT id FROM vault_agents WHERE id=?", [identity.id]) == [identity.id]

    assert {:ok, true} = Agents.delete_profile(1, first_vault.id, identity.id)
    assert SQL.one("SELECT id FROM vault_agents WHERE id=?", [identity.id]) == nil

    assert SQL.one("SELECT id FROM chat_agent_members WHERE vault_agent_id=?", [identity.id]) ==
             nil
  end

  test "concurrent identity adds preserve a single channel registration" do
    {vault, channel} = chat_vault(1, "One", "A")

    assert {:ok, identity} =
             Agents.upsert_identity(1, vault.id, %{
               agentId: "codex",
               displayName: "Codex",
               mention: "codex"
             })

    registrations =
      1..8
      |> Task.async_stream(
        fn _ -> Agents.add_to_channel(1, vault.id, channel.id, identity.id) end,
        max_concurrency: 8,
        ordered: false
      )
      |> Enum.map(fn {:ok, {:ok, registration}} -> registration.id end)

    assert length(Enum.uniq(registrations)) == 1

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_agent_members WHERE channel_id=? AND vault_agent_id=?",
             [channel.id, identity.id]
           ) == [1]
  end

  test "message list strips heavy images while detail hydrates and embeds stay frozen and redact for agents" do
    {vault, channel} = chat_vault(1, "Notes", "Room")
    Store.create_note(vault.id, 1, %{title: "Plan", content: "public\n:::private\nsecret\n:::"})
    user = %{id: 1, username: "alice"}

    assert {:ok, created} =
             Messages.create(user, vault.id, channel.id, %{
               id: "media",
               body: "See ![[Plan|short#part]]",
               images: ["data:image/png;base64,AAAA", "https://example.com/a.png"]
             })

    assert {:ok, [listed]} = Messages.list(channel.id, 1)
    assert listed.hasImages
    assert listed.images == ["https://example.com/a.png"]
    assert {:ok, detailed} = Messages.get(channel.id, 1, created.id)
    assert length(detailed.images) == 2
    assert {:ok, [human]} = Messages.embeds(channel.id, 1, created.id)
    assert human.content =~ "secret"
    assert {:ok, [agent]} = Messages.embeds(channel.id, 1, created.id, access: :agent)
    refute agent.content =~ "secret"
    assert agent.content =~ "Private block hidden"
  end

  test "message writes authorize and fetch through semantic domain phases" do
    {vault, channel} = chat_vault(1, "Fast messages", "Room")
    user = %{id: 1, username: "alice"}
    handler_id = "message-write-phases-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        handler_id,
        [:cascade, :chat, :message_write],
        fn _event, %{count: count}, %{operation: operation, stage: stage, outcome: outcome}, _config ->
          send(test_pid, {:message_write, operation, stage, outcome, count})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    assert {:ok, %{id: "fast-message"}} =
             Messages.create(user, vault.id, channel.id, %{id: "fast-message", body: "one"})

    assert_receive {:message_write, :create, :authorize, :ok, 1}
    assert_receive {:message_write, :create, :fetch, :ok, 1}
    refute_receive {:message_write, :create, :authorize, :ok, 1}, 100
    refute_receive {:message_write, :create, :fetch, :ok, 1}, 100


    assert {:ok, %{body: "two"}} =
             Messages.update(user, vault.id, channel.id, "fast-message", %{body: "two"})

    assert_receive {:message_write, :update, :authorize, :ok, 1}
    assert_receive {:message_write, :update, :fetch, :ok, 1}

    refute_receive {:message_write, :update, :authorize, :ok, 1}, 100
    refute_receive {:message_write, :update, :fetch, :ok, 1}, 100

    assert {:error, "Chat channel not found"} =
             Messages.create(user, vault.id, "missing-channel", %{id: "unauthorized", body: "no"})

    assert_receive {:message_write, :create, :authorize, :rejected, 1}
    refute_receive {:message_write, :create, :fetch, :ok, 1}, 100
  end

  test "typed ancestry is bounded and natural links point to a specific prior message" do
    input = %{body: "@sol can you review this approach?"}

    prior = [
      %{
        id: "m1",
        author: "alice",
        body: "This is a sufficiently substantive prior proposal for review.",
        createdAt: "2026-01-01",
        status: nil
      }
    ]

    registrations = [%{id: "r1", agentId: "codex", mention: "sol", displayName: "Sol"}]
    linked = RoomContext.infer_natural_link(input, prior, registrations)
    assert linked.replyTo.messageId == "m1"
    assert linked.replyTo.relationship == "review_request"
  end

  test "chat route catalog is complete and has no duplicates" do
    catalog = CascadeWeb.ChatRoutes.catalog()
    assert length(catalog) == 27
    assert length(Enum.uniq(catalog)) == 27
    assert {"DELETE", "/api/vaults/:vault_id/vault-agents/:agent_id/profile"} in catalog

    assert {"POST", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/collaborate"} in catalog
  end

  test "isolated router authenticates and serves projected message history" do
    {vault, channel} = chat_vault(1, "HTTP", "Room")
    user = %{id: 1, username: "alice"}

    assert {:ok, _} =
             Messages.create(user, vault.id, channel.id, %{id: "http-message", body: "hello"})

    token = Cascade.Auth.Token.sign_user(%{id: 1, username: "alice", auth_version: 0})

    response =
      conn(:get, "/api/vaults/#{vault.id}/channels/#{channel.id}/messages")
      |> put_req_header("authorization", "Bearer " <> token)
      |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))

    assert response.status == 200

    assert %{"messages" => [%{"id" => "http-message", "author" => "alice"}]} =
             Jason.decode!(response.resp_body)
  end

  test "concurrent message commits publish created events in rowid order" do
    {vault, channel} = chat_vault(1, "Ordered", "Room")
    token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})
    test_pid = self()

    events = fn
      %{event: "vault:chatMessageCreated", message: %{id: "ordered-first"} = message} ->
        send(test_pid, {:first_emit_blocked, self(), message.seq})

        receive do
          :release_first_emit -> :ok
        after
          2_000 -> raise "first ordered event was not released"
        end

        send(test_pid, {:ordered_event, message.id, message.seq})

      %{event: "vault:chatMessageCreated", message: message} ->
        send(test_pid, {:ordered_event, message.id, message.seq})

      _intent ->
        :ok
    end

    path = "/api/vaults/#{vault.id}/channels/#{channel.id}/messages"

    first =
      Task.async(fn ->
        chat_request(:post, path, token, %{id: "ordered-first", body: "first"}, events: events)
      end)

    assert_receive {:first_emit_blocked, first_emitter, first_seq}, 2_000

    second =
      Task.async(fn ->
        chat_request(:post, path, token, %{id: "ordered-second", body: "second"}, events: events)
      end)

    refute_receive {:ordered_event, "ordered-second", _seq}, 200
    assert SQL.one("SELECT id FROM chat_messages WHERE id='ordered-second'") == nil

    send(first_emitter, :release_first_emit)
    assert_receive {:ordered_event, "ordered-first", ^first_seq}, 2_000
    assert_receive {:ordered_event, "ordered-second", second_seq}, 2_000
    assert first_seq < second_seq
    assert Task.await(first, 2_000).status == 201
    assert Task.await(second, 2_000).status == 201
  end

  test "message update and delete mutations publish in execution order" do
    {vault, channel} = chat_vault(1, "Ordered updates", "Room")
    user = %{id: 1, username: "alice"}
    token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})
    test_pid = self()

    assert {:ok, _message} =
             Messages.create(user, vault.id, channel.id, %{
               id: "ordered-mutation",
               body: "before"
             })

    events = fn
      %{event: "vault:chatMessageUpdated", message: %{id: "ordered-mutation"}} ->
        send(test_pid, {:update_emit_blocked, self()})

        receive do
          :release_update -> :ok
        after
          2_000 -> raise "update event was not released"
        end

        send(test_pid, {:ordered_mutation_event, :updated})

      %{event: "vault:chatMessageDeleted", messageId: "ordered-mutation"} ->
        send(test_pid, {:ordered_mutation_event, :deleted})

      _intent ->
        :ok
    end

    path = "/api/vaults/#{vault.id}/channels/#{channel.id}/messages/ordered-mutation"

    update =
      Task.async(fn ->
        chat_request(:patch, path, token, %{body: "after"}, events: events)
      end)

    assert_receive {:update_emit_blocked, publisher}, 2_000

    delete = Task.async(fn -> chat_request(:delete, path, token, %{}, events: events) end)

    refute_receive {:ordered_mutation_event, :deleted}, 200
    assert SQL.one("SELECT body FROM chat_messages WHERE id='ordered-mutation'") == ["after"]

    send(publisher, :release_update)
    assert_receive {:ordered_mutation_event, :updated}, 2_000
    assert_receive {:ordered_mutation_event, :deleted}, 2_000
    assert Task.await(update, 2_000).status == 200
    assert Task.await(delete, 2_000).status == 200
    assert SQL.one("SELECT id FROM chat_messages WHERE id='ordered-mutation'") == nil
  end

  test "restricted agent posts retain explicit unregistered attribution and can be forwarded safely" do
    {source_vault, source_channel} = chat_vault(1, "Source", "Agent source")
    {target_vault, target_channel} = chat_vault(1, "Target", "Forward target")
    agent_token = Token.sign_agent(%{id: 1, username: "alice", auth_version: 0})
    user_token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})

    posted =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages",
        agent_token,
        %{
          id: "restricted-source",
          channelId: source_channel.id,
          author: "Claude",
          body: "the renderer stalled for ~1s",
          createdAt: "2026-08-10T16:00:00.000Z",
          agentId: "claude",
          attachments: [
            %{
              name: "diagram.png",
              media_type: "image/png",
              url: "https://example.test/diagram.png"
            }
          ]
        }
      )

    assert posted.status == 201
    source = Jason.decode!(posted.resp_body)["message"]
    assert source["author"] == "Claude"
    assert source["agentId"] == "claude"
    assert is_nil(source["registrationId"])

    forwarded =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages/restricted-source/forward",
        user_token,
        %{targetVaultId: target_vault.id, targetChannelId: target_channel.id}
      )

    assert forwarded.status == 201
    message = Jason.decode!(forwarded.resp_body)["message"]
    assert message["author"] == "alice"
    assert message["forwardedFrom"]["author"] == "Claude"

    assert [%{"name" => "diagram.png", "url" => "https://example.test/diagram.png"}] =
             message["attachments"]

    missing =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages/unknown/forward",
        user_token,
        %{targetVaultId: target_vault.id, targetChannelId: target_channel.id}
      )

    assert missing.status == 400
    assert Jason.decode!(missing.resp_body) == %{"error" => "Message not found"}

    outsider =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages/restricted-source/forward",
        Token.sign_user(%{id: 3, username: "carol", auth_version: 0}),
        %{targetVaultId: target_vault.id, targetChannelId: target_channel.id}
      )

    assert outsider.status == 400
    assert Jason.decode!(outsider.resp_body) == %{"error" => "Chat channel not found"}
    assert {:ok, target_messages} = Messages.list(target_channel.id, 1)
    assert Enum.map(target_messages, & &1.forwardedFrom["messageId"]) == ["restricted-source"]
  end
end
