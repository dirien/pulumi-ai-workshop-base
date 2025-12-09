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

### Workshop-Specific Rule: Shell Spawned in Container

The default Falco "Terminal shell in container" rule requires `proc.tty != 0` (a real TTY attached). However, when running `kubectl exec -it` through `pulumi env run`, the TTY is NOT passed through properly.

A custom rule "Shell Spawned in Container (Workshop)" is added that:
- Detects shell processes in containers **without** requiring TTY
- Only triggers for non-system namespaces (excludes kube-system, monitoring, etc.)
- Has `WARNING` priority (higher than NOTICE) for visibility

**Testing shell detection:**
```bash
# This works (TTY passed through):
eval $(pulumi env open gitops-promotion-tools/gitops-promotion-tools-do-cluster --format shell)
kubectl exec -it test-pod -- /bin/sh

# This also works (no TTY, but custom workshop rule catches it):
pulumi env run gitops-promotion-tools/gitops-promotion-tools-do-cluster -i -- kubectl exec test-pod -- /bin/sh
```

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
- **PagerDuty uses V3 Webhook Subscriptions** (V2 Extensions are deprecated/end-of-support)
- Webhook is deployed as DO App Platform service using container from DOCR
- Alertmanager uses modern `matchers` syntax instead of deprecated `match` for route configuration

## Webhook & Neo Integration

The webhook (`functions/packages/security/pagerduty-webhook/server.js`) creates Pulumi Neo tasks when PagerDuty incidents are triggered:

1. **Receives** PagerDuty webhook on `incident.trigger` or `incident.triggered` events (Generic V2 Webhook uses `incident.trigger`)
2. **Fetches** alert details from PagerDuty API to get custom_details (Falco context)
3. **Creates** a Neo task via `POST /api/preview/agents/{org}/tasks`
4. **Neo** performs automated incident response

### Neo Task Workflow

When Neo receives an incident, it follows this workflow:

1. **Reassign and acknowledge** - Assigns incident to Neo user and posts investigation notice
2. **Investigate** - Clones the Git repository and examines the `beijing/` directory's `index.ts` Pulumi code to identify root cause
3. **Fix if possible** - For fixable issues (vulnerable images, misconfigurations, policy violations):
   - Creates a fix branch
   - Makes necessary changes
   - Creates a PR and posts the link to incident notes
4. **Resolve or escalate**:
   - If PR created: Resolves incident with PR link in notes
   - If not fixable: Posts findings and reassigns to previous assignee

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

### Default Infrastructure Context

The webhook provides default infrastructure context to Neo even when Falco custom_details are not present (e.g., for Alertmanager alerts):

| Field | Default Value |
|-------|---------------|
| `git_repo` | `https://github.com/dirien/pulumi-ai-workshop-base` |
| `pulumi_project` | `pulumi-ai-workshop-base` |
| `pulumi_stack` | `dev` |
| `esc_environment` | `gitops-promotion-tools/gitops-promotion-tools-do-cluster` |
| `cluster_name` | `gitops-promotion-tools-do-cluster` |
| `cluster_provider` | `digitalocean` |

## Workshop Test Deployments

Two intentionally insecure deployments are defined in `index.ts` for testing Neo's automated remediation capabilities:

### vulnerable-nginx (CVE Detection)

```typescript
// Deployment with nginx:1.14.0 - has 35+ critical CVEs
// Neo should create a PR to update to nginx:stable
replicas: 0  // Disabled by default
image: "nginx:1.14.0"
```

### privileged-pod (Policy Violation)

```typescript
// Deployment with privileged: true - violates Kyverno policy
// Neo should create a PR to remove the privileged setting
replicas: 0  // Disabled by default
securityContext: { privileged: true }
```

Both deployments have `replicas: 0` so they don't run, but their pod templates are still evaluated by Trivy and Kyverno.

## Alertmanager Routing for Kyverno Alerts

Kyverno policy violation alerts require special routing because:
- The Kyverno controller runs in the `kyverno` namespace
- Alerts have `namespace=kyverno` but `resource_namespace=default` for violations in the default namespace
- Without special routing, these alerts get silenced by the `namespace=kyverno` → `null` route

The fix adds a route BEFORE namespace silencing:

```yaml
routes:
  - matchers: ["alertname = PolicyViolationDetected", "resource_namespace = default"]
    receiver: pagerduty-security
  # Then namespace silencing routes...
```
