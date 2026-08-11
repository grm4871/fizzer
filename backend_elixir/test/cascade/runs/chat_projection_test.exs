defmodule Cascade.Runs.ChatProjectionTest do
  use ExUnit.Case, async: true

  alias Cascade.Runs.ChatProjection

  test "folds visible text, structured blocks, harness output, and final summaries" do
    content =
      ChatProjection.build([
        event("status", %{status: "queued"}),
        event("text", %{
          message: %{
            content: [
              %{type: "thinking", thinking: "checking"},
              %{type: "text", text: "draft "},
              %{type: "tool_use", id: "tool-1", name: "Read", input: %{path: "a"}}
            ]
          }
        }),
        event("text", %{
          chatVisible: true,
          message: %{
            content: [
              %{type: "text", text: "answer"},
              %{type: "tool_use", id: "tool-1", name: "Read", input: %{path: "b"}}
            ]
          }
        }),
        event("harness", %{data: "trace"}),
        event("status", %{status: "completed", summary: "Final answer"})
      ])

    assert content.body == "Final answer"
    assert content.harnessLog == "trace"
    assert content.status == nil
    assert content.terminal_status == "completed"
    assert content.done
    assert Enum.at(content.blocks, 1) == %{type: "text", text: "draft "}
    assert Enum.at(content.blocks, 2).input == %{"path" => "b"}
    assert Enum.at(content.blocks, 3) == %{type: "text", text: "answer"}
  end

  test "preserves useful work on failure and honors suppressed terminal shells" do
    failed =
      ChatProjection.build([
        event("text", %{chatVisible: true, message: %{content: "partial work"}}),
        event("status", %{status: "failed", summary: "usage limit"})
      ])

    assert failed.body == "partial work\n\n> ⚠️ usage limit"
    assert failed.status == "failed"
    assert failed.terminal_status == "failed"

    suppressed =
      ChatProjection.build([
        event("text", %{chatVisible: true, message: %{content: "duplicate"}}),
        event("status", %{status: "canceled", suppressChatBody: true})
      ])

    assert suppressed.body == ""
    assert suppressed.done
  end

  defp event(type, payload),
    do: %{type: type, payload_json: Jason.encode!(payload)}
end
