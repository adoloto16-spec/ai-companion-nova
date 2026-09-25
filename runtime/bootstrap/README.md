# Runtime Bootstrap

The composition root owns concrete fake modules/providers and assembles Core services. Core never imports this package.

The Foundation runtime is intentionally offline and uses fake implementations until real providers/drivers are added.
