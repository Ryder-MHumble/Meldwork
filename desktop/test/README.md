# Desktop Tests

Desktop tests mirror the source domains under `desktop/src`. Keep a test next to
the domain it verifies, and put reusable fixtures or process harnesses in
`test/support` rather than copying them into individual suites.

The test runner discovers `*.test.cjs` recursively. Use a focused suite while
iterating, then run the complete suite before delivery:

```sh
npm run test:agents
npm run test:runs
npm run test:workspace
npm test
```

Suite selection is defined in `scripts/test-discovery.cjs`. Add a new domain to
`TEST_SUITES` when it needs an independent, repeatable test command.
