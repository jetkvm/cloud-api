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
# Start the database
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
