defmodule Cascade.PrivacyTest do
  use ExUnit.Case, async: true

  alias Cascade.Privacy

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
