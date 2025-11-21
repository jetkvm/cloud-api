<div align="center">
    <img alt="JetKVM logo" src="https://jetkvm.com/logo-blue.png" height="28">

### Cloud API

[Discord](https://jetkvm.com/discord) | [Website](https://jetkvm.com) | [Issues](https://github.com/jetkvm/cloud-api/issues) | [Docs](https://jetkvm.com/docs)

[![Twitter](https://img.shields.io/twitter/url/https/twitter.com/jetkvm.svg?style=social&label=Follow%20%40JetKVM)](https://twitter.com/jetkvm)

</div>

JetKVM is a high-performance, open-source KVM over IP (Keyboard, Video, Mouse) solution designed for efficient remote management of computers, servers, and workstations. Whether you're dealing with boot failures, installing a new operating system, adjusting BIOS settings, or simply taking control of a machine from afar, JetKVM provides the tools to get it done effectively.

## Contributing

We welcome contributions from the community! Whether it's improving the firmware, adding new features, or enhancing documentation, your input is valuable. We also have some rules and taboos here, so please read this page and our [Code of Conduct](/CODE_OF_CONDUCT.md) carefully.

## I need help

The best place to search for answers is our [Documentation](https://jetkvm.com/docs). If you can't find the answer there, check our [Discord Server](https://discord.gg/8MaAhua7NW).

## I want to report an issue

If you've found an issue and want to report it, please check our [Issues](https://github.com/jetkvm/cloud-api/issues) page. Make sure the description contains information about the firmware version you're using, your platform, and a clear explanation of the steps to reproduce the issue.


## Development

This project is built on Node.JS using Prisma and Express.

To start the development server, run:

```bash
# For local development, you can use the following command to start a postgres instanc
# Don't use in production
docker run --name jetkvm-cloud-db \
    -e POSTGRES_USER=jetkvm \
    -e POSTGRES_PASSWORD=mysecretpassword \
    -e POSTGRES_DB=jetkvm \
    -d postgres

# Copy the .env.example file to .env and populate it with the correct values
cp .env.example .env

# Install dependencies
npm install

# Deploy the existing database migrations
npx prisma migrate deploy

# Start the production server on port 3000
npm run dev
```

## Testing

This project uses [Vitest](https://vitest.dev/) as its testing framework. Tests are colocated with source files using the `*.test.ts` naming pattern.

### Running Tests

```bash
# Run all tests once
npm test

# Run tests in watch mode (reruns on file changes)
npm run test:watch

# Open interactive UI for test exploration
npm run test:ui

# Run tests with coverage report
npm run test:coverage
```

### Writing Tests

Tests are located next to their source files (e.g., `helpers.ts` has `helpers.test.ts`). Vitest provides Jest-compatible APIs with `describe`, `it`, and `expect` available globally.

**Basic test structure:**

```typescript
import { describe, it, expect } from 'vitest';
import { functionToTest } from './module';

describe('Module Name', () => {
  it('should perform expected behavior', () => {
    const result = functionToTest('input');
    expect(result).toBe('expected output');
  });
});
```

**Testing async functions:**

```typescript
it('should handle async operations', async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

**Testing error classes:**

```typescript
it('should create error with correct properties', () => {
  const error = new CustomError(400, 'Bad Request');
  expect(error).toBeInstanceOf(Error);
  expect(error.status).toBe(400);
  expect(error.message).toBe('Bad Request');
});
```

### Common Assertions

- `expect(value).toBe(expected)` - Strict equality (===)
- `expect(value).toEqual(expected)` - Deep equality for objects/arrays
- `expect(value).toBeDefined()` - Value is not undefined
- `expect(value).toBeUndefined()` - Value is undefined
- `expect(value).toBeInstanceOf(Class)` - Instance check
- `expect(value).toBeGreaterThan(n)` - Numeric comparison
- `expect(value).toBeLessThan(n)` - Numeric comparison
- `expect(fn).toThrow()` - Function throws error

### Testing Guidelines

1. **Test file location**: Place test files next to the source file being tested
2. **Test naming**: Use descriptive test names that explain the expected behavior
3. **Test organization**: Group related tests using `describe` blocks
4. **Test isolation**: Each test should be independent and not rely on other tests
5. **Coverage target**: Aim for meaningful coverage of critical logic, not just percentage metrics
6. **Mock external dependencies**: Use Vitest mocks for external APIs, databases, or file system operations

### Test Coverage

Coverage reports are generated in the `coverage/` directory when running `npm run test:coverage`. The report includes:

- **Line coverage**: Percentage of code lines executed
- **Branch coverage**: Percentage of conditional branches tested
- **Function coverage**: Percentage of functions called
- **Statement coverage**: Percentage of statements executed

View the HTML report by opening `coverage/index.html` in your browser.

## Production

```bash
# Copy the .env.example file to .env and populate it with the correct values
cp .env.example .env

# Install dependencies
npm install

# Deploy the existing database migrations
# Needs to run on new release
npx prisma migrate deploy

# Start the production server on port 3000
npm run start
```
