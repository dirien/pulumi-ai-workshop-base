# Claude Code Instructions

## Project Overview

This is a **Security Incident Response Workshop** built with Pulumi (TypeScript). It deploys a DigitalOcean Kubernetes cluster with security tools that integrate with PagerDuty to trigger Pulumi Deployments on security incidents.

## Architecture

```
Detection (Falco/Trivy/Kyverno/Prometheus)
    → PagerDuty (Incident)
    → DO App Service (Webhook)
    → Pulumi Deployments API
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
pagerduty:token        # PagerDuty API token (secret)
pagerduty-email        # PagerDuty user email for escalation
pulumi-pat             # Pulumi access token for Deployments API (secret)
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

| Exception | Pattern | Description |
|-----------|---------|-------------|
| `cilium_arp_fix_ping` | cilium-* pods in kube-system running ping | Network health checks from Cilium arp-fix containers |
| `grafana_sidecar_k8s_api` | grafana-sc-* containers in monitoring namespace | Dashboard/datasource sync operations |

These exceptions are applied to:
- **Redirect STDOUT/STDIN rule** - excludes Cilium ping operations
- **K8s API connection rule** - excludes Grafana sidecar connections

## PagerDuty Alert Grouping

Content-based alert grouping is configured on the "Kubernetes Security Incidents" service:
- Groups alerts by `summary` and `source` fields
- Time window: 1 hour (3600 seconds)
- Reduces notification noise from repetitive alerts

## Notes

- Falco uses `modern_ebpf` driver (works on DigitalOcean without kernel headers)
- PagerDuty Extension requires `endpointUrl` as a separate property (not in config JSON)
- Webhook is deployed as DO App Platform service using container from DOCR
