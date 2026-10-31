using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using PacketStorm.Sim;

namespace PacketStorm.Services;

/// <summary>
/// One WebSocket = one isolated game (multi-tenant by construction). The server owns the simulation;
/// the browser sends commands and renders the snapshots it gets back at 30 Hz.
/// </summary>
public static class Sessions
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    static readonly TimeSpan Tick = TimeSpan.FromSeconds(1.0 / Defs.TickRate);

    public static async Task RunLive(WebSocket ws, int seed, string name, RunStore store, CancellationToken ct)
    {
        var sim = new Simulation(seed);
        var inbox = new ConcurrentQueue<Command>();
        var log = new List<LoggedCommand>();
        bool paused = false;
        var receiver = ReceiveCommands(ws, inbox, ct);

        using var timer = new PeriodicTimer(Tick);
        try
        {
            while (ws.State == WebSocketState.Open && await timer.WaitForNextTickAsync(ct))
            {
                while (inbox.TryDequeue(out var cmd))
                {
                    if (cmd.T == "pause") paused = !paused;
                    else if (sim.Apply(cmd)) log.Add(new LoggedCommand(sim.Tick, cmd));
                }
                if (!paused) sim.Step();

                await Send(ws, sim.Snapshot(paused), ct);
                if (sim.IsOver) break;
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }

        if (sim.IsOver)
        {
            var replay = new ReplayRecord(Guid.NewGuid().ToString("N")[..12], name, seed, sim.Score, sim.Wave, sim.Kills, sim.Victory, log, DateTime.UtcNow);
            store.Submit(replay);
            await TrySend(ws, new { type = "over", score = sim.Score, wave = sim.Wave, kills = sim.Kills, victory = sim.Victory, replayId = replay.Id }, ct);
        }
        await CloseQuietly(ws);
    }

    public static async Task RunReplay(WebSocket ws, ReplayRecord replay, CancellationToken ct)
    {
        var sim = new Simulation(replay.Seed);
        var inbox = new ConcurrentQueue<Command>();
        var receiver = ReceiveCommands(ws, inbox, ct);
        int speed = 1, next = 0;
        bool paused = false;

        using var timer = new PeriodicTimer(Tick);
        try
        {
            while (ws.State == WebSocketState.Open && await timer.WaitForNextTickAsync(ct))
            {
                while (inbox.TryDequeue(out var cmd))
                {
                    if (cmd.T == "speed") speed = cmd.Id is 1 or 2 or 4 or 8 ? cmd.Id : 1;
                    else if (cmd.T == "pause") paused = !paused;
                }
                for (int i = 0; i < speed && !paused && !sim.IsOver; i++)
                {
                    while (next < replay.Commands.Count && replay.Commands[next].Tick <= sim.Tick) sim.Apply(replay.Commands[next++].Cmd);
                    sim.Step();
                }
                await Send(ws, sim.Snapshot(paused), ct);
                if (sim.IsOver) break;
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }

        if (sim.IsOver) await TrySend(ws, new { type = "over", score = sim.Score, wave = sim.Wave, kills = sim.Kills, victory = sim.Victory, replayId = replay.Id, replay = true }, ct);
        await CloseQuietly(ws);
    }

    static async Task ReceiveCommands(WebSocket ws, ConcurrentQueue<Command> inbox, CancellationToken ct)
    {
        var buffer = new byte[2048];
        try
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await ws.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (!result.EndOfMessage || result.Count == 0) continue;   // ignore oversized frames
                if (inbox.Count > 300) continue;                           // basic flood protection
                try
                {
                    var cmd = JsonSerializer.Deserialize<Command>(buffer.AsSpan(0, result.Count), Json);
                    if (cmd is not null && cmd.T.Length <= 12) inbox.Enqueue(cmd);
                }
                catch (JsonException) { /* malformed input is ignored */ }
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
    }

    static Task Send(WebSocket ws, object payload, CancellationToken ct) =>
        ws.SendAsync(JsonSerializer.SerializeToUtf8Bytes(payload, Json), WebSocketMessageType.Text, true, ct);

    static async Task TrySend(WebSocket ws, object payload, CancellationToken ct)
    {
        try { if (ws.State == WebSocketState.Open) await Send(ws, payload, ct); }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
    }

    static async Task CloseQuietly(WebSocket ws)
    {
        try
        {
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException) { }
    }
}
