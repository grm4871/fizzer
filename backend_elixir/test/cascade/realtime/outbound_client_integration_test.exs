defmodule Cascade.Realtime.OutboundClientIntegrationTest do
  @moduledoc "Client-facing outbound chat and account event delivery contracts."
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

  test "real Bandit keeps mutation responses in the stream owner", %{target: target} do
    {vault, channel, _local, _local_channel} = linked_chat()
    authorization = "Bearer #{token(1, "alice")}"

    assert {201, created} =
             http_json(
               :post,
               "#{target}/api/vaults/#{vault.id}/channels/#{channel.id}/messages",
               authorization,
               %{id: "bandit-owner-message", body: "created over real Bandit"}
             )

    assert created["message"]["id"] == "bandit-owner-message"
    assert created["message"]["body"] == "created over real Bandit"

    assert {200, updated} =
             http_json(
               :patch,
               "#{target}/api/vaults/#{vault.id}/channels/#{channel.id}/messages/bandit-owner-message",
               authorization,
               %{body: "patched over real Bandit"}
             )

    assert updated["message"]["id"] == "bandit-owner-message"
    assert updated["message"]["body"] == "patched over real Bandit"

    assert {200, %{"ok" => true}} =
             http_json(
               :delete,
               "#{target}/api/vaults/#{vault.id}/channels/#{channel.id}/messages/bandit-owner-message",
               authorization
             )
  end
  @tag timeout: 60_000
  test "real clients receive linked local projections while an unauthorized socket receives nothing",
       %{
         target: target
       } do
    {source, source_channel, local, local_channel} = linked_chat()
    alice = open_probe(target, token(1, "alice"), "alice")
    bob = open_probe(target, token(2, "bob"), "bob")
    eve = open_probe(target, token(3, "eve"), "eve")
    close_on_exit([alice, bob, eve])

    join_vault(alice, source.id, 1)
    join_vault(bob, local.id, 2)
    command(eve, "vault", "joinVault", [source.id])
    refute eventually_joined?("vault:#{source.id}", 3)

    join_chat(alice, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)
    flush_probe(alice)
    flush_probe(bob)
    flush_probe(eve)

    {:ok, message} =
      Messages.create(%{id: 1, username: "alice"}, source.id, source_channel.id, %{
        id: "linked-message",
        body: "persisted first"
      })

    assert Messages.get(source_channel.id, 1, message.id) == {:ok, message}

    Events.emit(%{
      event: "vault:chatMessageCreated",
      vaultId: source.id,
      channelId: source_channel.id,
      message: message,
      dispatches: [
        %{id: "alice-dispatch", registration: %{ownerUserId: 1, pingableByOthers: false}},
        %{id: "bob-dispatch", registration: %{ownerUserId: 2, pingableByOthers: false}}
      ]
    })

    alice_event = await_event(alice, "vault", "vault:chatMessageCreated")
    bob_event = await_event(bob, "vault", "vault:chatMessageCreated")

    assert get_in(alice_event, ["args", Access.at(0), "vaultId"]) == source.id
    assert get_in(alice_event, ["args", Access.at(0), "channelId"]) == source_channel.id

    assert get_in(alice_event, ["args", Access.at(0), "message", "channelId"]) ==
             source_channel.id

    assert get_in(alice_event, ["args", Access.at(0), "dispatches", Access.at(0), "id"]) ==
             "alice-dispatch"

    assert get_in(bob_event, ["args", Access.at(0), "vaultId"]) == local.id
    assert get_in(bob_event, ["args", Access.at(0), "channelId"]) == local_channel.id
    assert get_in(bob_event, ["args", Access.at(0), "message", "channelId"]) == local_channel.id

    assert get_in(bob_event, ["args", Access.at(0), "dispatches", Access.at(0), "id"]) ==
             "bob-dispatch"

    refute_receive {^eve, {:data, _}}, 400
  end
  test "profile, visibility, member, community, note, folder, and tag events use current audiences",
       %{
         target: target
       } do
    vault = Store.create_vault(1, %{name: "Shared"})
    {:ok, _member} = Cascade.Accounts.VaultMembers.add(vault.id, 1, 2, "editor")
    alice = open_probe(target, token(1, "alice"), "alice")
    bob = open_probe(target, token(2, "bob"), "bob")
    eve = open_probe(target, token(3, "eve"), "eve")
    close_on_exit([alice, bob, eve])
    join_vault(alice, vault.id, 1)
    join_vault(bob, vault.id, 2)
    flush_probe(alice)
    flush_probe(bob)
    flush_probe(eve)

    profile = %{id: 1, username: "alice", displayName: "Alice Prime", avatarUrl: "new.png"}
    Events.profile_updated(%{userId: 1, profile: profile})

    assert get_in(await_event(bob, "vault", "vault:userProfileUpdated"), ["args", Access.at(0)]) ==
             stringify(profile)

    refute_receive {^eve, {:data, _}}, 250

    settings = %{vaultId: vault.id, visibility: "public", topics: ["software"]}
    Events.visibility_changed(settings)

    assert get_in(await_event(bob, "vault", "vault:visibilityChanged"), ["args", Access.at(0)]) ==
             stringify(settings)

    Events.install_note_mutation_sink()
    note = Store.create_note(vault.id, 1, %{title: "Realtime note", content: "body"})
    assert Store.get_note(note.id).id == note.id
    assert await_event(bob, "vault", "community:changed")

    Events.emit(%{
      event: "vault:noteCreated",
      noteId: note.id,
      vaultId: vault.id,
      title: note.title
    })

    assert get_in(await_event(bob, "vault", "vault:noteCreated"), ["args", Access.at(0), "noteId"]) ==
             note.id

    Store.add_tag(note.id, vault.id, "realtime", nil, 1)
    assert await_event(bob, "vault", "community:changed")

    folder = Store.create_folder(vault.id, %{name: "Temporary"})
    Store.move_note(note.id, folder.id, nil, 1)
    assert await_event(bob, "vault", "community:changed")
    Store.delete_folder(folder.id, 1)
    assert await_event(bob, "vault", "community:changed")

    SQL.exec("DELETE FROM vault_members WHERE vault_id=? AND user_id=2", [vault.id])

    Events.vault_event(vault.id, "vault:chatPresence", %{
      vaultId: vault.id,
      online: ["alice"]
    })

    assert await_event(bob, "vault", "vault:chatPresence")
    assert joined?("vault:#{vault.id}", 2)

    Events.members_changed(%{vaultId: vault.id})
    assert await_event(alice, "vault", "vault:membersChanged")
    assert eventually(fn -> not joined?("vault:#{vault.id}", 2) end)
    refute_receive {^bob, {:data, _}}, 350
  end
end
