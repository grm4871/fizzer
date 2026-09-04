defmodule Cascade.PrivacyTest do
  use ExUnit.Case, async: true

  alias Cascade.Privacy

  test "placeholder text does not exempt surrounding private content from redaction" do
    marker = "[Private block hidden from agents. id=p123-1]"

    for redact <- [&Privacy.redact_private_blocks/1, &Cascade.Content.Privacy.redact_blocks/1] do
      placeholder = ":::private\n#{marker}\n:::"
      assert redact.(placeholder) == placeholder

      for body <- ["secret\n#{marker}", "#{marker}\nsecret", "#{marker} secret"],
          closing <- ["\n:::", ""] do
        redacted = redact.(":::private\n#{body}#{closing}")
        refute redacted =~ "secret"
        assert redact.(redacted) == redacted
      end
    end
  end

  test "canonical IDs retain the UTF-16 hash and lowercase HTTP contract" do
    content = "before\n:::private\nsecret 🚀\n:::\nafter"
    expected = "before\n:::private\n[Private block hidden from agents. id=p105qmdv-1]\n:::\nafter"

    assert Privacy.redact_private_blocks(content) == expected
    assert Cascade.Content.Privacy.redact_blocks(content) == expected
  end

  test "content parser preserves block boundaries, IDs, and round trips across line endings" do
    for newline <- ["\n", "\r\n"], ending <- ["", newline] do
      content =
        Enum.join(
          [
            "public 🚀",
            " \t:::PRIVATE ",
            "secret α",
            "\t::: ",
            "between",
            ":::private",
            "secret β",
            ":::"
          ],
          newline
        ) <> ending

      redacted = Cascade.Content.Privacy.redact_blocks(content)
      refute redacted =~ "secret"
      assert redacted =~ "public 🚀#{newline}"
      assert redacted =~ "\nbetween#{newline}"
      assert String.ends_with?(redacted, ":::" <> if(ending == "", do: "", else: "\n"))
      assert Cascade.Content.Privacy.redact_blocks(redacted) == redacted
      assert Cascade.Content.Privacy.restore_blocks(content, redacted) == content

      assert Regex.scan(~r/id=p[a-z0-9]+-(\d+)/i, redacted, capture: :all_but_first) == [
               ["1"],
               ["2"]
             ]
    end
  end

  test "content parser handles long public prefixes and an unterminated final block" do
    prefix = String.duplicate("public line\n", 10_000)
    content = prefix <> ":::private\nfirst\n:::\n:::private\nlast\r"
    redacted = Cascade.Content.Privacy.redact_blocks(content)
    assert String.starts_with?(redacted, prefix)
    refute redacted =~ "first"
    refute redacted =~ "last"
    assert Cascade.Content.Privacy.restore_blocks(content, redacted) == content
    assert Cascade.Content.Privacy.redact_blocks("") == ""
    assert Cascade.Content.Privacy.redact_blocks("plain\r") == "plain\r"
  end

  test "both legacy ID casings restore exact Unicode and CRLF bytes" do
    existing = "public İ 🚀\r\n \t:::private \r\nsecret α 🚀\r\n\t::: \r\nafter"
    canonical = Cascade.Content.Privacy.redact_blocks(existing)

    legacy =
      Regex.replace(~r/id=p([^\]]+)/, canonical, fn _, hash -> "id=p#{String.upcase(hash)}" end)

    refute legacy == canonical

    for incoming <- [canonical, legacy] do
      assert Cascade.Content.Privacy.restore_blocks(existing, incoming) == existing
      assert Privacy.redact_private_blocks(incoming) == incoming
    end

    for {source, incoming} <- [
          {existing, canonical <> canonical},
          {existing, legacy <> legacy},
          {existing, canonical <> legacy},
          {existing, canonical <> "[Private block hidden from agents. id=pUNKNOWN-1]"},
          {existing, legacy <> "[Private block hidden from agents. id=pUNKNOWN-1]"},
          {"public", legacy}
        ] do
      assert_raise ArgumentError, fn ->
        Cascade.Content.Privacy.restore_blocks(source, incoming)
      end
    end
  end

  test "existing placeholder IDs remain stable and restore without rescanning inserted raw blocks" do
    for id <- ["pABC123-1", "pabc123-1"] do
      existing = ":::PRIVATE\r\n[Private block hidden from agents. id=#{id}]\r\n:::"
      assert Privacy.redact_private_blocks(existing) == existing
      assert Cascade.Content.Privacy.restore_blocks(existing, existing) == existing
    end

    second = ":::private\nsecond secret\n:::"
    second_marker = Cascade.Content.Privacy.redact_blocks(":::private\nfirst\n:::\n" <> second)
    [_, marker] = String.split(second_marker, ":::\n:::private\n")
    existing = ":::private\nfirst secret\n" <> marker <> "\n" <> second
    redacted = Privacy.redact_private_blocks(existing)
    assert Cascade.Content.Privacy.restore_blocks(existing, redacted) == existing
  end

  test "all outbound facades sanitize nested outputs and Unicode previews identically" do
    value = %{
      "items" => [%{content: ":::PRIVATE\r\nsecret 🚀\r\n:::"}],
      "content_preview" => "İ public :::PRIVATEsuffix secret",
      nested: %{content_preview: "🚀 :::private secret", count: 1}
    }

    expected = Cascade.Content.Privacy.sanitize_json(value)
    assert Privacy.sanitize_agent_json(value) == expected
    assert CascadeWeb.Authorization.sanitize_agent_json(value) == expected
    assert expected["content_preview"] == "İ public [Private block hidden from agents]"
    assert expected.nested.content_preview == "🚀 [Private block hidden from agents]"
    refute inspect(expected) =~ "secret"
    assert Privacy.sanitize_agent_json(expected) == expected

    note = %{file_path: "/private/note.md", content: ":::PRIVATE\nsecret\n:::"}
    refute Map.has_key?(Cascade.Content.Privacy.redact_note(note, false), :file_path)
    safe = Cascade.Content.Privacy.redact_note(note, true)
    refute Map.has_key?(safe, :file_path)
    refute safe.content =~ "secret"
  end

  test "unterminated blocks fail closed and existing placeholders remain stable" do
    redacted = Privacy.redact_private_blocks("public\n:::private\nsecret forever")
    refute redacted =~ "secret forever"
    assert redacted =~ "Private block hidden from agents"
    assert Privacy.redact_private_blocks(redacted) == redacted
  end
end
