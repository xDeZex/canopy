# Coding Standards

Read this before making changes. The code-review skill checks changes against it.

## Match the surroundings

Code, tests, and docs should look like the code, tests, and docs around them. Before adding or changing something, read its neighbours and follow their naming, structure, comment density, and idioms. Consistency with the surrounding code beats personal preference.

## Prefer functional code

Functions should preferably be functional: they compute their result from their inputs and have no side effects. Keep side effects (IO, mutation of shared state, calls to external systems) at the edges, and keep the logic in pure functions that the edges call.

## Tests

- Test functions by giving them inputs and checking the outputs. This is the preferred shape for a test.
- Tests should not exercise external dependencies or IO (filesystem, network, git, the clock, and so on).
- Where a test can't avoid them, mocking is acceptable. Better still is to write the code so the logic is separate from the IO, which makes mocking unnecessary. If a test needs a mock, consider first whether the code should be restructured.

### Integration tests

A test that uses real IO (a scratch git repo, a real file watcher, a listening HTTP server) is an integration test. Keep only a few, each covering the thin glue that unit tests can't reach, such as one smoke test per module.

- Name them `<module>.integration.test.js`, next to the module, so they are easy to find and count.
- They run as part of `npm test`. If they become numerous or slow enough to hurt that, split them out into their own script.
- Don't use one to check logic that a pure function could check with inputs and outputs. Extract the function and test that.
