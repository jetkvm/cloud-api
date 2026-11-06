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

This project is built with Node.js, Prisma, and Express.

```bash
# Start the database and the S3-compatible store the e2e tests use
docker compose -f compose.development.yaml up -d

# Copy and configure environment variables
cp .env.example .env

# Install dependencies
npm install

# Run database migrations
npm run prisma-dev-migrate

# Seed development data (optional)
npm run seed

# Start the development server with hot reload
npm run dev

# Run tests
npm test
```

### End-to-end tests

`npm run test:e2e` builds the API and starts it as the container does, against a
database (`jetkvm_e2e`) and a bucket that only the e2e run uses. It needs the
services from `compose.development.yaml`. Override them with `E2E_DATABASE_URL`
and `E2E_S3_ENDPOINT`.

### Comparing two deployments

`npm run compare` sends the same requests to two deployments of the API and
reports where the answers differ, grouped by cause. In a terminal it asks you to
mark each group as expected or not, and exits with 0 only when you mark them all:

```bash
npm run compare -- --candidate local
npm run compare -- --candidate staging --only releases,redirects
npm run compare -- --help
```

The reference defaults to `https://api.jetkvm.com`. Update checks that depend
on the rollout table differ unless both databases have the same rollout
percentages.

## Self-Hosting

For self-hosting, use the default compose file which runs the complete stack:

```bash
# Copy and configure environment variables
cp .env.example .env

# Start everything (database, migrations, and app)
docker compose up -d
```

The app will be available on port 3000. Configure a reverse proxy (nginx, Caddy, etc.) for TLS termination.

### Updating

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically on startup.
