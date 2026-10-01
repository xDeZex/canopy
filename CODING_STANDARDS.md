# Coding Standards

Read this before making changes. The code-review skill checks changes against it.

## Match the surroundings

Code, tests, and docs should look like the code, tests, and docs around them. Before adding or changing something, read its neighbours and follow their naming, structure, comment density, and idioms. Consistency with the surrounding code beats personal preference.

## Prefer functional code

Functions should preferably be functional: they compute their result from their inputs and have no side effects. Keep side effects (IO, mutation of shared state, calls to external systems) at the edges, and keep the logic in pure functions that the edges call.

## Tests

- Think about the testing trophy when deciding on test seams: favour a few static checks at the base, a thin layer of unit tests for pure logic, the bulk of tests as integration tests that cover several units working together through a public seam, and very few end-to-end tests. Pick the seam where a test gives the most confidence about behaviour, not the one closest to each function. Integration tests here wire real units together and fake only the IO edge.
- Test functions by giving them inputs and checking the outputs. This is the preferred shape for a test.
- Tests should not exercise external dependencies or IO (filesystem, network, git, the clock, and so on).
- Where a test can't avoid them, mocking is acceptable. Better still is to write the code so the logic is separate from the IO, which makes mocking unnecessary. If a test needs a mock, consider first whether the code should be restructured.
