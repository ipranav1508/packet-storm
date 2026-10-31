namespace PacketStorm.Sim;

/// <summary>
/// Own tiny xorshift generator so results never depend on the runtime's Random implementation.
/// Same seed + same commands always replays to the exact same game.
/// </summary>
public sealed class Rng
{
    uint state;

    public Rng(int seed)
    {
        state = unchecked((uint)seed * 2654435761u + 0x9E3779B9u);
        if (state == 0) state = 1;
        for (int i = 0; i < 4; i++) Next();
    }

    public uint Next()
    {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return state;
    }

    public double Double() => Next() / 4294967296.0;
    public int Range(int min, int maxExclusive) => min + (int)(Next() % (uint)(maxExclusive - min));
}

public static class Geo
{
    public static double Hypot(double x, double y) => Math.Sqrt(x * x + y * y);
}
