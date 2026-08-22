# Runtime Contract

Private, in-process client boundary for Kite Runtime. RMV1-02 exposes only a
versioned boundary descriptor; production commands, queries, and subscriptions
remain owned by the legacy runtime until their scheduled cutover.
