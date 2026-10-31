namespace PacketStorm.Sim;

/// <summary>A player input. Only these (plus the seed) are needed to replay a run exactly.</summary>
public sealed record Command(string T, int Pad = 0, int Kind = 0, int Id = 0, double X = 0, double Y = 0, bool Fire = false);

public sealed record LoggedCommand(int Tick, Command Cmd);

public sealed class Enemy
{
    public int Id;
    public EnemyKind Kind;
    public double Hp, MaxHp, S, X, Y, SlowMul = 1;
}

public sealed class Tower
{
    public int Id, Pad, Level = 1, Invested;
    public TowerKind Kind;
    public double X, Y, Cooldown, Angle;
}

public sealed class Projectile
{
    public int Id;
    public double X, Y, Vx, Vy, Travelled;
}

/// <summary>
/// Deterministic, fixed-step (30 Hz) simulation of the whole game. No wall-clock, no I/O.
/// The server runs it live, replays re-run it from the command log, and the self-test runs it headless.
/// </summary>
public sealed class Simulation
{
    readonly Rng rng;
    readonly List<Enemy> enemies = new();
    readonly List<Tower> towers = new();
    readonly List<Projectile> projectiles = new();
    readonly List<(int Tick, EnemyKind Kind)> spawnQueue = new();
    readonly List<object[]> fx = new();
    readonly double[] segLength;
    readonly double pathLength;

    List<(int Delay, EnemyKind Kind)> nextPlan;
    int nextId = 1;
    int intermission = Defs.IntermissionTicks / 2;
    int operatorCooldown;
    int flushCooldown;
    double aimX = Defs.Width / 2, aimY = 200;
    bool fire;

    public Simulation(int seed)
    {
        Seed = seed;
        rng = new Rng(seed);
        segLength = new double[Defs.Path.Length - 1];
        for (int i = 0; i < segLength.Length; i++)
        {
            var (ax, ay) = Defs.Path[i];
            var (bx, by) = Defs.Path[i + 1];
            segLength[i] = Geo.Hypot(bx - ax, by - ay);
            pathLength += segLength[i];
        }
        Credits = Defs.StartCredits;
        Core = Defs.StartCore;
        nextPlan = BuildWave(1);
    }

    public int Seed { get; }
    public int Tick { get; private set; }
    public int Wave { get; private set; }            // wave currently (or last) spawned; 0 before the first
    public bool WaveActive { get; private set; }
    public int Credits { get; private set; }
    public int Core { get; private set; }
    public int Kills { get; private set; }
    public int Leaks { get; private set; }
    public int Score { get; private set; }
    public bool IsOver { get; private set; }
    public bool Victory { get; private set; }
    public IReadOnlyList<Enemy> Enemies => enemies;
    public IReadOnlyList<Tower> Towers => towers;

    // ------------------------------------------------------------------------------ commands
    /// <summary>Applies one input. Returns true if it changed the game (so it should be logged).</summary>
    public bool Apply(Command c)
    {
        if (IsOver) return false;
        switch (c.T)
        {
            case "aim":
            {
                double x = Math.Clamp(c.X, 0, Defs.Width), y = Math.Clamp(c.Y, 0, Defs.Height);
                if (x == aimX && y == aimY && c.Fire == fire) return false;
                aimX = x; aimY = y; fire = c.Fire;
                return true;
            }
            case "build": return Build(c.Pad, c.Kind);
            case "upgrade": return Upgrade(c.Id);
            case "sell": return Sell(c.Id);
            case "flush": return Flush(c.X, c.Y);
            case "nextwave": return CallNextWave();
            default: return false;
        }
    }

    bool Build(int pad, int kindIndex)
    {
        if (pad < 0 || pad >= Defs.Pads.Length || kindIndex < 0 || kindIndex >= Defs.Towers.Length) return false;
        if (towers.Any(t => t.Pad == pad)) return Reject("That pad is already in use.");
        var def = Defs.Towers[kindIndex];
        if (Credits < def.Cost) return Reject($"Not enough credits ({def.Cost} needed).");
        Credits -= def.Cost;
        var (x, y) = Defs.Pads[pad];
        towers.Add(new Tower { Id = nextId++, Pad = pad, Kind = (TowerKind)kindIndex, X = x, Y = y, Invested = def.Cost, Angle = -Math.PI / 2 });
        fx.Add(new object[] { "build", x, y });
        return true;
    }

    bool Upgrade(int id)
    {
        var t = towers.FirstOrDefault(x => x.Id == id);
        if (t is null) return false;
        if (t.Level >= 3) return Reject("Already at max level.");
        int cost = Defs.UpgradeCost(Defs.Towers[(int)t.Kind], t.Level);
        if (Credits < cost) return Reject($"Not enough credits ({cost} needed).");
        Credits -= cost;
        t.Invested += cost;
        t.Level++;
        fx.Add(new object[] { "build", t.X, t.Y });
        return true;
    }

    bool Sell(int id)
    {
        var t = towers.FirstOrDefault(x => x.Id == id);
        if (t is null) return false;
        Credits += Defs.SellValue(t.Invested);
        towers.Remove(t);
        fx.Add(new object[] { "boom", t.X, t.Y, 26.0, "sell" });
        return true;
    }

    bool Flush(double x, double y)
    {
        if (flushCooldown > 0) return Reject("Flush is recharging.");
        flushCooldown = Defs.FlushCooldownTicks;
        x = Math.Clamp(x, 0, Defs.Width);
        y = Math.Clamp(y, 0, Defs.Height);
        fx.Add(new object[] { "flush", x, y, Defs.FlushRadius });
        foreach (var e in enemies.ToList())
            if (Geo.Hypot(e.X - x, e.Y - y) <= Defs.FlushRadius + Defs.Enemies[(int)e.Kind].Radius)
                e.Hp -= Defs.FlushDamage;
        return true;
    }

    bool CallNextWave()
    {
        if (WaveActive || Wave >= Defs.MaxWave) return false;
        int bonus = intermission / Defs.TickRate * 2;   // 2 credits per second skipped
        Credits += bonus;
        intermission = 0;
        return true;
    }

    bool Reject(string message)
    {
        fx.Add(new object[] { "msg", message });
        return false;
    }

    // ------------------------------------------------------------------------------ stepping
    public void Step()
    {
        if (IsOver) return;
        Tick++;

        UpdateWaves();
        ApplySlows();
        MoveEnemies();
        FireTowers();
        FireOperator();
        MoveProjectiles();
        ReapDead();
        if (flushCooldown > 0) flushCooldown--;
        CheckWaveCleared();

        if (Core <= 0) { Core = 0; IsOver = true; Victory = false; }
        if (IsOver) Score = ComputeScore();
    }

    int ComputeScore() => Wave * 100 + Kills * 3 + Credits / 10 + Core * 5 + (Victory ? 1000 : 0);

    void UpdateWaves()
    {
        if (!WaveActive)
        {
            if (Wave >= Defs.MaxWave) return;
            if (--intermission <= 0) StartWave();
            return;
        }
        while (spawnQueue.Count > 0 && spawnQueue[0].Tick <= Tick)
        {
            Spawn(spawnQueue[0].Kind);
            spawnQueue.RemoveAt(0);
        }
    }

    void StartWave()
    {
        Wave++;
        WaveActive = true;
        int at = Tick;
        foreach (var (delay, kind) in nextPlan)
        {
            at += delay;
            spawnQueue.Add((at, kind));
        }
        bool boss = nextPlan.Any(p => p.Kind == EnemyKind.Botnet);
        fx.Add(new object[] { "wave", Wave, boss });
        nextPlan = Wave < Defs.MaxWave ? BuildWave(Wave + 1) : new();
    }

    void Spawn(EnemyKind kind)
    {
        var def = Defs.Enemies[(int)kind];
        double hp = def.Hp * Defs.HpScale(Wave);
        var (x, y) = Defs.Path[0];
        enemies.Add(new Enemy { Id = nextId++, Kind = kind, Hp = hp, MaxHp = hp, S = 0, X = x, Y = y });
    }

    /// <summary>Builds the spawn plan for a wave from a threat budget. Deterministic via the sim RNG.</summary>
    List<(int Delay, EnemyKind Kind)> BuildWave(int wave)
    {
        var plan = new List<(int, EnemyKind)>();
        int budget = 14 + 13 * wave;
        if (wave % 5 == 0)
        {
            plan.Add((2 * Defs.TickRate, EnemyKind.Botnet));
            budget -= 40;
        }
        var pool = new List<EnemyKind> { EnemyKind.Bot, EnemyKind.Bot };
        if (wave >= 2) pool.Add(EnemyKind.Swarm);
        if (wave >= 3) pool.Add(EnemyKind.Injection);
        if (wave >= 5) pool.Add(EnemyKind.ZeroDay);
        if (wave >= 7) pool.Add(EnemyKind.Ransomware);

        int guard = 0;
        while (budget > 0 && guard++ < 400)
        {
            var kind = pool[rng.Range(0, pool.Count)];
            var def = Defs.Enemies[(int)kind];
            if (kind == EnemyKind.Swarm)
            {
                int burst = Math.Min(6, Math.Max(1, budget / def.Threat));
                for (int i = 0; i < burst; i++) plan.Add((i == 0 ? 20 : 8, kind));
                budget -= burst * def.Threat;
            }
            else
            {
                int gap = kind switch
                {
                    EnemyKind.Bot => 20,
                    EnemyKind.Injection => 30,
                    EnemyKind.ZeroDay => 24,
                    EnemyKind.Ransomware => 55,
                    _ => 25,
                };
                plan.Add((gap, kind));
                budget -= def.Threat;
            }
        }
        return plan;
    }

    public IReadOnlyDictionary<string, int> NextWaveCounts()
    {
        var d = new Dictionary<string, int>();
        foreach (var (_, kind) in nextPlan)
        {
            string name = Defs.Enemies[(int)kind].Name;
            d[name] = d.GetValueOrDefault(name) + 1;
        }
        return d;
    }

    void ApplySlows()
    {
        foreach (var e in enemies) e.SlowMul = 1;
        foreach (var t in towers.Where(t => t.Kind == TowerKind.RateLimiter))
        {
            double range = Defs.TowerRange(Defs.Towers[(int)t.Kind], t.Level);
            double mul = Defs.SlowMultiplier(t.Level);
            foreach (var e in enemies)
            {
                if (Defs.Enemies[(int)e.Kind].SlowImmune) continue;
                if (Geo.Hypot(e.X - t.X, e.Y - t.Y) <= range) e.SlowMul = Math.Min(e.SlowMul, mul);
            }
        }
    }

    void MoveEnemies()
    {
        foreach (var e in enemies.ToList())
        {
            var def = Defs.Enemies[(int)e.Kind];
            e.S += def.Speed * e.SlowMul * Defs.Dt;
            if (e.S >= pathLength)
            {
                Core -= def.CoreDamage;
                Leaks++;
                if (e.Kind == EnemyKind.Ransomware) Credits = Math.Max(0, Credits - 60);
                var (cx, cy) = Defs.Path[^1];
                fx.Add(new object[] { "leak", cx, cy, def.CoreDamage });
                enemies.Remove(e);
                continue;
            }
            (e.X, e.Y) = PositionAt(e.S);
        }
    }

    (double X, double Y) PositionAt(double s)
    {
        for (int i = 0; i < segLength.Length; i++)
        {
            if (s <= segLength[i] || i == segLength.Length - 1)
            {
                double f = segLength[i] == 0 ? 0 : Math.Min(1, s / segLength[i]);
                var (ax, ay) = Defs.Path[i];
                var (bx, by) = Defs.Path[i + 1];
                return (ax + (bx - ax) * f, ay + (by - ay) * f);
            }
            s -= segLength[i];
        }
        return Defs.Path[^1];
    }

    void FireTowers()
    {
        foreach (var t in towers)
        {
            var def = Defs.Towers[(int)t.Kind];
            if (t.Kind == TowerKind.RateLimiter) continue;
            if (t.Cooldown > 0) t.Cooldown -= Defs.Dt;

            double range = Defs.TowerRange(def, t.Level);
            Enemy? target = null;
            foreach (var e in enemies)
            {
                if (e.Hp <= 0 || Geo.Hypot(e.X - t.X, e.Y - t.Y) > range) continue;
                if (target is null) { target = e; continue; }
                bool better = t.Kind == TowerKind.Waf ? e.Hp > target.Hp : e.S > target.S;
                if (better) target = e;
            }
            if (target is null) continue;
            t.Angle = Math.Atan2(target.Y - t.Y, target.X - t.X);
            if (t.Cooldown > 0) continue;

            t.Cooldown = Defs.TowerInterval(def, t.Level);
            double dmg = Defs.TowerDamage(def, t.Level);
            if (t.Kind == TowerKind.LoadBalancer)
            {
                fx.Add(new object[] { "beam", t.X, t.Y, target.X, target.Y, (int)t.Kind });
                fx.Add(new object[] { "boom", target.X, target.Y, Defs.LoadBalancerSplash, "lb" });
                foreach (var e in enemies)
                    if (Geo.Hypot(e.X - target.X, e.Y - target.Y) <= Defs.LoadBalancerSplash)
                        e.Hp -= dmg * Defs.Matchup(t.Kind, e.Kind);
            }
            else
            {
                target.Hp -= dmg * Defs.Matchup(t.Kind, target.Kind);
                fx.Add(new object[] { "beam", t.X, t.Y, target.X, target.Y, (int)t.Kind });
            }
        }
    }

    void FireOperator()
    {
        if (operatorCooldown > 0) operatorCooldown--;
        if (!fire || operatorCooldown > 0) return;
        double dx = aimX - Defs.OperatorX, dy = aimY - Defs.OperatorY;
        double len = Geo.Hypot(dx, dy);
        if (len < 1) return;
        operatorCooldown = Defs.OperatorCooldownTicks;
        projectiles.Add(new Projectile
        {
            Id = nextId++,
            X = Defs.OperatorX,
            Y = Defs.OperatorY,
            Vx = dx / len * Defs.OperatorSpeed,
            Vy = dy / len * Defs.OperatorSpeed,
        });
    }

    void MoveProjectiles()
    {
        foreach (var p in projectiles.ToList())
        {
            double stepX = p.Vx * Defs.Dt, stepY = p.Vy * Defs.Dt;
            p.X += stepX;
            p.Y += stepY;
            p.Travelled += Geo.Hypot(stepX, stepY);

            Enemy? hit = null;
            foreach (var e in enemies)
            {
                if (e.Hp <= 0) continue;
                if (Geo.Hypot(e.X - p.X, e.Y - p.Y) <= Defs.Enemies[(int)e.Kind].Radius + 5) { hit = e; break; }
            }
            if (hit is not null)
            {
                hit.Hp -= Defs.OperatorDamage;
                fx.Add(new object[] { "boom", p.X, p.Y, 10.0, "hit" });
                projectiles.Remove(p);
            }
            else if (p.Travelled > Defs.OperatorRange || p.X < -20 || p.X > Defs.Width + 20 || p.Y < -20 || p.Y > Defs.Height + 20)
            {
                projectiles.Remove(p);
            }
        }
    }

    void ReapDead()
    {
        foreach (var e in enemies.Where(e => e.Hp <= 0).ToList())
        {
            var def = Defs.Enemies[(int)e.Kind];
            Credits += (int)Math.Round(def.Reward * 0.7);
            Kills++;
            fx.Add(new object[] { "kill", e.X, e.Y, (int)e.Kind, def.Reward });
            enemies.Remove(e);
        }
    }

    void CheckWaveCleared()
    {
        if (!WaveActive || spawnQueue.Count > 0 || enemies.Count > 0) return;
        WaveActive = false;
        int bonus = 20 + 4 * Wave;
        Credits += bonus;
        fx.Add(new object[] { "clear", Wave, bonus });
        if (Wave >= Defs.MaxWave)
        {
            Victory = true;
            IsOver = true;
        }
        else intermission = Defs.IntermissionTicks;
    }

    // ------------------------------------------------------------------------------ snapshot
    static double R(double v) => Math.Round(v, 1);

    /// <summary>Compact state for the browser. Draining the fx list means skipped ticks (fast replay) keep their effects.</summary>
    public object Snapshot(bool paused = false)
    {
        var snap = new
        {
            type = "state",
            tick = Tick,
            wave = Wave,
            maxWave = Defs.MaxWave,
            waveActive = WaveActive,
            intermission = WaveActive ? 0 : (int)Math.Ceiling(intermission / (double)Defs.TickRate),
            core = Core,
            credits = Credits,
            score = IsOver ? Score : ComputeScore(),
            kills = Kills,
            flush = R(1.0 - flushCooldown / (double)Defs.FlushCooldownTicks),
            paused,
            over = IsOver,
            victory = Victory,
            next = NextWaveCounts(),
            enemies = enemies.Select(e => new object[] { e.Id, (int)e.Kind, R(e.X), R(e.Y), R(Math.Max(0, e.Hp) / e.MaxHp), e.SlowMul < 1 ? 1 : 0 }).ToList(),
            towers = towers.Select(t => new object[] { t.Id, (int)t.Kind, t.Pad, t.Level, R(t.Angle), R(Math.Clamp(t.Cooldown / Math.Max(0.01, Defs.TowerInterval(Defs.Towers[(int)t.Kind], t.Level)), 0, 1)) }).ToList(),
            shots = projectiles.Select(p => new object[] { p.Id, R(p.X), R(p.Y) }).ToList(),
            fx = fx.ToList(),
        };
        fx.Clear();
        return snap;
    }
}
