defmodule Cascade.Evolution do
  @moduledoc """
  Stable public interface for chat evolution features.

  Policy lives in focused backlink, distillation, and memory modules while this
  facade preserves the domain API used by controllers, CLI commands, and agents.
  SQL remains authoritative for backlinks, jobs, and memory settings.
  """

  alias Cascade.Evolution.{Backlinks, Distillation, Memory, Schema}

  @doc "Creates the evolution tables and indexes; safe to call repeatedly."
  def ensure_schema, do: Schema.ensure_schema()

  @doc "Extracts de-duplicated wiki-link titles in source order."
  def extract_wiki_titles(body), do: Backlinks.extract_wiki_titles(body)

  @doc "Indexes wiki links in one chat message."
  def index_chat_message_backlinks(vault_id, channel_id, message),
    do: Backlinks.index_chat_message_backlinks(vault_id, channel_id, message)

  @doc "Marks all backlinks from a message as deleted without removing history."
  def tombstone_chat_message_backlinks(message_id),
    do: Backlinks.tombstone_chat_message_backlinks(message_id)

  @doc "Re-resolves unresolved backlinks for a newly-created note title."
  def reresolve_chat_backlinks(vault_id, note_id, title),
    do: Backlinks.reresolve_chat_backlinks(vault_id, note_id, title)

  @doc "Lists backlinks with bounded pagination and optional tombstones."
  def list_chat_note_backlinks(note_id, opts \\ []),
    do: Backlinks.list_chat_note_backlinks(note_id, opts)

  @doc "Indexes a bounded batch of historical chat messages."
  def backfill_chat_note_backlinks(vault_id, opts \\ []),
    do: Backlinks.backfill_chat_note_backlinks(vault_id, opts)

  @doc "Distills selected chat messages into a new or existing note."
  def distill_chat_to_note(user_id, vault_id, channel_id, input),
    do: Distillation.distill_chat_to_note(user_id, vault_id, channel_id, input)

  @doc "Ensures shared agent memory folders and their index note exist."
  def ensure_agent_memory_folders(vault_id, user_id),
    do: Memory.ensure_agent_memory_folders(vault_id, user_id)

  @doc "Ensures named agent memory folders and their index note exist."
  def ensure_agent_named_memory_folders(vault_id, user_id, agent_key),
    do: Memory.ensure_agent_named_memory_folders(vault_id, user_id, agent_key)

  @doc "Returns whether memory injection is enabled for a vault."
  def agent_memory_enabled?(vault_id), do: Memory.agent_memory_enabled?(vault_id)

  @doc "Enables or disables memory injection for a vault."
  def set_agent_memory_enabled(vault_id, enabled),
    do: Memory.set_agent_memory_enabled(vault_id, enabled)

  @doc "Builds privacy-redacted, budget-bounded memory injection text."
  def build_agent_memory_injection(vault_id, opts \\ []),
    do: Memory.build_agent_memory_injection(vault_id, opts)

  @doc "Creates a memory note and prepends a pointer to its folder index."
  def create_agent_memory_note(user_id, vault_id, input),
    do: Memory.create_agent_memory_note(user_id, vault_id, input)
end
