# Security policy

Reins coordinates processes and tools but does not itself guarantee
operating-system sandboxing. Each adapter must document its filesystem,
network, shell, authentication, and approval behavior accurately.

Do not put credentials in process arguments, persisted events, test fixtures,
or diagnostics. Host applications should construct explicit environment maps
instead of forwarding their complete environment to provider processes.

Please report vulnerabilities privately through GitHub's security advisory
flow for this repository.

