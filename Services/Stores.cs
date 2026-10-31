using System.Text.Json;
using PacketStorm.Sim;

namespace PacketStorm.Services;

public sealed record ReplayRecord(string Id, string Name, int Seed, int Score, int Wave, int Kills, bool Victory, List<LoggedCommand> Commands, DateTime At);
public sealed record LeaderboardEntry(string Name, int Score, int Wave, int Kills, bool Victory, string ReplayId, DateTime At);

/// <summary>
/// Leaderboard + replay files on disk (JSON). Each leaderboard row points at a replay that the server
/// can re-simulate to verify the score. Swap this one class for SQL Server / MongoDB / Postgres.
/// </summary>
public sealed class RunStore
{
    const int KeepTop = 20;
    readonly string dir, boardPath;
    readonly object gate = new();
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public RunStore(IWebHostEnvironment env)
    {
        dir = Path.Combine(env.ContentRootPath, "data", "replays");
        Directory.CreateDirectory(dir);
        boardPath = Path.Combine(env.ContentRootPath, "data", "leaderboard.json");
    }

    public List<LeaderboardEntry> Top(int count = 10)
    {
        lock (gate) return LoadBoard().OrderByDescending(e => e.Score).Take(count).ToList();
    }

    /// <summary>Saves the replay only if the run makes the top list; old replays outside the list are pruned.</summary>
    public void Submit(ReplayRecord replay)
    {
        lock (gate)
        {
            var board = LoadBoard();
            board.Add(new LeaderboardEntry(replay.Name, replay.Score, replay.Wave, replay.Kills, replay.Victory, replay.Id, replay.At));
            var top = board.OrderByDescending(e => e.Score).Take(KeepTop).ToList();
            if (top.Any(e => e.ReplayId == replay.Id))
                File.WriteAllText(ReplayPath(replay.Id), JsonSerializer.Serialize(replay, Json));
            File.WriteAllText(boardPath, JsonSerializer.Serialize(top, Json));

            var keep = top.Select(e => e.ReplayId).ToHashSet();
            foreach (var file in Directory.GetFiles(dir, "*.json"))
                if (!keep.Contains(Path.GetFileNameWithoutExtension(file))) File.Delete(file);
        }
    }

    public ReplayRecord? LoadReplay(string id)
    {
        if (!IsSafeId(id)) return null;
        lock (gate)
        {
            string path = ReplayPath(id);
            return File.Exists(path) ? JsonSerializer.Deserialize<ReplayRecord>(File.ReadAllText(path), Json) : null;
        }
    }

    static bool IsSafeId(string id) => id.Length is > 0 and <= 40 && id.All(char.IsAsciiLetterOrDigit);
    string ReplayPath(string id) => Path.Combine(dir, id + ".json");

    List<LeaderboardEntry> LoadBoard()
    {
        try
        {
            return File.Exists(boardPath)
                ? JsonSerializer.Deserialize<List<LeaderboardEntry>>(File.ReadAllText(boardPath), Json) ?? new()
                : new();
        }
        catch (JsonException)
        {
            return new();
        }
    }
}

public static class Replayer
{
    /// <summary>Re-simulates a recorded run from its seed + command log, headless and as fast as possible.</summary>
    public static Simulation Run(ReplayRecord r)
    {
        var sim = new Simulation(r.Seed);
        int i = 0;
        int guard = 30 * 60 * 90;   // never loop more than 90 game-minutes
        while (!sim.IsOver && guard-- > 0)
        {
            while (i < r.Commands.Count && r.Commands[i].Tick <= sim.Tick) sim.Apply(r.Commands[i++].Cmd);
            sim.Step();
        }
        return sim;
    }
}
