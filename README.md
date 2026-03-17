# Autonomous Infrastructure Drift Detection and AI-Assisted Remediation

## Problem Statement

Infrastructure drift is one of the most dangerous and underappreciated problems in cloud operations. It occurs when someone modifies live AWS infrastructure directly — through the console, CLI, or another tool — without going through Terraform. The result is a silent divergence between what your code says should exist and what actually exists in production.

Drift is dangerous because:
- It breaks the **GitOps principle**: Git is no longer the single source of truth
- It introduces **unreviewed changes** that may open security vulnerabilities
- It causes **Terraform plan surprises** — the next deployment may destroy or recreate resources unexpectedly
- It is **invisible** until something breaks or someone runs a manual plan

TerraWatch detects drift automatically, uses AI to assess risk, and remediates it — safely, with human oversight where it matters.

---

## Architecture

```mermaid
flowchart TD
    A[⏰ Cron Schedule\nevery 10 minutes] --> B[Terraform Plan\n--detailed-exitcode]
    W[Manual Trigger\nworkflow_dispatch] --> B

    B --> C0{Exit Code?}

    C0 -->|0 — No Drift| D0[✅ Close stale issues\nUpdate step summary]
    C0 -->|1 — Plan Failed| D1[❌ Log error\nFail workflow]
    C0 -->|2 — Drift Detected| E[OpenAI GPT-4o\nAnalysis]

    E --> F{Risk Level?}

    F -->|LOW| G1[terraform apply\nauto-approve]
    G1 --> G2[Close GitHub Issue]
    G2 --> G3[Slack 🟢 green]

    F -->|MEDIUM| H1{Environment?}
    H1 -->|dev| H2[terraform apply\nauto-approve]
    H2 --> H3[Close GitHub Issue]
    H3 --> H4[Slack 🟡 yellow]
    H1 -->|prod| H5[Block auto-apply\nSlack ⚠️ warning]

    F -->|HIGH| I1[Block auto-apply\nGitHub Issue stays open]
    I1 --> I2[Slack 🔴 urgent alert]

    G1 --> J[POST /webhook/drift\nDrift History API]
    H2 --> J
    I1 --> J

    J --> K[(PostgreSQL\ndrift_events)]

```

## How It Works

1. **Detection** — A GitHub Actions workflow runs on a 10-minute cron schedule (or manually via `workflow_dispatch`). It runs `terraform plan --detailed-exitcode` against the live AWS environment.

2. **Exit code interpretation** — Terraform returns exit code `0` (no changes), `1` (plan error), or `2` (drift detected). Only exit code `2` triggers the remediation flow.

3. **AI Analysis** — When drift is detected, the plan output is sent to OpenAI GPT-4o. The AI returns a structured JSON response with an explanation, a risk level (LOW/MEDIUM/HIGH), and the reasoning behind it.

4. **Risk-based remediation** — The pipeline branches based on the risk level:
   - **LOW** — Auto-apply immediately in all environments. Safe changes like tag updates.
   - **MEDIUM** — Auto-apply in dev. Block in prod and alert for manual review.
   - **HIGH** — Never auto-apply. Open a GitHub Issue with full AI analysis, send urgent Slack alert.

5. **Audit trail** — Every drift event is recorded to a PostgreSQL-backed REST API with environment, risk level, explanation, status, and the GitHub run ID for traceability.

---

## Key Design Decisions

### Why risk-based remediation tiers instead of blind auto-fix?

Auto-fixing all drift is dangerous. A security group rule opened to `0.0.0.0/0` is drift — but auto-applying `terraform apply` would close it silently with no human awareness. Risk tiers ensure that changes affecting security posture always require human review, while harmless changes like tag updates are fixed immediately without waking anyone up at 3am.

### Why does HIGH risk never auto-apply?

HIGH risk drift typically involves security groups, IAM policies, network ACLs, or public access settings. These are exactly the changes an attacker would make after compromising an AWS account. Automatically reverting them without a human seeing what happened means losing the audit trail and potentially missing an active incident. A human must see it first.

### Why does AI analysis happen before remediation decisions?

Terraform plan output is precise but context-free. It tells you *what* changed but not *why it matters*. GPT-4o can look at a change like `ingress port 22 from 0.0.0.0/0 added` and immediately classify it as HIGH risk with an explanation that a non-expert can understand. This makes the GitHub Issue and Slack alert actionable rather than just a wall of HCL diff.

### Why does the pipeline never apply directly without tracking?

Every terraform apply — whether triggered by CI/CD or drift remediation — is tied to a GitHub Actions run ID. This run ID is stored in the drift history API alongside the environment, risk level, and explanation. This means you can always answer: *what changed, when, why, and what did the system do about it*. GitHub logs alone don't give you this — they expire and lack the semantic context.

### Why separate dev and prod state files?

Terraform state contains a full map of your infrastructure. If dev and prod shared state, a `terraform destroy` in dev could reference and affect prod resources. Separate state files with separate lock keys ensure dev and prod are completely isolated — a drift fix in dev cannot accidentally touch prod.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Infrastructure | Terraform >= 1.10.0, AWS (VPC, ALB, ASG, EC2, S3, IAM) |
| CI/CD | GitHub Actions |
| Drift Detection | `terraform plan --detailed-exitcode` |
| AI Analysis | OpenAI GPT-4o via Node.js SDK |
| Notifications | Slack Incoming Webhooks |
| Issue Tracking | GitHub Issues API |
| Drift History | Node.js + Express + PostgreSQL |
| State Backend | S3 + native state locking (`use_lockfile = true`) |

---

## Setup Guide

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | AWS credentials for GitHub Actions |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials for GitHub Actions |
| `OPENAI_API_KEY` | OpenAI API key for drift analysis |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `TERRAWATCH_API_URL` | URL of the running drift history API |

### Required GitHub Environments

1. Go to **Settings → Environments**
2. Create environment `dev` — no protection rules
3. Create environment `prod` — enable **Required reviewers**, add yourself

### Deploying Infrastructure

```bash
# Dev environment
terraform init -backend-config=backend-dev.hcl
terraform plan -var-file=dev.tfvars
terraform apply -var-file=dev.tfvars

# Prod environment
terraform init -reconfigure -backend-config=backend-prod.hcl
terraform plan -var-file=prod.tfvars
terraform apply -var-file=prod.tfvars
```

### Running the Drift History API

```bash
cd api
npm install
DATABASE_URL=postgresql://user:pass@host:5432/terrawatch npm start
```
