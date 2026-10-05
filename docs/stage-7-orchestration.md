# Stage 7 — Task graph and bounded scheduler

Stage 7 adds the smallest orchestration core around the Pi task runner. It owns graph structure and scheduling, not model execution, context compaction, protocol formatting, or planning intelligence.

## Graph

A `TaskNode` has a stable ID, plan version, query, optional parent, dependency IDs, selected guidance/model references, task-owned artifact IDs, and lifecycle status. A graph is valid only when IDs are unique, dependencies exist, and dependencies are acyclic.

The scheduler treats a node as runnable when all dependencies are completed. Independent nodes may run concurrently up to `maxConcurrency`.

## Scheduler

The scheduler receives a graph and an injected task executor (Stage 6's Pi adapter is one implementation). It:

- starts ready tasks;
- records task lifecycle;
- starts newly unblocked tasks;
- preserves task results/errors;
- stops on cancellation;
- does not retry implicitly in this stage;
- returns a graph snapshot and completed results.

Pi owns each task session's message history and compaction. The scheduler only passes the task envelope and selected model to the executor.

## Plan versions and NEWPLAN

`PlanStore` creates immutable-in-practice version snapshots. A `NewPlanRequest` identifies obsolete tasks and preserved artifacts and supplies proposed replacement tasks. Applying it:

1. marks obsolete pending/running tasks as obsolete/cancelled;
2. preserves completed task results/artifact IDs;
3. creates the next plan version;
4. adds proposed tasks with the new version;
5. leaves selection of guidance/model for the caller or a later orchestration coordinator.

No text marker is interpreted as NEWPLAN.

## Non-responsibilities

This slice does not implement planner prompting, decomposition, aggregation, HTTP, retries, artifact persistence, or model/guidance selection. Those depend on this graph/scheduler boundary.

## Acceptance

- Invalid/cyclic graphs are rejected.
- Dependencies control execution order.
- Independent tasks run concurrently but respect the bound.
- Task failures do not falsely complete dependants.
- Cancellation stops new work and cancels active executor calls.
- Plan replacement increments version and preserves selected completed outputs.
- Scheduler execution is testable with a fake executor and can later use `PiTaskRunner`.
