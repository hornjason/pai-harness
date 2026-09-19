# Testing Guide

## Test Structure

- Use `describe` blocks to group related tests
- Use `test` for individual assertions
- Name tests as "should [expected behavior]"
- One assertion per test when possible

## Test Coverage

- Every public function must have at least one test
- Test both happy path and error cases
- Test edge cases: empty strings, zero values, null inputs
- Test boundary conditions for numeric inputs

## Test Patterns

- Arrange-Act-Assert pattern for all tests
- Use factories for test data creation
- Avoid shared mutable state between tests
- Clean up side effects in afterEach hooks
