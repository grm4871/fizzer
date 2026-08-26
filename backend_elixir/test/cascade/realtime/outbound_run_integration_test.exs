defmodule Cascade.Realtime.OutboundRunIntegrationTest do
  @moduledoc "Durable run event ordering and namespace disconnect contracts."
  use ExUnit.Case, async: false
  import Cascade.Realtime.OutboundIntegrationSupport
  alias Cascade.Content.Store
  alias Cascade.Realtime.{Events, Hub}
  alias Cascade.Runs.Store, as: RunStore

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
  test "run events are durable before a real subscribed client observes them", %{target: target} do
    vault = Store.create_vault(1, %{name: "Runs"})
    client = open_probe(target, token(1, "alice"), "alice")
    close_on_exit([client])

    {:ok, run} =
      RunStore.start(vault.id, nil, "prove ordering", "codex", owner_user_id: 1)

    command(client, "runs", "joinRun", [run.id])
    assert eventually(fn -> joined?("run:#{run.id}", 1, "/runs") end)
    flush_probe(client)

    event = RunStore.publish(run.id, "trace", %{text: "persisted"})
    assert Enum.any?(RunStore.events(run.id), &(&1.id == event.id and &1.seq == event.seq))

    observed = await_event(client, "runs", "event")
    assert get_in(observed, ["args", Access.at(0), "id"]) == event.id
    assert get_in(observed, ["args", Access.at(0), "seq"]) == event.seq

    assert get_in(observed, ["args", Access.at(0), "payload_json"]) ==
             Jason.encode!(%{text: "persisted"})

    1..40
    |> Task.async_stream(
      fn value -> RunStore.publish(run.id, "trace", %{value: value}) end,
      max_concurrency: 8,
      ordered: false,
      timeout: 5_000
    )
    |> Enum.each(fn result ->
      assert {:ok, event} = result
      assert event.run_id == run.id
    end)

    observed_sequences =
      Enum.map(1..40, fn _ ->
        event = await_event(client, "runs", "event")
        get_in(event, ["args", Access.at(0), "seq"])
      end)

    assert observed_sequences == Enum.to_list(3..42)

    Events.disconnect_user(1)
    assert await_disconnect(client, "vault")
    assert await_disconnect(client, "runs")
    assert eventually(fn -> Hub.room_members("user:1", "/vault") == [] end)
    assert eventually(fn -> Hub.room_members("user:1", "/runs") == [] end)
  end
end
