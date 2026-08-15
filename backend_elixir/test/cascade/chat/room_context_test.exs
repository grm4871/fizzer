defmodule Cascade.Chat.RoomContextTest do
  use ExUnit.Case, async: true

  alias Cascade.Chat.RoomContext

  test "extracts inline SVG before message previews truncate the room delta" do
    svg =
      ~s(<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#111827"/></svg>)

    payload =
      RoomContext.build_context_payload(%{
        messages: [
          %{
            id: "svg-message",
            author: "Chat",
            agentId: "codex",
            registrationId: "source-agent",
            body: "Here is the image: #{svg} followed by an explanation."
          }
        ],
        registrations: [
          %{id: "target-agent", agentId: "codex", mention: "chat3", displayName: "chat"}
        ],
        targetRegistrationId: "target-agent",
        continuation: true,
        cursorMessageId: "cursor",
        maxChars: 1_200
      })

    assert payload.inlineSvgs == [svg]
    assert payload.text =~ "[[@FIZZER_ROOM_INLINE_SVG:1]]"
    refute payload.text =~ "<svg"
    refute payload.text =~ "#111827"
  end

  test "drops extracted SVG sources whose messages fall outside the bounded delta" do
    omitted = ~s(<svg width="1" height="1"><rect width="1" height="1"/></svg>)
    retained = ~s(<svg width="2" height="2"><rect width="2" height="2"/></svg>)

    messages =
      [%{id: "old", author: "Old", body: omitted}] ++
        Enum.map(1..7, &%{id: "filler-#{&1}", author: "User", body: "filler #{&1}"}) ++
        [%{id: "new", author: "New", body: retained}]

    payload =
      RoomContext.build_context_payload(%{
        messages: messages,
        registrations: [],
        targetRegistrationId: "target-agent",
        continuation: true,
        cursorMessageId: "cursor",
        maxChars: 1_200
      })

    assert payload.inlineSvgs == [retained]
    assert payload.text =~ "[[@FIZZER_ROOM_INLINE_SVG:1]]"
    refute payload.text =~ "[[@FIZZER_ROOM_INLINE_SVG:2]]"
  end

  test "includes a peer SVG that finished after the target agent took its prior snapshot" do
    svg = ~s(<svg width="8" height="8"><rect width="8" height="8"/></svg>)

    payload =
      RoomContext.build_context_payload(%{
        messages: [
          %{
            id: "peer-response",
            author: "Chat",
            registrationId: "peer-agent",
            createdAt: "2026-08-14T23:49:23.844946Z",
            activityAt: "2026-08-14T23:49:32.128415Z",
            body: svg
          },
          %{
            id: "target-response",
            author: "chat",
            registrationId: "target-agent",
            createdAt: "2026-08-14T23:49:31.690859Z",
            activityAt: "2026-08-14T23:49:37.100000Z",
            body: "I did not see the still-running response."
          }
        ],
        registrations: [
          %{id: "target-agent", agentId: "codex", mention: "chat3", displayName: "chat"}
        ],
        targetRegistrationId: "target-agent",
        continuation: true,
        cursorMessageId: "cursor",
        maxChars: 1_200
      })

    assert payload.inlineSvgs == [svg]
    assert payload.text =~ "peer-response"
    assert payload.text =~ "[[@FIZZER_ROOM_INLINE_SVG:1]]"
    refute payload.text =~ "I did not see"
  end
end
