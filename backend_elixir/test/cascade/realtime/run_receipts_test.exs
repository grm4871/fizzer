defmodule Cascade.Realtime.RunReceiptsTest do
  use ExUnit.Case, async: false
  alias Cascade.Realtime.DomainAdapter
  alias Cascade.Runs.Store

  setup do
    ctx = Cascade.TestHelpers.owner_vault("run-receipts")

    {:ok, run} =
      Store.start(ctx.vault_id, nil, "Receipt test", "codex", owner_user_id: ctx.user_id)

    Store.record_delegated(run.id, ctx.user_id)
    Map.put(ctx, :run, run)
  end

  defp terminal(ctx, status \\ "completed") do
    DomainAdapter.handle_event(
      "/runners",
      "runner:runEvent",
      [
        %{
          runId: ctx.run.id,
          type: "status",
          receipt: true,
          payload: %{status: status, summary: "Verified result"}
        }
      ],
      %{id: ctx.user_id},
      %{}
    )
  end

  test "a lost receipt replays idempotently after delegation ownership is cleared", ctx do
    assert {:ok, [{:ack, [%{success: true}]}]} = terminal(ctx)
    assert Store.get(ctx.run.id).status == "completed"
    assert Store.get(ctx.run.id).summary == "Verified result"
    assert is_nil(Store.delegated_owner(ctx.run.id))
    events = Store.events(ctx.run.id)
    assert {:ok, [{:ack, [%{success: true}]}]} = terminal(ctx)
    assert Store.events(ctx.run.id) == events
    assert {:error, "Run event rejected"} = terminal(%{ctx | user_id: ctx.user_id + 1})
  end

  test "receipt repairs finish-before-publish without reversing an authoritative stop", ctx do
    Store.finish(ctx.run.id, "canceled", "User stopped it")
    assert {:ok, [{:ack, [%{success: true}]}]} = terminal(ctx)
    assert Store.get(ctx.run.id).status == "canceled"
    final = Store.events(ctx.run.id) |> List.last()
    assert Jason.decode!(final.payload_json)["status"] == "canceled"
    assert Jason.decode!(final.payload_json)["summary"] == "User stopped it"
  end
end
