# Contributing to Strata Client

Thank you for your interest in contributing to Strata Client! This document provides guidelines and instructions for contributing.

## License

By contributing to this project, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).

## Getting Started

### Development Environment

**Backend (Rust):**
- Rust 1.78+ (`rustup` recommended)
- A running PostgreSQL instance (or use the bundled Docker container)

```bash
cd backend
export DATABASE_URL="postgresql://strata:strata_default@localhost:5432/strata"
cargo run
```

**Frontend (TypeScript / React):**
- Node.js 20+
- npm

```bash
cd frontend
npm install
npm run dev
```

**Full stack (Docker):**
```bash
cp .env.example .env
docker compose up -d --build
```

### Project Structure

| Directory | Language | Description |
|---|---|---|
| `backend/` | Rust | API server, WebSocket proxy, business logic |
| `frontend/` | TypeScript | React SPA (Vite) |
| `guacd/` | Dockerfile | Custom Apache Guacamole daemon |
| `docs/` | Markdown | Architecture, API, deployment, security docs |

## Code Style

### Rust
- Follow standard `rustfmt` formatting (`cargo fmt`)
- Fix all `clippy` warnings (`cargo clippy`)
- Use `thiserror` for error types, `anyhow` in application code
- Parameterize all SQL queries (never interpolate user input)

### TypeScript
- TypeScript strict mode is enabled
- No `any` types unless unavoidable
- Use functional components and hooks

## Pull Request Process

1. Fork the repository and create a feature branch from `main`
2. Make your changes with clear, descriptive commits
3. Ensure the backend compiles (`cargo check`) and the frontend builds (`npm run build`)
4. Update documentation if your change affects the API, configuration, or architecture
5. Add an entry to `CHANGELOG.md` under `[Unreleased]`
6. Open a pull request with a description of what and why

## Reporting Issues

Open an issue with:
- A clear description of the problem or feature request
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Environment details (OS, Docker version, browser)

## Security Vulnerabilities

If you discover a security vulnerability, please **do not** open a public issue. Instead, contact the maintainers privately. See [docs/security.md](docs/security.md) for the security model.
