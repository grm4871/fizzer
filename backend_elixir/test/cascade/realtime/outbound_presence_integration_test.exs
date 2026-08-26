defmodule Cascade.Realtime.OutboundPresenceIntegrationTest do
  @moduledoc "Presence snapshot, invalidation, route, and disconnect outbound contracts."
  use ExUnit.Case, async: false
  import Cascade.Realtime.OutboundIntegrationSupport
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Channel, Messages}
  alias Cascade.Content.Store
  alias Cascade.Realtime.{Events, Hub, PresenceDispatcher}

  setup_all do
    {:ok, _applications} = Application.ensure_all_started(:inets)
    port = available_port()
    start_supervised!({Bandit, plug: Cascade.Realtime.OutboundIntegrationRouter, scheme: :http, ip: {127, 0, 0, 1}, port: port, thousand_island_options: [num_acceptors: 2, num_connections: 100]})
    {:ok, target: "http://127.0.0.1:#{port}"}
  end

  setup do
    Cascade.Realtime.OutboundIntegrationSupport.setup_database()
  end

  @tag timeout: 60_000
  test "initial presence resolves authorization, participants, profiles, owner, and online state" do
    {source, _source_channel, local, local_channel} = linked_chat()
    handler_id = "initial-presence-resolution-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach_many(
        handler_id,
        [
          [:cascade, :realtime, :presence_resolution],
          [:cascade, :realtime, :presence_snapshot]
        ],
        fn event, %{count: count}, metadata, _config ->
          send(test_pid, {:presence_operation, event, count, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    assert {:ok, payload, route} = Events.initial_presence(local_channel.id, 2)
    assert route.sourceVaultId == source.id
    assert route.localVaultId == local.id
    assert payload.participants == ["alice", "bob"]
    assert payload.owner == "alice"
    assert payload.profiles["alice"].displayName == "Alice"

    assert_receive {:presence_operation, [:cascade, :realtime, :presence_snapshot], 1,
                    %{reason: :initial}}

    assert_receive {:presence_operation, [:cascade, :realtime, :presence_resolution], 1,
                    %{reason: :initial, source: :initial}}
  end

  test "presence never embeds profile avatars" do
    {source, source_channel, _local, _local_channel} = linked_chat()
    inline_avatar = "data:image/jpeg;base64," <> String.duplicate("A", 300_000)
    SQL.exec("UPDATE users SET avatar_url=? WHERE username='alice'", [inline_avatar])

    snapshot = Channel.participant_snapshot(source.id, source_channel.id)

    refute Map.has_key?(snapshot.profiles["alice"], :avatarUrl)
    refute Map.has_key?(Enum.find(snapshot.users, &(&1.username == "alice")), :avatarUrl)
  end

  test "presence snapshots and route reads emit exact reason telemetry" do
    {source, source_channel, _local, _local_channel} = linked_chat()
    handler_id = "presence-reason-count-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach_many(
        handler_id,
        [
          [:cascade, :realtime, :presence_snapshot],
          [:cascade, :chat, :list_routes]
        ],
        fn event, measurements, metadata, _config ->
          send(test_pid, {:presence_reason, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    assert {:ok, _payload, _route} = Events.initial_presence(source_channel.id, 1)

    assert_receive {:presence_reason, [:cascade, :realtime, :presence_snapshot], %{count: 1},
                    %{reason: :initial}}

    assert :refreshed = Events.emit_presence_now(source.id, source_channel.id, :direct)

    assert_receive {:presence_reason, [:cascade, :realtime, :presence_snapshot], %{count: 1},
                    %{reason: :direct}}

    assert_receive {:presence_reason, [:cascade, :chat, :list_routes], %{count: 1},
                    %{reason: :direct}}

    assert :refreshed = Events.emit_presence_now(source.id, source_channel.id, :dispatcher)

    assert_receive {:presence_reason, [:cascade, :realtime, :presence_snapshot], %{count: 1},
                    %{reason: :dispatcher}}

    assert_receive {:presence_reason, [:cascade, :chat, :list_routes], %{count: 1},
                    %{reason: :dispatcher}}

    _routes = Channel.list_routes(source.id, source_channel.id)

    assert_receive {:presence_reason, [:cascade, :chat, :list_routes], %{count: 1},
                    %{reason: :other}}
  end

  test "participant snapshots preserve exact mixed-case author identity" do
    {source, source_channel, _local, _local_channel} = linked_chat()

    SQL.exec(
      "INSERT INTO chat_messages(id,channel_id,vault_id,author,body) VALUES(?,?,?,?,?)",
      ["mixed-case", source_channel.id, source.id, "ALICE", "legacy casing"]
    )

    snapshot = Channel.participant_snapshot(source.id, source_channel.id)
    assert "ALICE" in snapshot.participants
    assert "alice" in snapshot.participants
    assert Map.has_key?(snapshot.profiles, "alice")
    refute Map.has_key?(snapshot.profiles, "ALICE")
  end
  test "vault General and every chat-marker lifecycle mutation invalidate presence indexes" do
    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    _vault = Store.create_vault(1, %{name: "General invalidation"})
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    vault = Store.create_vault(1, %{name: "Marker transitions"})
    note = Store.create_note(vault.id, 1, %{title: "Plain", content: "plain"})
    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.update_note(note.id, "cascade://chat-channel", 1)
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.update_note(note.id, "plain again", 1)
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.delete_note(note.id)
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.rescan_vault(vault.id, 1)
    assert PresenceDispatcher.cached_user_channels(1) == :miss
  end
  @tag timeout: 60_000
  test "presence is app-wide, linked-route local, and remains online until the final window closes",
       %{
         target: target
       } do
    {source, source_channel, local, local_channel} = linked_chat()
    alice_one = open_probe(target, token(1, "alice"), "alice-one")
    alice_two = open_probe(target, token(1, "alice"), "alice-two")
    bob = open_probe(target, token(2, "bob"), "bob")
    close_on_exit([alice_one, alice_two, bob])

    join_vault(alice_one, source.id, 1)
    join_vault(bob, local.id, 2)
    join_chat(alice_one, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)

    initial = await_presence(bob, ["alice", "bob"])
    assert get_in(initial, ["args", Access.at(0), "vaultId"]) == local.id
    assert get_in(initial, ["args", Access.at(0), "channelId"]) == local_channel.id

    assert get_in(initial, ["args", Access.at(0), "profiles", "alice"]) == %{
             "id" => 1,
             "username" => "alice",
             "displayName" => "Alice"
           }

    disconnect_namespace(alice_one, "vault")
    still_online = await_presence(bob, ["alice", "bob"])
    assert get_in(still_online, ["args", Access.at(0), "online"]) == ["alice", "bob"]

    disconnect_namespace(alice_two, "vault")
    offline = await_presence(bob, ["bob"])
    assert get_in(offline, ["args", Access.at(0), "online"]) == ["bob"]
  end

  @tag timeout: 60_000
  test "a presence burst reaches a real room client as one final refresh", %{target: target} do
    {source, source_channel, local, local_channel} = linked_chat()
    alice = open_probe(target, token(1, "alice"), "alice")
    bob = open_probe(target, token(2, "bob"), "bob")
    close_on_exit([alice, bob])

    join_vault(alice, source.id, 1)
    join_vault(bob, local.id, 2)
    join_chat(alice, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)
    assert await_presence(bob, ["alice", "bob"])
    assert eventually(&presence_dispatcher_idle?/0)
    flush_probe(bob)
    before = PresenceDispatcher.stats()

    Enum.each(1..25, fn _ -> Events.emit_presence(source.id, source_channel.id) end)

    refresh = await_presence(bob, ["alice", "bob"])
    assert get_in(refresh, ["args", Access.at(0), "vaultId"]) == local.id
    assert get_in(refresh, ["args", Access.at(0), "channelId"]) == local_channel.id
    assert eventually(&presence_dispatcher_idle?/0)
    after_refresh = PresenceDispatcher.stats()

    assert after_refresh.requested - before.requested == 25
    assert after_refresh.dispatched - before.dispatched == 1
    refute_receive {^bob, {:data, _line}}, 400
  end

  @tag timeout: 60_000
  test "final namespace disconnect reuses warmed presence indexes before broadcasting offline",
       %{target: target} do
    {source, source_channel, local, local_channel} = linked_chat()
    alice = open_probe(target, token(1, "alice"), "alice-index")
    bob = open_probe(target, token(2, "bob"), "bob-index")
    close_on_exit([alice, bob])

    join_vault(alice, source.id, 1)
    join_vault(bob, local.id, 2)
    join_chat(alice, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)
    assert await_presence(bob, ["alice", "bob"])
    assert eventually(&presence_dispatcher_idle?/0)

    assert eventually(fn ->
             match?({:ok, _channels}, PresenceDispatcher.cached_user_channels(1))
           end)

    flush_probe(bob)

    handler_id = "presence-disconnect-resolution-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        handler_id,
        [:cascade, :realtime, :presence_resolution],
        fn _event, %{count: count}, metadata, _config ->
          send(test_pid, {:presence_resolution, count, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    before = PresenceDispatcher.stats()

    disconnect_namespace(alice, "vault")
    assert await_presence(bob, ["bob"])

    assert_receive {:presence_resolution, 1, %{reason: :disconnect, source: :warm_index}}
    after_disconnect = PresenceDispatcher.stats()
    assert after_disconnect.cacheHits > before.cacheHits
    assert after_disconnect.cacheMisses == before.cacheMisses
    assert after_disconnect.disconnectResolutions > before.disconnectResolutions

    stale_generation = PresenceDispatcher.user_channels_generation()
    Events.members_changed(%{vaultId: source.id})
    assert eventually(fn -> PresenceDispatcher.cached_user_channels(1) == :miss end)

    assert PresenceDispatcher.remember_user_channels(1, [["stale", "stale"]], stale_generation) ==
             :stale

    assert PresenceDispatcher.cached_user_channels(1) == :miss

    current_generation = PresenceDispatcher.user_channels_generation()

    assert PresenceDispatcher.remember_user_channels(
             1,
             [[source.id, source_channel.id]],
             current_generation
           ) ==
             :ok

    assert PresenceDispatcher.cached_user_channels(1) ==
             {:ok, [[source.id, source_channel.id]]}
    PresenceDispatcher.invalidate_user_channels()
    Events.refresh_user_presence_now(1)
    assert_receive {:presence_resolution, 1, %{reason: :refresh, source: :database}}
    cold = PresenceDispatcher.stats()
    assert cold.cacheMisses > after_disconnect.cacheMisses
  end
end
