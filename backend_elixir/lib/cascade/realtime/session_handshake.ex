defmodule Cascade.Realtime.SessionHandshake do
  @moduledoc "Realtime namespace handshake, token authentication, authorization, and connect callbacks."

  alias Cascade.Realtime.{Auth, Hub, SessionDispatch, SessionRecovery}

  def connect_namespace(%{namespace: namespace} = packet, state) do
    metadata = %{sid: state.sid, auth: Map.get(packet, :data, %{})}

    with true <- namespace in ["/vault", "/runs", "/runners"],
         {:ok, identity, state} <-
           authenticate_namespace(namespace, Map.get(packet, :data, %{}), state),
         {:ok, context} <- SessionDispatch.safe_authorize(state.domain, namespace, identity, metadata) do
      case Hub.join(state.sid, namespace, "user:#{identity.id}") do
        :ok ->
          namespaces =
            Map.put(state.namespaces, namespace, %{identity: identity, context: context})

          reply = %{
            type: :connect,
            namespace: namespace,
            data: %{sid: namespace_sid(state.sid, namespace)}
          }

          case SessionRecovery.enqueue(SessionRecovery.engine_message(reply), %{state | namespaces: namespaces}) do
            {:ok, state} ->
              safe_connected(state.domain, namespace, identity, context, metadata)
              {:ok, state}

            {:error, reason, state} ->
              {:close, reason, state}
          end

        {:error, _reason} ->
          connect_error(namespace, "Realtime room capacity reached", state)
      end
    else
      false -> connect_error(namespace, "Invalid namespace", state)
      {:error, message} -> connect_error(namespace, message, state)
      _ -> connect_error(namespace, "Namespace authorization failed", state)
    end
  end

  def authenticate_namespace(namespace, namespace_auth, state) do
    token = Auth.resolved_token(namespace_auth, state.cookie_token)
    attempted? = MapSet.member?(state.auth_attempted_namespaces, namespace)

    cond do
      is_binary(state.authenticated_token) and token == state.authenticated_token and
        not attempted? and auth_cache_valid?(state) ->
        emit_auth_metric(:cache_hit)

        {:ok, state.authenticated_identity,
         %{
           state
           | auth_attempted_namespaces: MapSet.put(state.auth_attempted_namespaces, namespace)
         }}

      is_binary(state.authenticated_token) ->
        if token == state.authenticated_token do
          full_authenticate(namespace, token, state)
        else
          emit_auth_metric(:conflict)
          {:error, Auth.rejection_message(token)}
        end

      true ->
        full_authenticate(namespace, token, state)
    end
  end

  def full_authenticate(namespace, token, state) do
    emit_auth_metric(:full)

    case Auth.authenticate_token_with_expiration(token) do
      {:ok, identity, expires_at} ->
        {:ok, identity,
         %{
           state
           | authenticated_token: state.authenticated_token || token,
             authenticated_identity: identity,
             authenticated_expires_at: expires_at,
             auth_cache_deadline_ms:
               System.monotonic_time(:millisecond) + state.auth_cache_wave_ms,
             auth_attempted_namespaces: MapSet.put(state.auth_attempted_namespaces, namespace)
         }}

      error ->
        emit_auth_metric(:rejection)
        error
    end
  end

  def auth_cache_valid?(state) do
    is_integer(state.authenticated_expires_at) and
      System.system_time(:second) < state.authenticated_expires_at and
      is_integer(state.auth_cache_deadline_ms) and
      System.monotonic_time(:millisecond) <= state.auth_cache_deadline_ms
  end
  def emit_auth_metric(outcome) do
    :telemetry.execute(
      [:cascade, :realtime, :auth],
      %{count: 1},
      %{outcome: outcome, source: :session}
    )
  end

  def connect_error(namespace, message, state) do
    packet = %{type: :connect_error, namespace: namespace, data: %{message: message}}

    case SessionRecovery.enqueue(SessionRecovery.engine_message(packet), state) do
      {:ok, state} -> {:ok, state}
      {:error, reason, state} -> {:close, reason, state}
    end
  end
  def safe_connected(domain, namespace, identity, context, metadata) do
    if function_exported?(domain, :namespace_connected, 4),
      do: domain.namespace_connected(namespace, identity, context, metadata),
      else: :ok
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end
  def namespace_sid(sid, namespace), do: sid <> Base.url_encode64(namespace, padding: false)
end
