defmodule Cascade.Scratchpad do
  @moduledoc """
  Stable public interface for persistent agent scratchpad operations.

  Focused modules own journal, thread, recall, skill, and injection policy while
  this facade keeps existing controller and CLI calls unchanged. Journal and
  thread rows are append/SQL authoritative; injections are privacy-redacted and
  bounded by their requested character budget.
  """
  alias Cascade.Scratchpad.{Injection, Journal, Recall, Schema, Skills, Support, Threads}

  @doc "Installs scratchpad tables and removes orphaned note statistics."
  def ensure_schema, do: Schema.ensure_schema()
  @doc "Deletes outcome statistics for one note."
  def delete_note_stats(note_id), do: Schema.delete_note_stats(note_id)
  @doc "Appends a bounded, typed journal entry."
  def append_journal_entry(user_id, vault_id, input), do: Journal.append_journal_entry(user_id, vault_id, input)
  @doc "Lists journal entries in ascending id order."
  def list_journal_entries(user_id, vault_id, opts \\ []), do: Journal.list_journal_entries(user_id, vault_id, opts)
  @doc "Marks journal entries through an id as consolidated."
  def mark_journal_consolidated(user_id, vault_id, opts), do: Journal.mark_journal_consolidated(user_id, vault_id, opts)
  @doc "Reports unconsolidated journal and open-thread state."
  def status(vault_id, agent_key \\ nil), do: Journal.status(vault_id, agent_key)
  @doc "Lists open private threads."
  def list_open_threads(user_id, vault_id, opts \\ []), do: Threads.list_open_threads(user_id, vault_id, opts)
  @doc "Opens a bounded private thread."
  def open_thread(user_id, vault_id, input), do: Threads.open_thread(user_id, vault_id, input)
  @doc "Closes one private thread, idempotently."
  def close_open_thread(user_id, vault_id, opts), do: Threads.close_open_thread(user_id, vault_id, opts)
  @doc "Recalls scoped privacy-redacted notes by lexical relevance."
  def recall(user_id, vault_id, input), do: Recall.recall(user_id, vault_id, input)
  @doc "Ensures an agent skills folder exists."
  def ensure_skills_folder(vault_id, user_id, agent_key), do: Skills.ensure_skills_folder(vault_id, user_id, agent_key)
  @doc "Creates or updates a skill note."
  def create_skill_note(user_id, vault_id, input), do: Skills.create_skill_note(user_id, vault_id, input)
  @doc "Lists scoped skill notes ordered by outcome quality."
  def list_skill_notes(user_id, vault_id, agent_key \\ nil), do: Skills.list_skill_notes(user_id, vault_id, agent_key)
  @doc "Records a note outcome and updates its score."
  def record_note_outcome(user_id, vault_id, input), do: Skills.record_note_outcome(user_id, vault_id, input)
  @doc "Returns note outcome statistics keyed by note id."
  def note_stats(vault_id), do: Skills.note_stats(vault_id)
  @doc "Promotes an agent note to the shared scope."
  def promote_note(user_id, vault_id, input), do: Skills.promote_note(user_id, vault_id, input)
  @doc "Creates the default policy note when absent."
  def ensure_policies(vault_id, user_id, agent_key), do: Injection.ensure_policies(vault_id, user_id, agent_key)
  @doc "Builds bounded scratchpad boot instructions and context."
  def build_injection(vault_id, opts \\ []), do: Injection.build_injection(vault_id, opts)
  @doc "Formats outcome statistics for human-readable injection."
  def format_win_record(stats), do: Support.format_win_record(stats)
end
