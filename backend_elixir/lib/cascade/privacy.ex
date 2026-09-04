defmodule Cascade.Privacy do
  @moduledoc """
  Compatibility facade for the canonical content privacy engine.

  Outbound redaction now also matches mixed-case private openers and preview
  prefixes, matching the stronger content-domain policy. New IDs use lowercase
  base-36 hashes; restoration accepts both legacy ID casings.
  """

  defdelegate sanitize_agent_json(value), to: Cascade.Content.Privacy, as: :sanitize_json
  defdelegate redact_private_blocks(content), to: Cascade.Content.Privacy, as: :redact_blocks
  defdelegate redact_private_preview(content), to: Cascade.Content.Privacy, as: :redact_preview
end
