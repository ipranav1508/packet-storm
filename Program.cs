using System.Text.Json;
using PacketStorm;
using PacketStorm.Services;
using PacketStorm.Sim;

// `dotnet run -- --selftest` runs the determinism / replay / balance checks headless and exits.
if (args.Contains("--selftest")) return SelfTest.Run();

var builder = WebApplication.CreateBuilder(args);
if (Environment.GetEnvironmentVariable("ASPNETCORE_URLS") is null && !args.Any(a => a.StartsWith("--urls")))
    builder.WebHost.UseUrls("http://localhost:5090");
builder.Services.AddSingleton<RunStore>();

var app = builder.Build();
app.UseWebSockets();
app.UseDefaultFiles();
app.UseStaticFiles();

// Static game data for the client, so the browser never hard-codes balance numbers.
app.MapGet("/api/config", () => Results.Ok(new
{
    width = Defs.Width,
    height = Defs.Height,
    maxWave = Defs.MaxWave,
    path = Defs.Path.Select(p => new[] { p.X, p.Y }),
    pads = Defs.Pads.Select(p => new[] { p.X, p.Y }),
    op = new { x = Defs.OperatorX, y = Defs.OperatorY },
    towers = Defs.Towers.Select((t, i) => new
    {
        id = i, name = t.Name, cost = t.Cost, range = t.Range, blurb = t.Blurb,
        upgrade = new[] { Defs.UpgradeCost(t, 1), Defs.UpgradeCost(t, 2) },
        rangeByLevel = new[] { Defs.TowerRange(t, 1), Defs.TowerRange(t, 2), Defs.TowerRange(t, 3) },
    }),
    enemies = Defs.Enemies.Select((e, i) => new { id = i, name = e.Name, radius = e.Radius, blurb = e.Blurb }),
    flushRadius = Defs.FlushRadius,
}));

app.MapGet("/api/leaderboard", (RunStore store) => Results.Ok(store.Top()));

// Re-simulate a stored run from seed + commands and report the score it really produces.
app.MapGet("/api/replays/{id}/verify", (string id, RunStore store) =>
{
    var replay = store.LoadReplay(id);
    if (replay is null) return Results.NotFound(new { ok = false, message = "Replay not found." });
    var sim = Replayer.Run(replay);
    return Results.Ok(new { ok = true, verified = sim.IsOver && sim.Score == replay.Score, claimed = replay.Score, recomputed = sim.Score, commands = replay.Commands.Count });
});

app.Map("/ws/play", async (HttpContext ctx, RunStore store) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
    int seed = int.TryParse(ctx.Request.Query["seed"], out var s) ? s : Random.Shared.Next(1, 1_000_000);
    string name = ctx.Request.Query["name"].ToString().Trim();
    name = string.IsNullOrEmpty(name) ? "Operator" : name[..Math.Min(name.Length, 20)];
    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    await Sessions.RunLive(ws, seed, name, store, ctx.RequestAborted);
});

app.Map("/ws/replay", async (HttpContext ctx, RunStore store) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = 400; return; }
    var replay = store.LoadReplay(ctx.Request.Query["id"].ToString());
    if (replay is null) { ctx.Response.StatusCode = 404; return; }
    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    await Sessions.RunReplay(ws, replay, ctx.RequestAborted);
});

app.Run();
return 0;
