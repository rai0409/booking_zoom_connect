# Workflow-Driven Scheduling Backend with External Integrations

A multi-tenant scheduling backend designed for real operational flows:
availability, hold, verify, confirm, cancel, and reschedule.

## What this solves

Manual scheduling often breaks under real business constraints such as double booking, confirmation flow complexity, and external calendar integration.

This repository focuses on workflow-safe booking flows that can support production-oriented internal or public scheduling systems.

## Core flow

availability -> hold -> verify -> confirm / cancel / reschedule

## Demo

![Booking flow demo](docs/images/booking_flow.png)

## What it does

- provides multi-tenant booking flows
- manages holds and confirmation steps
- supports cancellation and rescheduling workflows
- integrates with external systems
- keeps workflow states explicit and implementation-friendly

## Quick start

```bash
pnpm install
pnpm dev
```

## Repository layout

```text
.
├── apps/
├── docs/
├── packages/
│   └── shared/
├── prompts/
├── scripts/
│   └── repo_tools/
├── .env.example
├── .gitignore
├── .pre-commit-config.yaml
├── LICENSE
├── README.md
├── docker-compose.yml
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── turbo.json
```

## Notes

This repository is a good fit for teams that need:

- workflow-driven booking systems
- integration-ready backend design
- multi-tenant scheduling products
- operationally reliable state handling

## Stack

TypeScript, NestJS, Next.js, Prisma, PostgreSQL, Docker Compose, pnpm, Turborepo

## License

This repository is source-available for personal study, research, and evaluation.  
Commercial use requires prior written permission and a separate paid license.  
See `LICENSE` for details.
