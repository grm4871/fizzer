defmodule CascadeWeb.OrchestrationController do
  @moduledoc "Public orchestration endpoint facade; route signatures remain stable while run, chat-run, work-item, and managed-agent seams evolve independently."

  defdelegate list_runs(conn, vault_id), to: CascadeWeb.OrchestrationRunController
  defdelegate active_sessions(conn, vault_id), to: CascadeWeb.OrchestrationRunController
  defdelegate my_active_sessions(conn), to: CascadeWeb.OrchestrationRunController
  defdelegate local_agents(conn), to: CascadeWeb.OrchestrationRunController
  defdelegate create_run(conn, vault_id), to: CascadeWeb.OrchestrationRunController
  defdelegate get_run(conn, raw_id), to: CascadeWeb.OrchestrationRunController
  defdelegate run_events(conn, raw_id), to: CascadeWeb.OrchestrationRunController
  defdelegate runner_status(conn), to: CascadeWeb.OrchestrationRunController
  defdelegate cancel_run(conn, raw_id), to: CascadeWeb.OrchestrationRunController

  defdelegate managed_entitlement(conn, vault_id), to: CascadeWeb.OrchestrationManagedAgentController
  defdelegate update_managed_entitlement(conn, vault_id), to: CascadeWeb.OrchestrationManagedAgentController

  defdelegate list_work_items(conn, vault_id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate create_work_item(conn, vault_id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate get_work_item(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate update_work_item(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate report_git_state(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate lease_work_item(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate release_work_item(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate link_work_item_run(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate handoff_work_item(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate review_work_item(conn, id), to: CascadeWeb.OrchestrationWorkItemController
  defdelegate stop_work_item(conn, id), to: CascadeWeb.OrchestrationWorkItemController
end
