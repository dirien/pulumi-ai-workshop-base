# Claude Code Instructions

## Project Overview

This is a **Security Incident Response Workshop** built with Pulumi (TypeScript). It deploys a DigitalOcean Kubernetes cluster with security tools that integrate with PagerDuty to trigger Pulumi Neo tasks for automated incident investigation.

## Architecture

```
Detection (Falco/Trivy/Kyverno/Prometheus)
    → PagerDuty (Incident)
    → DO App Service (Webhook)
    → Pulumi Neo API (AI-powered incident response)
```

## Key Components

| Component | Purpose | Namespace |
|-----------|---------|-----------|
| Falco | Runtime threat detection (shell in pod) | security |
| Trivy Operator | CVE/vulnerability scanning | trivy-system |
| Kyverno | Policy enforcement | kyverno |
| Prometheus Stack | Metrics & alerting | monitoring |
| DO App Service | Webhook handler (container) | N/A (App Platform) |

## Configuration

Config values are loaded from Pulumi ESC environment. Key config keys:

```bash
pagerduty:token        # PagerDuty API token (secret) - used by provider and webhook
pagerduty-email        # PagerDuty user email for escalation
pulumi-pat             # Pulumi access token for Neo API (secret)
digitalocean:token     # DO API token (secret)
```

## Commands

```bash
# Deploy infrastructure
pulumi up

# Connect to cluster
pulumi env run gitops-promotion-tools/gitops-promotion-tools-do-cluster -i -- kubectl get pods -A

# Check stack outputs
pulumi stack output webhookUrl
```

## Files Structure

```
├── index.ts                    # Main Pulumi program
├── package.json                # Dependencies
├── WORKSHOP_SCENARIOS.md       # Test scenarios for workshop
├── functions/
│   └── packages/security/pagerduty-webhook/
│       ├── Dockerfile          # Container image
│       ├── server.js           # Webhook handler
│       └── package.json
```

## Workshop Scenarios

See `WORKSHOP_SCENARIOS.md` for detailed test scenarios:
1. Shell spawned in pod (Falco)
2. CVE detection (Trivy)
3. Policy violation (Kyverno)
4. Resource exhaustion (Prometheus)

## Falco Custom Rules

Custom rules are configured to reduce noise from known-safe Kubernetes components:

### Infrastructure Namespace Exclusions

The `infra_namespace` macro excludes all events from these namespaces:
- `kube-system`, `kube-public`, `kube-node-lease`
- `monitoring`, `kyverno`, `security`, `trivy-system`

This macro is applied to override these default Falco rules (rule names must match exactly, case-sensitive):
- **Redirect STDOUT/STDIN to Network Connection in Container** - excludes all infra namespaces
- **Contact K8S API Server From Container** - excludes all infra namespaces (note: K8S not K8s)
- **Terminal shell in container** - excludes all infra namespaces

Workshop test workloads should be deployed to the `default` namespace to trigger Falco alerts.

## PagerDuty Alert Grouping

Content-based alert grouping is configured on the "Kubernetes Security Incidents" service:
- Groups alerts by `summary` and `source` fields
- Time window: 1 hour (3600 seconds)
- Reduces notification noise from repetitive alerts

## Trivy Operator Configuration

The Trivy operator is configured with increased resources and namespace exclusions to reduce noise:

| Setting | Value | Reason |
|---------|-------|--------|
| `trivy.resources.limits.memory` | 2Gi | Prevents OOMKilled errors on large images (e.g., Cilium) |
| `trivy.timeout` | 10m0s | Allows more time for large image scans |
| `operator.scanJobTimeout` | 10m | Prevents premature job termination |
| `excludeNamespaces` | kube-system, kube-public, kube-node-lease, monitoring, security, kyverno, trivy-system | Reduces noise from infrastructure components |

Workshop test workloads should be deployed to the `default` namespace or a custom namespace to be scanned by Trivy.

## Alertmanager Namespace Exclusions

Alertmanager routes are configured to silence alerts from infrastructure namespaces:

| Namespace | Reason |
|-----------|--------|
| `kube-system` | Core Kubernetes components |
| `monitoring` | Prometheus stack itself |
| `kyverno` | Policy engine |
| `security` | Falco and security tools |
| `trivy-system` | Vulnerability scanner |

Alerts from these namespaces are routed to a `null` receiver (silenced). Workshop test workloads should be deployed to the `default` namespace to trigger PagerDuty incidents.

## Notes

- Falco uses `modern_ebpf` driver (works on DigitalOcean without kernel headers)
- PagerDuty Extension requires `endpointUrl` as a separate property (not in config JSON)
- Webhook is deployed as DO App Platform service using container from DOCR
- Alertmanager uses modern `matchers` syntax instead of deprecated `match` for route configuration

## Webhook & Neo Integration

The webhook (`functions/packages/security/pagerduty-webhook/server.js`) creates Pulumi Neo tasks when PagerDuty incidents are triggered:

1. **Receives** PagerDuty webhook on `incident.triggered` events
2. **Fetches** alert details from PagerDuty API to get custom_details (Falco context)
3. **Creates** a Neo task via `POST /api/preview/agents/{org}/tasks`
4. **Neo** investigates the incident, assigns it to itself, and posts findings to incident notes

### Falco Sidekick Custom Fields

Custom fields are configured in Falco Sidekick to pass infrastructure context to PagerDuty:

| Field | Value | Purpose |
|-------|-------|---------|
| `git_repo` | GitHub repository URL | Source code reference |
| `pulumi_org` | Pulumi organization | Infrastructure context |
| `pulumi_project` | Project name | Stack identification |
| `pulumi_stack` | Stack name (dev/prod) | Environment context |
| `esc_environment` | ESC environment path | Credentials/config source |
| `cluster_name` | Kubernetes cluster name | Target cluster |
| `cluster_provider` | Cloud provider (digitalocean) | Platform context |

### Auto-Deploy

The DO App is configured with `deployOnPush: true` to automatically redeploy when new container images are pushed to DOCR.
