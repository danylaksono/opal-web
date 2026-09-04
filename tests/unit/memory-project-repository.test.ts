import { describe, it } from "vitest";
import { MemoryProjectRepository } from "@/platform/memory/project-repository";
import { repositoryContract } from "../support/repository-contract";

/**
 * The shared contract, run under vitest.
 *
 * The same cases run against OPFS in `tests/e2e/repository-contract.spec.ts`.
 * Wiring them to a test framework here rather than in the contract module is
 * what keeps that module loadable in a browser.
 */
describe("MemoryProjectRepository (ProjectRepository contract)", () => {
  for (const testCase of repositoryContract) {
    it(testCase.name, async () => {
      await testCase.run(
        new MemoryProjectRepository({
          // A clock that always moves, so "most recently opened" is
          // deterministic rather than dependent on how fast the test ran.
          now: (() => {
            let tick = 0;
            return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
          })(),
        }),
      );
    });
  }
});
