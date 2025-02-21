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

This project is built with Node.JS, Prisma and Express.

To start the development server, run:

```bash
# Copy the .env.example file to a new file .env.development and populate it with the correct values
cp .env.example .env.development

# For local development you can use docker compose to bring up your environment

# this will run docker-compose.yml with docker-compose.override.yml applied

docker compose up --build

# Or you can run a postgres container only

# Don't use in production
docker run --name jetkvm-cloud-db \
    -e POSTGRES_USER=jetkvm \
    -e POSTGRES_PASSWORD=mysecretpassword \
    -e POSTGRES_DB=jetkvm \
    -p 5432:5432 \
    -d postgres

# Install dependencies
npm install

# Deploy the existing database migrations
npx prisma migrate deploy

# Start the production server on port 3000
npm run dev
```

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
