defmodule Cascade.Accounts.AndroidBattery do
  @moduledoc "Validated Android process battery telemetry with user scoping and 30-day retention."

  alias Cascade.Accounts.SQL

  @reasons ~w(launch interval background resume)
  @safe_max 9_007_199_254_740_991

  def parse(body) when is_map(body) do
    session_id = body |> value("sessionId") |> stringify() |> String.trim()
    reason = body |> value("reason") |> stringify()

    cond do
      session_id == "" or String.length(session_id) > 80 ->
        {:error, "Invalid sessionId"}

      reason not in @reasons ->
        {:error, "Invalid reason"}

      true ->
        with {:ok, captured_at} <- integer(value(body, "capturedAt"), "capturedAt", 1, @safe_max),
             {:ok, elapsed} <-
               integer(value(body, "elapsedRealtimeMs"), "elapsedRealtimeMs", 0, @safe_max),
             {:ok, cpu} <- integer(value(body, "processCpuMs"), "processCpuMs", 0, @safe_max),
             {:ok, rx} <- integer(value(body, "uidRxBytes"), "uidRxBytes", -1, @safe_max),
             {:ok, tx} <- integer(value(body, "uidTxBytes"), "uidTxBytes", -1, @safe_max),
             {:ok, thermal} <-
               optional_integer(value(body, "thermalStatus"), "thermalStatus", 0, 10),
             {:ok, level} <- optional_integer(value(body, "levelPercent"), "levelPercent", 0, 100),
             {:ok, counter} <-
               optional_integer(
                 value(body, "chargeCounterUah"),
                 "chargeCounterUah",
                 -100_000_000,
                 100_000_000
               ),
             {:ok, current} <-
               optional_integer(
                 value(body, "currentNowUa"),
                 "currentNowUa",
                 -100_000_000,
                 100_000_000
               ),
             {:ok, average} <-
               optional_integer(
                 value(body, "currentAverageUa"),
                 "currentAverageUa",
                 -100_000_000,
                 100_000_000
               ) do
          {:ok,
           %{
             sessionId: session_id,
             reason: reason,
             foreground: value(body, "foreground") == true,
             capturedAt: captured_at,
             elapsedRealtimeMs: elapsed,
             processCpuMs: cpu,
             uidRxBytes: rx,
             uidTxBytes: tx,
             powerSave: value(body, "powerSave") == true,
             thermalStatus: thermal,
             levelPercent: level,
             chargeCounterUah: counter,
             currentNowUa: current,
             currentAverageUa: average,
             charging: boolean_or_nil(value(body, "charging"))
           }}
        end
    end
  end

  def parse(_), do: {:error, "Invalid battery sample"}

  def record(user_id, sample) do
    SQL.exec(
      """
      INSERT INTO android_battery_samples (
        user_id,session_id,reason,foreground,captured_at,elapsed_realtime_ms,process_cpu_ms,
        uid_rx_bytes,uid_tx_bytes,power_save,thermal_status,level_percent,charge_counter_uah,
        current_now_ua,current_average_ua,charging
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      """,
      [
        user_id,
        sample.sessionId,
        sample.reason,
        flag(sample.foreground),
        sample.capturedAt,
        sample.elapsedRealtimeMs,
        sample.processCpuMs,
        sample.uidRxBytes,
        sample.uidTxBytes,
        flag(sample.powerSave),
        sample.thermalStatus,
        sample.levelPercent,
        sample.chargeCounterUah,
        sample.currentNowUa,
        sample.currentAverageUa,
        nullable_flag(sample.charging)
      ]
    )

    SQL.exec("DELETE FROM android_battery_samples WHERE received_at<datetime('now','-30 days')")
    :ok
  end

  def list(user_id, days \\ 7) do
    bounded_days = bounded_days(days)

    {where_user, params} =
      if is_nil(user_id),
        do: {"", ["-#{bounded_days} days"]},
        else: {"AND user_id=?", ["-#{bounded_days} days", user_id]}

    SQL.all(
      """
      SELECT id,user_id,session_id,reason,foreground,captured_at,received_at,elapsed_realtime_ms,
        process_cpu_ms,uid_rx_bytes,uid_tx_bytes,power_save,thermal_status,level_percent,
        charge_counter_uah,current_now_ua,current_average_ua,charging
      FROM android_battery_samples WHERE received_at>=datetime('now',?) #{where_user}
      ORDER BY captured_at DESC LIMIT 5000
      """,
      params
    )
    |> Enum.map(&map_sample/1)
  end

  defp integer(value, name, min, max) when is_number(value) do
    rounded = round(value)

    if rounded < min or rounded > max,
      do: {:error, "#{name} is out of range"},
      else: {:ok, rounded}
  rescue
    _ -> {:error, "#{name} must be a number"}
  end

  defp integer(_value, name, _min, _max), do: {:error, "#{name} must be a number"}
  defp optional_integer(nil, _name, _min, _max), do: {:ok, nil}
  defp optional_integer(value, name, min, max), do: integer(value, name, min, max)

  defp bounded_days(value) when is_integer(value), do: value |> max(1) |> min(30)
  defp bounded_days(value) when is_float(value), do: value |> floor() |> bounded_days()
  defp bounded_days(_value), do: 7

  defp map_sample([
         id,
         user_id,
         session_id,
         reason,
         foreground,
         captured_at,
         received_at,
         elapsed,
         cpu,
         rx,
         tx,
         power_save,
         thermal,
         level,
         counter,
         current,
         average,
         charging
       ]) do
    %{
      id: id,
      userId: user_id,
      sessionId: session_id,
      reason: reason,
      foreground: foreground != 0,
      capturedAt: captured_at,
      receivedAt: received_at,
      elapsedRealtimeMs: elapsed,
      processCpuMs: cpu,
      uidRxBytes: rx,
      uidTxBytes: tx,
      powerSave: power_save != 0,
      thermalStatus: thermal,
      levelPercent: level,
      chargeCounterUah: counter,
      currentNowUa: current,
      currentAverageUa: average,
      charging: decode_flag(charging)
    }
  end

  defp value(map, key), do: Map.get(map, key, Map.get(map, String.to_atom(key)))
  defp stringify(nil), do: ""
  defp stringify(value), do: to_string(value)
  defp boolean_or_nil(value) when is_boolean(value), do: value
  defp boolean_or_nil(_), do: nil
  defp flag(true), do: 1
  defp flag(_), do: 0
  defp nullable_flag(nil), do: nil
  defp nullable_flag(value), do: flag(value)
  defp decode_flag(nil), do: nil
  defp decode_flag(value), do: value != 0
end
