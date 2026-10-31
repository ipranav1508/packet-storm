namespace PacketStorm.Sim;

public enum EnemyKind { Bot = 0, Swarm = 1, Injection = 2, ZeroDay = 3, Ransomware = 4, Botnet = 5 }
public enum TowerKind { Firewall = 0, RateLimiter = 1, Waf = 2, LoadBalancer = 3 }

public sealed record EnemyDef(string Name, double Hp, double Speed, int Reward, int CoreDamage, double Radius, int Threat, bool SlowImmune, string Blurb);
public sealed record TowerDef(string Name, int Cost, double Range, double Damage, double Interval, string Blurb);

/// <summary>Every number that shapes the game. Edit here and re-run to rebalance.</summary>
public static class Defs
{
    public const int TickRate = 30;
    public const double Dt = 1.0 / TickRate;
    public const int MaxWave = 30;
    public const int StartCredits = 220;
    public const int StartCore = 100;
    public const int IntermissionTicks = 8 * TickRate;

    // ---- Map (logical 960 x 600 canvas) ---------------------------------------------------
    public const double Width = 960, Height = 600;

    public static readonly (double X, double Y)[] Path =
    {
        (-30, 90), (180, 90), (180, 320), (420, 320), (420, 150), (680, 150), (680, 470), (930, 470),
    };

    /// <summary>Build pads: generated to sit 50+ px off the path (checked by --selftest).</summary>
    public static readonly (double X, double Y)[] Pads =
    {
        (80, 150), (120, 240), (130, 340), (240, 120), (240, 220), (240, 380), (330, 260), (340, 380),
        (360, 160), (480, 90), (480, 210), (480, 310), (580, 90), (580, 210), (620, 300), (620, 400),
        (640, 510), (680, 90), (740, 210), (740, 370), (740, 530), (830, 410), (840, 530),
    };

    public const double OperatorX = 480, OperatorY = 580;

    // ---- Enemies (index = EnemyKind) -------------------------------------------------------
    public static readonly EnemyDef[] Enemies =
    {
        new("Bot",        32,   56,  5,  1, 11,  3, false, "Plain scripted bot."),
        new("Swarm",      13,  100,  3,  1,  7,  1, false, "DDoS packet. Fast, fragile, comes in bursts."),
        new("SQL Injection", 95, 50, 12, 2, 12,  6, false, "Armoured against firewalls. WAFs shred it."),
        new("Zero-day",   62,  125, 16,  3, 10,  5, true,  "Very fast. Immune to rate limiting."),
        new("Ransomware", 340,  34, 32,  5, 16, 18, false, "Slow tank. Steals credits if it reaches the core."),
        new("Botnet",    1500,  27, 160, 20, 24, 120, false, "Boss. Every fifth wave."),
    };

    // ---- Towers (index = TowerKind) --------------------------------------------------------
    public static readonly TowerDef[] Towers =
    {
        new("Firewall",      60, 125,  8, 0.40, "Rapid single-target fire. Weak against SQL injection."),
        new("Rate Limiter",  70, 115,  0, 0.00, "Slows everything in range. Zero-days ignore it."),
        new("WAF",          120, 195, 42, 1.45, "Long-range sniper. Double damage to SQL injection."),
        new("Load Balancer", 140, 145, 26, 1.60, "Splash damage around the target."),
    };

    public const double LoadBalancerSplash = 58;

    // ---- Operator (the player's manual cannon) --------------------------------------------
    public const double OperatorDamage = 9;
    public const int OperatorCooldownTicks = 7;
    public const double OperatorSpeed = 520;
    public const double OperatorRange = 560;

    // ---- Flush (EMP) ability --------------------------------------------------------------
    public const double FlushRadius = 115;
    public const double FlushDamage = 130;
    public const int FlushCooldownTicks = 22 * TickRate;

    // ---- Scaling ---------------------------------------------------------------------------
    public static double HpScale(int wave) => 1.0 + 0.27 * (wave - 1) + 0.024 * (wave - 1) * (wave - 1);
    public static double TowerDamage(TowerDef d, int level) => d.Damage * (1 + 0.65 * (level - 1));
    public static double TowerRange(TowerDef d, int level) => d.Range * (1 + 0.08 * (level - 1));
    public static double TowerInterval(TowerDef d, int level) => d.Interval * (1 - 0.1 * (level - 1));
    public static double SlowMultiplier(int level) => 0.60 - 0.10 * (level - 1);      // 0.6 / 0.5 / 0.4
    public static int UpgradeCost(TowerDef d, int level) => (int)(d.Cost * 0.75 * level);
    public static int SellValue(int invested) => (int)(invested * 0.6);

    /// <summary>Damage multiplier of a tower against an enemy type.</summary>
    public static double Matchup(TowerKind t, EnemyKind e) => (t, e) switch
    {
        (TowerKind.Firewall, EnemyKind.Injection) => 0.4,
        (TowerKind.Waf, EnemyKind.Injection) => 2.0,
        _ => 1.0,
    };
}
