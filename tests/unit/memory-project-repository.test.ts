import { MemoryProjectRepository } from "@/platform/memory/project-repository";
import { describeProjectRepository } from "../support/repository-contract";

describeProjectRepository(
  "MemoryProjectRepository",
  () =>
    new MemoryProjectRepository({
      // A clock that always moves, so "most recently opened" is deterministic
      // rather than dependent on how fast the test ran.
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
      })(),
    }),
);
