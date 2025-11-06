# DigitalOcean Kubernetes Cluster with Monitoring

A production-ready Pulumi template for deploying a DigitalOcean Kubernetes cluster with comprehensive monitoring tools.

## What This Template Deploys

This template creates:

- **DigitalOcean Kubernetes Cluster**: A managed Kubernetes cluster with configurable region, version, and node specifications
- **Pulumi ESC Environment**: Automatically configured environment for easy cluster access
- **Monitoring Stack**:
  - **metrics-server**: For resource metrics collection
  - **Prometheus Stack**: Complete monitoring solution with Grafana
  - **podinfo**: Sample application with service monitoring enabled

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- [Node.js](https://nodejs.org/) (v18 or later)
- [DigitalOcean Account](https://www.digitalocean.com/)
- DigitalOcean API token configured (via Pulumi ESC or environment variable)

## Configuration Options

The template supports the following configuration parameters:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `clusterRegion` | DigitalOcean region for the cluster | `fra1` |
| `nodeCount` | Number of nodes in the default pool | `1` |
| `kubernetesVersion` | Kubernetes version | `1.33.1-do.5` |
| `nodeSize` | DigitalOcean droplet size | `s-4vcpu-8gb` |
| `escProject` | Pulumi project for ESC environment | `gitops-promotion-tools` |
| `escAuthEnvironment` | ESC environment for authentication | `pulumi-idp/auth` |

## Usage

### Creating a New Project from This Template

If this template is published to the Pulumi Registry:

```bash
pulumi new <template-name>
```

### Using from VCS

```bash
pulumi new https://github.com/dirien/pulumi-ai-workshop-base/tree/main/template
```

### Customizing Configuration

After creating your project, customize the configuration:

```bash
# Set cluster region
pulumi config set clusterRegion nyc1

# Set node count
pulumi config set nodeCount 3

# Set Kubernetes version
pulumi config set kubernetesVersion 1.33.1-do.5

# Set node size
pulumi config set nodeSize s-8vcpu-16gb
```

### Deploying

```bash
# Install dependencies
npm install

# Preview changes
pulumi preview

# Deploy the infrastructure
pulumi up
```

### Accessing Your Cluster

After deployment, use the Pulumi ESC environment to access your cluster:

```bash
# Connect with kubectl
pulumi env run <esc-project>/<cluster-name> -i -- kubectl get nodes

# Or use k9s for interactive management
pulumi env run <esc-project>/<cluster-name> -i -- k9s
```

## Outputs

The template exports the following outputs:

- `name`: The cluster name
- `kubeconfig`: The kubeconfig for direct cluster access
- `envrionmentResourceName`: The ESC environment name
- `usage`: Instructions for connecting to your cluster

## Monitoring

Access the monitoring tools:

1. **Prometheus**: Port-forward to access the Prometheus UI
   ```bash
   kubectl port-forward -n monitoring svc/kube-prometheus-stack-prometheus 9090:9090
   ```

2. **Grafana**: Port-forward to access Grafana dashboards
   ```bash
   kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
   ```
   Default credentials: admin/prom-operator

3. **Podinfo**: Sample application with metrics
   ```bash
   kubectl port-forward svc/podinfo 9898:9898
   ```

## Cleanup

To destroy all resources:

```bash
pulumi destroy
```

## Learn More

- [Pulumi Documentation](https://www.pulumi.com/docs/)
- [DigitalOcean Kubernetes](https://www.pulumi.com/registry/packages/digitalocean/api-docs/kubernetescluster/)
- [Pulumi ESC](https://www.pulumi.com/docs/esc/)
