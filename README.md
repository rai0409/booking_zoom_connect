# Booking Zoom Connect

Multi-tenant scheduling MVP with explicit workflow states, external integrations, and operations-aware backend design.

This project is built for scheduling workflows where confirmation, cancellation, rescheduling, and third-party integrations must remain reliable under real operational constraints.

## What it does

- Provides public booking availability and hold flows
- Supports verification, confirmation, cancellation, and rescheduling
- Models booking transitions explicitly as workflow states
- Prepares the system for Graph, Zoom, and queue-based integrations
- Separates public booking flows from internal debugging and ops endpoints

## Typical use cases

- Scheduling and appointment booking
- Multi-tenant booking backends
- Integration-heavy workflow systems
- Small SaaS products with operational constraints
- Booking systems that need recoverable state transitions

## Stack

TypeScript, NestJS, Next.js, Prisma, PostgreSQL, Docker Compose, pnpm, Turborepo

## Why this repo matters

Scheduling looks simple until workflows need reliable transitions, retries, idempotency, and external API integration. This repository shows how to design booking flows with operational reliability in mind.

## Quick start

```bash
docker compose up -d
pnpm -w install
pnpm -w db:migrate
pnpm -w db:seed
pnpm -w dev
```

## Local defaults

- API: http://localhost:4000
- Web: http://localhost:3000

## Notes

This repository is a good fit for teams that need:
- workflow-driven booking systems
- integration-ready backend design
- multi-tenant scheduling products
- operationally reliable state handling
