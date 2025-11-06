# DigitalOcean Kubernetes Cluster with Monitoring

A production-ready Pulumi template for deploying a DigitalOcean Kubernetes cluster with built-in monitoring capabilities using metrics-server and Prometheus.

## Overview

This template creates:
- A DigitalOcean Kubernetes cluster with configurable node pool
- Metrics Server for resource metrics collection
- Prometheus monitoring stack (kube-prometheus-stack) with Grafana
- Pulumi ESC Environment for secure credential management

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/) installed
- [Node.js](https://nodejs.org/) (v18 or later)
- A [DigitalOcean account](https://www.digitalocean.com/) with API access
- A [Pulumi Cloud account](https://app.pulumi.com/)

## Configuration

This template supports the following configuration options:

| Config Key | Description | Default | Required |
|------------|-------------|---------|----------|
| `digitalocean:token` | DigitalOcean API token | - | Yes (secret) |
| `clusterRegion` | DigitalOcean region for the cluster | `fra1` | No |
| `clusterVersion` | Kubernetes version | `1.33.1-do.5` | No |
| `nodePoolSize` | Node pool instance size | `s-4vcpu-8gb` | No |
| `nodeCount` | Number of nodes in the pool | `1` | No |
| `escProject` | Pulumi project for ESC environment | `gitops-promotion-tools` | No |

## Usage

### Creating a New Project from This Template

```bash
# Create a new project from this template
pulumi new <template-url> --name my-k8s-cluster --description "My Kubernetes cluster"

# Configure your DigitalOcean token (required)
pulumi config set digitalocean:token YOUR_TOKEN --secret

# Optional: Customize other settings
pulumi config set clusterRegion nyc1
pulumi config set nodeCount 3
pulumi config set nodePoolSize s-2vcpu-4gb

# Deploy the infrastructure
pulumi up
```

### Connecting to Your Cluster

After deployment, use the Pulumi ESC environment to connect:

```bash
# Connect using kubectl
pulumi env run <esc-project>/<cluster-name> -i -- kubectl get nodes

# Or use k9s for interactive management
pulumi env run <esc-project>/<cluster-name> -i -- k9s
```

The cluster name will be output as `name` after deployment.

## Outputs

| Output | Description |
|--------|-------------|
| `name` | The name of the Kubernetes cluster |
| `kubeconfig` | The kubeconfig for cluster access |
| `envrionmentResourceName` | The ESC environment name |
| `usage` | Instructions for connecting to the cluster |

## Monitoring

The template includes:

- **Metrics Server**: Provides resource metrics for horizontal pod autoscaling and `kubectl top` commands
- **Prometheus Stack**: Complete monitoring solution including:
  - Prometheus for metrics collection
  - Grafana for visualization
  - AlertManager for alerting
  - Pre-configured dashboards and alerts

Access Grafana after deployment:

```bash
# Port-forward to Grafana
pulumi env run <esc-project>/<cluster-name> -i -- kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80

# Default credentials: admin / prom-operator
```

## Customization

### Changing Node Pool Configuration

Modify the configuration to adjust cluster resources:

```bash
# Increase node count for production
pulumi config set nodeCount 5

# Use larger instances
pulumi config set nodePoolSize s-8vcpu-16gb
```

### Adding Additional Helm Charts

Uncomment the podinfo example in `index.ts` or add your own Helm releases using the `k8sProvider`:

```typescript
const myApp = new k8s.helm.v3.Release("my-app", {
    name: "my-app",
    chart: "my-chart",
    repositoryOpts: {
        repo: "https://my-helm-repo.com",
    },
}, {
    provider: k8sProvider,
});
```

## Cost Considerations

The default configuration (`s-4vcpu-8gb` with 1 node) costs approximately:
- **Compute**: ~$48/month per node
- **Load Balancers**: Additional costs if services are exposed

Adjust `nodePoolSize` and `nodeCount` based on your workload requirements.

## Troubleshooting

### Cluster Creation Fails

- Verify your DigitalOcean token is valid: `pulumi config get digitalocean:token`
- Check the selected region supports Kubernetes: [DigitalOcean Regions](https://docs.digitalocean.com/products/platform/availability-matrix/)
- Ensure the Kubernetes version is available in your region

### Cannot Connect to Cluster

- Verify the ESC environment was created: `pulumi stack output envrionmentResourceName`
- Check your Pulumi organization has access to the `pulumi-idp/auth` ESC import
- Ensure the kubeconfig is valid: `pulumi stack output kubeconfig`

## Learn More

- [Pulumi Documentation](https://www.pulumi.com/docs/)
- [DigitalOcean Kubernetes](https://docs.digitalocean.com/products/kubernetes/)
- [Pulumi ESC](https://www.pulumi.com/docs/esc/)
- [Prometheus Operator](https://prometheus-operator.dev/)
