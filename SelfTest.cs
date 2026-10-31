using PacketStorm.Services;
using PacketStorm.Sim;

namespace PacketStorm;

/// <summary>Headless checks: map sanity, rules, determinism, replay verification and balance sweeps with bots.</summary>
public static class SelfTest
{
    static int failures;

    static void Check(bool ok, string what)
    {
        Console.WriteLine($"  [{(ok ? "PASS" : "FAIL")}] {what}");
        if (!ok) failures++;
    }

    public static int Run()
    {
        Console.WriteLine("== Map & rules ==");
        MapChecks();
        RuleChecks();

        Console.WriteLine("\n== Balance sweep (bots, 6 seeds) ==");
        Console.WriteLine("seed | idle | towers-only | +operator wave score kills core victory | replay-verified");
        foreach (int seed in new[] { 1, 2, 3, 4, 5, 6 })
        {
            var idle = new Simulation(seed);
            while (!idle.IsOver && idle.Tick < 30 * 60 * 30) idle.Step();

            var (towersOnly, _) = PlayBot(seed, operatorOn: false);
            var (sim, log) = PlayBot(seed);
            var record = new ReplayRecord("t", "bot", seed, sim.Score, sim.Wave, sim.Kills, sim.Victory, log, DateTime.UtcNow);
            var again = Replayer.Run(record);
            bool same = again.Score == sim.Score && again.Wave == sim.Wave && again.Kills == sim.Kills;
            Console.WriteLine($"{seed,4} | {idle.Wave,4} | {towersOnly.Wave,11} | {sim.Wave,13} {sim.Score,6} {sim.Kills,6} {sim.Core,4} {sim.Victory,7} | {(same ? "yes" : "NO")}");
            Check(idle.IsOver && idle.Wave <= 8, $"seed {seed}: doing nothing loses early (wave {idle.Wave})");
            Check(same, $"seed {seed}: replaying the command log reproduces the identical result");
            Check(sim.Wave >= 8, $"seed {seed}: a simple bot gets past wave 8 (reached {sim.Wave})");
        }

        var (a, _) = PlayBot(42);
        var (b, _) = PlayBot(42);
        Check(a.Score == b.Score && a.Tick == b.Tick, "same seed + same inputs => identical final score and tick");

        Console.WriteLine(failures == 0 ? "\nAll checks passed." : $"\n{failures} check(s) FAILED.");
        return failures == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------------ checks
    static double DistanceToPath(double px, double py)
    {
        double best = double.MaxValue;
        for (int i = 0; i < Defs.Path.Length - 1; i++)
        {
            var (ax, ay) = Defs.Path[i];
            var (bx, by) = Defs.Path[i + 1];
            double dx = bx - ax, dy = by - ay;
            double t = Math.Clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
            best = Math.Min(best, Geo.Hypot(px - (ax + t * dx), py - (ay + t * dy)));
        }
        return best;
    }

    static void MapChecks()
    {
        Check(Defs.Pads.All(p => DistanceToPath(p.X, p.Y) >= 45), "every build pad sits at least 45 px off the enemy path");
        Check(Defs.Pads.All(p => p.X is > 0 and < Defs.Width && p.Y is > 0 and < Defs.Height), "every pad is inside the playfield");
        bool spaced = true;
        for (int i = 0; i < Defs.Pads.Length; i++)
            for (int j = i + 1; j < Defs.Pads.Length; j++)
                if (Geo.Hypot(Defs.Pads[i].X - Defs.Pads[j].X, Defs.Pads[i].Y - Defs.Pads[j].Y) < 60) spaced = false;
        Check(spaced, "pads never overlap each other");
    }

    static void RuleChecks()
    {
        var s = new Simulation(1);
        int credits = s.Credits;
        Check(s.Apply(new Command("build", Pad: 0, Kind: 0)) && s.Credits == credits - Defs.Towers[0].Cost, "building spends the tower's cost");
        Check(!s.Apply(new Command("build", Pad: 0, Kind: 1)), "a pad can only hold one tower");
        var tower = s.Towers[0];
        int before = s.Credits;
        s.Apply(new Command("upgrade", Id: tower.Id));
        Check(tower.Level == 2 && s.Credits < before, "upgrading raises the level and costs credits");
        int cash = s.Credits;
        s.Apply(new Command("sell", Id: tower.Id));
        Check(s.Towers.Count == 0 && s.Credits > cash, "selling removes the tower and refunds part of the investment");

        var f = new Simulation(2);
        Check(f.Apply(new Command("flush", X: 300, Y: 300)), "flush fires when ready");
        Check(!f.Apply(new Command("flush", X: 300, Y: 300)), "flush is on cooldown right after use");

        Check(Defs.Matchup(TowerKind.Waf, EnemyKind.Injection) > Defs.Matchup(TowerKind.Firewall, EnemyKind.Injection),
              "WAF beats firewall against SQL injection");
        Check(Defs.Enemies[(int)EnemyKind.ZeroDay].SlowImmune, "zero-days are immune to the rate limiter");

        var r1 = new Rng(7); var r2 = new Rng(7);
        Check(Enumerable.Range(0, 50).All(_ => r1.Next() == r2.Next()), "RNG is reproducible");
    }

    // ------------------------------------------------------------------ bot
    static (Simulation Sim, List<LoggedCommand> Log) PlayBot(int seed, bool operatorOn = true)
    {
        var sim = new Simulation(seed);
        var log = new List<LoggedCommand>();
        var order = Enumerable.Range(0, Defs.Pads.Length)
            .OrderByDescending(i => Coverage(Defs.Pads[i].X, Defs.Pads[i].Y)).ToList();
        var recipe = new[] { TowerKind.Firewall, TowerKind.RateLimiter, TowerKind.Firewall, TowerKind.Waf, TowerKind.LoadBalancer, TowerKind.Firewall, TowerKind.Waf, TowerKind.LoadBalancer };
        int step = 0;

        void Do(Command c)
        {
            if (sim.Apply(c)) log.Add(new LoggedCommand(sim.Tick, c));
        }

        while (!sim.IsOver && sim.Tick < 30 * 60 * 40)
        {
            if (sim.Tick % 15 == 0)
            {
                if (step < order.Count)
                {
                    var kind = recipe[step % recipe.Length];
                    if (sim.Credits >= Defs.Towers[(int)kind].Cost) { Do(new Command("build", Pad: order[step], Kind: (int)kind)); step++; }
                }
                else
                {
                    var t = sim.Towers.Where(x => x.Level < 3).OrderBy(x => x.Level).FirstOrDefault();
                    if (t is not null) Do(new Command("upgrade", Id: t.Id));
                }
            }

            // manual cannon: aim at the enemy closest to the core
            var target = operatorOn ? sim.Enemies.OrderByDescending(e => e.S).FirstOrDefault() : null;
            if (target is not null) Do(new Command("aim", X: Math.Round(target.X / 4) * 4, Y: Math.Round(target.Y / 4) * 4, Fire: true));
            else if (operatorOn) Do(new Command("aim", X: Defs.Width / 2, Y: 200, Fire: false));

            if (operatorOn && sim.Tick % 30 == 0 && sim.Enemies.Count(e => Defs.Enemies[(int)e.Kind].Threat >= 5 && e.S > 400) >= 1)
            {
                var big = sim.Enemies.OrderByDescending(e => e.Hp).First();
                Do(new Command("flush", X: big.X, Y: big.Y));
            }
            sim.Step();
        }
        return (sim, log);
    }

    static int Coverage(double x, double y)
    {
        int n = 0;
        for (int i = 0; i < Defs.Path.Length - 1; i++)
        {
            var (ax, ay) = Defs.Path[i];
            var (bx, by) = Defs.Path[i + 1];
            double len = Geo.Hypot(bx - ax, by - ay);
            for (double d = 0; d < len; d += 10)
            {
                double px = ax + (bx - ax) * d / len, py = ay + (by - ay) * d / len;
                if (Geo.Hypot(px - x, py - y) < 120) n++;
            }
        }
        return n;
    }
}
