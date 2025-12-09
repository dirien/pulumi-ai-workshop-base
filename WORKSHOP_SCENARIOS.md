# Security Incident Response Workshop - Test Scenarios

This guide walks you through testing the 4 security incident response scenarios. Each scenario triggers a different detection tool, which ultimately creates a PagerDuty incident and triggers a Pulumi Neo task for AI-powered incident investigation.

## Prerequisites

Before testing, ensure:

1. **Infrastructure is deployed:**
   ```bash
   pulumi up
   ```

2. **Configuration is set (via ESC or config):**
   ```bash
   pulumi config set pagerduty:token --secret
   pulumi config set pagerduty-email your@email.com
   pulumi config set pulumi-pat --secret
   ```

3. **Connect to the cluster:**
   ```bash
   pulumi env run gitops-promotion-tools/gitops-promotion-tools-do-cluster -i -- kubectl get nodes
   ```
   Or use the kubeconfig export:
   ```bash
   export KUBECONFIG=$(pulumi stack output kubeconfig --show-secrets | base64 -d > /tmp/kubeconfig && echo /tmp/kubeconfig)
   kubectl get nodes
   ```

4. **Verify all security tools are running:**
   ```bash
   kubectl get pods -n security        # Falco
   kubectl get pods -n monitoring      # Prometheus, Alertmanager
   kubectl get pods -n trivy-system    # Trivy Operator
   kubectl get pods -n kyverno         # Kyverno
   ```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Detection Layer                                  │
├──────────────┬──────────────┬──────────────┬───────────────────────────┤
│    Falco     │    Trivy     │   Kyverno    │       Prometheus          │
│  (Runtime)   │   (CVE)      │  (Policy)    │      (Metrics)            │
└──────┬───────┴──────┬───────┴──────┬───────┴───────────┬───────────────┘
       │              │              │                   │
       ▼              └──────────────┴───────────────────┘
  Falcosidekick                      │
       │                             ▼
       │                       Alertmanager
       │                             │
       └──────────────┬──────────────┘
                      ▼
                  PagerDuty
                      │
                      ▼
           DO App Service (Webhook)
                      │
                      ▼
            Pulumi Neo API (AI Investigation)
```

---

## Scenario 1: Shell Spawned in Pod (Falco)

**Detection Tool:** Falco with modern_ebpf driver
**Alert Path:** Falco → Falcosidekick → PagerDuty Events API
**Severity:** High

### Trigger the Detection

```bash
# Create a test pod
kubectl run test-pod --image=nginx --restart=Never

# Wait for it to be running
kubectl wait --for=condition=Ready pod/test-pod --timeout=60s

# Exec into the pod (this triggers Falco's "Terminal shell in container" rule)
kubectl exec -it test-pod -- /bin/sh
```

Once inside the shell, type a few commands and exit:
```bash
whoami
ls -la
exit
```

### Expected Result

1. **Falco** detects the shell execution and logs it
2. **Falcosidekick** forwards the event to PagerDuty
3. **PagerDuty** creates an incident
4. **PagerDuty Webhook** calls the DO App Service
5. **DO App Service** triggers Pulumi Neo task for AI-powered investigation

### Verification

```bash
# Check Falco logs for the detection
kubectl logs -n security -l app.kubernetes.io/name=falco --tail=50

# Check Falcosidekick logs
kubectl logs -n security -l app.kubernetes.io/name=falcosidekick --tail=20
```

### Cleanup

```bash
kubectl delete pod test-pod
```

---

## Scenario 2: CVE Detection (Trivy Operator)

**Detection Tool:** Trivy Operator
**Alert Path:** Trivy scan → Prometheus metrics → PrometheusRule → Alertmanager → PagerDuty
**Severity:** Critical

### Trigger the Detection

> **Note:** Trivy is configured to exclude infrastructure namespaces (`kube-system`, `monitoring`, `security`, `kyverno`, `trivy-system`). Test pods should be deployed in the `default` namespace or a custom namespace to be scanned.

**Option A: Using Pulumi-managed deployment (recommended for Neo remediation)**

The `vulnerable-nginx` deployment is already defined in `index.ts` with `replicas: 0`. Scale it up:

```bash
kubectl scale deployment vulnerable-nginx -n default --replicas=1
```

Neo can then create a PR to fix the vulnerable image in the Pulumi code.

**Option B: Using kubectl (manual test)**

```bash
# Deploy a known vulnerable image (DVWA - Damn Vulnerable Web Application)
kubectl run vuln-pod --image=vulnerables/web-dvwa --restart=Never

# Alternative: Use an older nginx with known CVEs
kubectl run vuln-nginx --image=nginx:1.14.0 --restart=Never
```

### Expected Result

1. **Trivy Operator** automatically scans the new pod's image
2. **VulnerabilityReport** CRD is created with CVE findings
3. **Prometheus** scrapes Trivy metrics (`trivy_image_vulnerabilities`)
4. **PrometheusRule** `CriticalVulnerabilityDetected` fires
5. **Alertmanager** routes to PagerDuty
6. **PagerDuty** creates incident → webhook → Pulumi Neo

### Verification

```bash
# Wait for Trivy to scan (may take 2-5 minutes)
kubectl get vulnerabilityreports -A

# Check the vulnerability report details
kubectl get vulnerabilityreports -o wide

# Check Prometheus for the metric (port-forward to Prometheus)
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
# Then open: http://localhost:9090 and query: trivy_image_vulnerabilities{severity="Critical"}

# Check Alertmanager for firing alerts
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &
# Then open: http://localhost:9093
```

### Cleanup

```bash
kubectl delete pod vuln-pod
kubectl delete pod vuln-nginx
```

---

## Scenario 3: Policy Violation (Kyverno)

**Detection Tool:** Kyverno
**Alert Path:** Kyverno audit → Prometheus metrics → PrometheusRule → Alertmanager → PagerDuty
**Severity:** Warning

### Trigger the Detection

**Option A: Using Pulumi-managed deployment (recommended for Neo remediation)**

The `privileged-pod` deployment is already defined in `index.ts` with `replicas: 0`. Scale it up:

```bash
kubectl scale deployment privileged-pod -n default --replicas=1
```

Neo can then create a PR to remove the privileged security context in the Pulumi code.

**Option B: Using kubectl (manual test)**

```bash
# Try to create a privileged container (policy is in Audit mode)
kubectl run privileged-pod --image=nginx --restart=Never \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "nginx",
        "image": "nginx",
        "securityContext": {
          "privileged": true
        }
      }]
    }
  }'
```

### Expected Result

1. **Kyverno** evaluates the pod against `disallow-privileged-containers` policy
2. In **Audit mode**, the pod is created but violation is recorded
3. **Prometheus** scrapes Kyverno metrics (`kyverno_policy_results_total{rule_result='fail'}`)
4. **PrometheusRule** `PolicyViolationDetected` fires
5. **Alertmanager** routes to PagerDuty
6. **PagerDuty** creates incident → webhook → Pulumi Neo

### Verification

```bash
# Check Kyverno policy reports
kubectl get policyreports -A
kubectl get clusterpolicyreports

# Get details of violations
kubectl describe clusterpolicyreport

# Check Kyverno metrics (port-forward to admission controller)
kubectl port-forward -n kyverno svc/kyverno-admission-controller-metrics 8000:8000 &
curl localhost:8000/metrics | grep kyverno_policy_results_total

# Check Prometheus for the alert
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
# Query: increase(kyverno_policy_results_total{rule_result='fail'}[5m])
```

### Cleanup

```bash
kubectl delete pod privileged-pod
```

---

## Scenario 4: Resource Exhaustion (Prometheus)

**Detection Tool:** Prometheus with container metrics
**Alert Path:** cAdvisor metrics → Prometheus → PrometheusRule → Alertmanager → PagerDuty
**Severity:** Warning

### Trigger the Detection

```bash
# Deploy a pod that consumes memory with limits set
kubectl run stress-pod --image=polinux/stress --restart=Never \
  --limits='memory=256Mi' \
  -- stress --vm 1 --vm-bytes 230M --vm-hang 300

# Alternative: Deploy a memory hog without stress tool
kubectl run memory-hog --image=progrium/stress --restart=Never \
  --limits='memory=256Mi' \
  -- --vm 1 --vm-bytes 240M --timeout 300s
```

### Expected Result

1. **Pod** starts consuming memory close to its limit (>90%)
2. **Prometheus** collects `container_memory_usage_bytes` metrics
3. **PrometheusRule** `PodMemoryExhaustion` fires when usage > 90% of limit
4. **Alertmanager** routes to PagerDuty
5. **PagerDuty** creates incident → webhook → Pulumi

### Verification

```bash
# Check pod memory usage
kubectl top pods

# Port-forward to Prometheus and check the alert
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090 &
# Query: container_memory_usage_bytes / container_spec_memory_limit_bytes

# Check Alertmanager for firing alerts
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093 &
```

### Cleanup

```bash
kubectl delete pod stress-pod
kubectl delete pod memory-hog
```

---

## Verification Checklist

After triggering any scenario, verify the full chain:

### 1. Check PagerDuty Incidents
- Open: https://app.pagerduty.com/incidents
- Look for "Kubernetes Security Incidents" service
- Verify incident details match the trigger

### 2. Check DO App Service Logs
```bash
# Get the app ID
doctl apps list

# View service logs
doctl apps logs <app-id> --type=run
```

### 3. Check Pulumi Neo Tasks
- Open: https://app.pulumi.com/{org}/tasks
- Verify a Neo task was created for the incident
- Neo will automatically:
  - Assign the incident to itself
  - Investigate using the PagerDuty API
  - Post findings to incident notes
  - Resolve the incident if appropriate

---

## Troubleshooting

### Falco not detecting events
```bash
# Check Falco driver status
kubectl logs -n security -l app.kubernetes.io/name=falco | grep -i driver

# Verify modern_ebpf is loaded
kubectl exec -n security -it $(kubectl get pods -n security -l app.kubernetes.io/name=falco -o jsonpath='{.items[0].metadata.name}') -- falco --version
```

### Trivy not scanning
```bash
# Check Trivy Operator logs
kubectl logs -n trivy-system -l app.kubernetes.io/name=trivy-operator

# Force a rescan by deleting the vulnerability report
kubectl delete vulnerabilityreports --all
```

### Alerts not firing
```bash
# Check PrometheusRule is loaded
kubectl get prometheusrules -n monitoring

# Check Alertmanager config
kubectl get secret -n monitoring kube-prometheus-stack-alertmanager -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d
```

### Webhook not called
```bash
# Verify PagerDuty extension is configured
# Check in PagerDuty UI: Services → Extensions

# Test the webhook manually
curl -X POST $(pulumi stack output webhookUrl) \
  -H "Content-Type: application/json" \
  -d '{"event":{"event_type":"incident.triggered","data":{"id":"TEST123","title":"Manual Test"}}}'
```

---

## Quick Reference: Port Forwards

```bash
# Prometheus
kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090

# Alertmanager
kubectl port-forward -n monitoring svc/kube-prometheus-stack-alertmanager 9093:9093

# Grafana (default login: admin/prom-operator)
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80

# Kyverno Metrics
kubectl port-forward -n kyverno svc/kyverno-admission-controller-metrics 8000:8000
```

---

## All-in-One Test Script

Run all scenarios in sequence:

```bash
#!/bin/bash
set -e

echo "=== Scenario 1: Shell in Pod (Falco) ==="
kubectl run test-pod --image=nginx --restart=Never
kubectl wait --for=condition=Ready pod/test-pod --timeout=60s
kubectl exec test-pod -- /bin/sh -c "whoami && hostname"
echo "Waiting 30s for Falco to process..."
sleep 30

echo "=== Scenario 2: CVE Detection (Trivy) ==="
kubectl run vuln-pod --image=nginx:1.14.0 --restart=Never
echo "Trivy scan will take 2-5 minutes..."

echo "=== Scenario 3: Policy Violation (Kyverno) ==="
kubectl run privileged-pod --image=nginx --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"nginx","image":"nginx","securityContext":{"privileged":true}}]}}'
echo "Waiting 60s for Kyverno metrics to be scraped..."
sleep 60

echo "=== Scenario 4: Resource Exhaustion ==="
kubectl run stress-pod --image=polinux/stress --restart=Never \
  --limits='memory=256Mi' \
  -- stress --vm 1 --vm-bytes 230M --vm-hang 120
echo "Waiting 5 minutes for memory alert..."
sleep 300

echo "=== Cleanup ==="
kubectl delete pod test-pod vuln-pod privileged-pod stress-pod --ignore-not-found

echo "=== Check PagerDuty for incidents ==="
echo "https://app.pagerduty.com/incidents"
```
