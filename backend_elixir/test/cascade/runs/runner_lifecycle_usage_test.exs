defmodule Cascade.Runs.RunnerLifecycleUsageTest do
  use ExUnit.Case, async: false

  alias Cascade.Runs.RunnerLifecycle

  test "keeps the last successful provider snapshot across probe errors" do
    owner_id = System.unique_integer([:positive])

    RunnerLifecycle.report_plan_usage(owner_id, %{
      "claude-code" => %{
        status: "ok",
        usedPercent: 100,
        extraUsageAvailable: false,
        fetchedAt: "2026-08-14T22:00:00Z"
      }
    })

    assert %{
             "claude-code" => %{
               status: "ok",
               usedPercent: 100.0,
               extraUsageAvailable: false,
               fetchedAt: "2026-08-14T22:00:00Z"
             }
           } = RunnerLifecycle.plan_usage(owner_id)

    RunnerLifecycle.report_plan_usage(owner_id, %{
      "claude-code" => %{
        status: "error",
        detail: "Claude usage endpoint returned 429",
        fetchedAt: "2026-08-14T22:05:00Z"
      }
    })

    assert %{
             "claude-code" => %{
               status: "ok",
               usedPercent: 100.0,
               extraUsageAvailable: false,
               fetchedAt: "2026-08-14T22:00:00Z"
             }
           } = RunnerLifecycle.plan_usage(owner_id)
  end
end
