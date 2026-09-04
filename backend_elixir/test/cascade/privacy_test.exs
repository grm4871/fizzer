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

  test "matches Node placeholder IDs including UTF-16 surrogate pairs" do
    content = "before\n:::private\nsecret 🚀\n:::\nafter"

    assert Privacy.redact_private_blocks(content) ==
             "before\n:::private\n[Private block hidden from agents. id=p105qmdv-1]\n:::\nafter"
  end

  test "unterminated blocks fail closed and existing placeholders remain stable" do
    redacted = Privacy.redact_private_blocks("public\n:::private\nsecret forever")
    refute redacted =~ "secret forever"
    assert redacted =~ "Private block hidden from agents"
    assert Privacy.redact_private_blocks(redacted) == redacted
  end
end
